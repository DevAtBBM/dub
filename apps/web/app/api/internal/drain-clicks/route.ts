/**
 * POST /api/internal/drain-clicks — deliver recorded clicks to AffGo.
 *
 * Upstream's link.clicked sender lives under `(ee)`, is commercially licensed,
 * and was removed when this fork was created. This replaces it and is written
 * independently against the AGPL producer side; the removed handler was not
 * consulted and must not be consulted when maintaining this.
 *
 * The producer already does the hard part: `lib/tinybird/record-click.ts`
 * publishes full click data to the `workspace:click:events` stream through
 * `publishWorkspaceClickEvent`. This route drains that stream and forwards each
 * click to AffGo's /api/webhooks/link-service.
 *
 * Publishing is gated — `publishWorkspaceClickEvent` only writes for workspaces
 * present in the Redis set `linkClickedWebhookWorkspaces`, a set the removed
 * (ee) dashboard used to populate. If this route reports zero forever, check
 * that first:
 *
 *   SADD linkClickedWebhookWorkspaces <workspaceId>
 *
 * Runs on a schedule (Coolify scheduled task), guarded by CRON_SECRET.
 */

import { createHmac } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/upstash";

export const dynamic = "force-dynamic";

const STREAM_KEY = "workspace:click:events";
const GROUP = "affgo-forwarder";
const CONSUMER = "drain-clicks";
const MAX_PER_RUN = 200;

/**
 * AffGo's inbound scheme: `t=<unix>,v1=<hmac-sha256 of "<t>.<body>">`.
 * It rejects signatures older than five minutes, so sign at the moment of
 * sending rather than when the entry was read.
 */
function sign(body: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * Map a stream entry onto AffGo's payload.
 *
 * The stream carries the Tinybird click schema — snake_case, booleans as 0/1 —
 * so a translation is needed rather than forwarding the entry as-is. AffGo
 * requires only clickId and linkServiceId; the rest is enrichment it stores
 * when present.
 */
function toAffgoPayload(entry: Record<string, string>) {
  return {
    clickId: entry.click_id,
    linkServiceId: entry.link_id,
    timestamp: entry.timestamp || undefined,
    isBot: entry.bot === "1" || entry.bot === "true",
    ip: entry.ip || undefined,
    userAgent: entry.ua || undefined,
    country: entry.country || undefined,
    region: entry.region || undefined,
    device: entry.device || undefined,
    os: entry.os || undefined,
    browser: entry.browser || undefined,
    referer: entry.referer_url || entry.referer || undefined,
  };
}

/**
 * Flatten the client's reply into [id, fields] pairs.
 *
 * Verified against @upstash/redis 1.38 through the local REST shim, which
 * answers [[streamKey, [[id, [field, value, …]], …]], …] and `null` when the
 * group has nothing pending. Values arrive variously typed, hence String().
 */
function parseEntries(raw: unknown): Array<[string, Record<string, string>]> {
  const out: Array<[string, Record<string, string>]> = [];
  if (!Array.isArray(raw)) return out;

  for (const stream of raw) {
    const rows = Array.isArray(stream) ? stream[1] : undefined;
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const [id, flat] = row as [unknown, unknown];
      if (!Array.isArray(flat)) continue;

      const fields: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) {
        fields[String(flat[i])] = String(flat[i + 1]);
      }
      out.push([String(id), fields]);
    }
  }

  return out;
}

/** Create the consumer group, tolerating a first run with no stream yet. */
async function ensureGroup(): Promise<void> {
  try {
    await redis.xgroup(STREAM_KEY, {
      type: "CREATE",
      group: GROUP,
      id: "0",
      options: { MKSTREAM: true },
    });
  } catch (err) {
    // BUSYGROUP simply means a previous run already created it.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("BUSYGROUP")) throw err;
  }
}

export async function POST(request: NextRequest) {
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const affgoUrl = process.env.AFFGO_WEBHOOK_URL;
  const secret = process.env.LINK_SERVICE_WEBHOOK_SECRET;
  if (!affgoUrl || !secret) {
    // Refuse rather than drain into nowhere: an acknowledged click that never
    // arrived is gone for good.
    console.error("[drain-clicks] AFFGO_WEBHOOK_URL or secret missing");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }

  await ensureGroup();

  const entries = parseEntries(
    await redis.xreadgroup(GROUP, CONSUMER, STREAM_KEY, ">", {
      count: MAX_PER_RUN,
    }),
  );

  if (entries.length === 0) {
    return NextResponse.json({ ok: true, forwarded: 0 });
  }

  let forwarded = 0;
  let failed = 0;

  for (const [id, fields] of entries) {
    const payload = toAffgoPayload(fields);

    // Without the two load-bearing ids the entry can never be delivered, so
    // acknowledge it instead of retrying it forever.
    if (!payload.clickId || !payload.linkServiceId) {
      console.warn(`[drain-clicks] entry ${id} lacks click/link id, dropping`);
      await redis.xack(STREAM_KEY, GROUP, [id]);
      continue;
    }

    const body = JSON.stringify(payload);

    try {
      const res = await fetch(affgoUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-affgo-signature": sign(body, secret),
        },
        body,
      });

      if (res.ok) {
        // Acknowledge only on success. An unacknowledged entry stays pending
        // and is redelivered; AffGo keys clicks on their id, so a repeat is a
        // no-op rather than a duplicate.
        await redis.xack(STREAM_KEY, GROUP, [id]);
        forwarded++;
      } else {
        failed++;
        console.error(
          `[drain-clicks] AffGo rejected ${payload.clickId}: ${res.status}`,
        );
      }
    } catch (err) {
      failed++;
      console.error(`[drain-clicks] delivery failed for ${payload.clickId}:`, err);
    }
  }

  return NextResponse.json({ ok: true, forwarded, failed });
}

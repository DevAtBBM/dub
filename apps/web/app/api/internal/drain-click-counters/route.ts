/**
 * POST /api/internal/drain-click-counters — keep click counters current.
 *
 * `record-click` publishes to two streams. The other one, workspace:click:events,
 * feeds AffGo via drain-clicks. This one, link:click:events, exists purely to
 * move counters, and upstream's consumer for it lived under `(ee)` and went
 * with the rest. Without a replacement `Link.clicks`, `Link.lastClicked` and
 * `Project.totalClicks` never move, so the dashboard reads zero forever.
 *
 * Written independently against the AGPL producer; the removed handler was not
 * consulted.
 *
 * Deliberately separate from drain-clicks. Counters maintained here travel a
 * different path from the clicks delivered to AffGo, which is what lets AffGo's
 * reconciliation (FR-CLK-04) compare two independent numbers rather than one
 * number against itself.
 *
 * Runs on a schedule, guarded by CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/upstash";

export const dynamic = "force-dynamic";

const STREAM_KEY = "link:click:events";
const GROUP = "counter-updater";
const CONSUMER = "drain-click-counters";
const MAX_PER_RUN = 500;

async function ensureGroup(): Promise<void> {
  try {
    await redis.xgroup(STREAM_KEY, {
      type: "CREATE",
      group: GROUP,
      id: "0",
      options: { MKSTREAM: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("BUSYGROUP")) throw err;
  }
}

/** Flatten [[key,[[id,[f,v,…]],…]],…]; null when nothing is pending. */
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

export async function POST(request: NextRequest) {
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await ensureGroup();

  const entries = parseEntries(
    await redis.xreadgroup(GROUP, CONSUMER, STREAM_KEY, ">", {
      count: MAX_PER_RUN,
    }),
  );

  if (entries.length === 0) {
    return NextResponse.json({ ok: true, links: 0, clicks: 0 });
  }

  // Aggregate before writing: a busy link produces many entries per run, and
  // one increment of N is both cheaper and less lock-contended than N of one.
  const byLink = new Map<string, { count: number; last: string }>();
  const byWorkspace = new Map<string, number>();
  const ids: string[] = [];

  for (const [id, fields] of entries) {
    ids.push(id);
    if (!fields.linkId) continue;

    const link = byLink.get(fields.linkId);
    if (link) {
      link.count++;
      if (fields.timestamp > link.last) link.last = fields.timestamp;
    } else {
      byLink.set(fields.linkId, { count: 1, last: fields.timestamp ?? "" });
    }

    if (fields.workspaceId) {
      byWorkspace.set(
        fields.workspaceId,
        (byWorkspace.get(fields.workspaceId) ?? 0) + 1,
      );
    }
  }

  let clicks = 0;

  for (const [linkId, { count, last }] of byLink) {
    try {
      await prisma.link.update({
        where: { id: linkId },
        data: {
          clicks: { increment: count },
          ...(last ? { lastClicked: new Date(last) } : {}),
        },
      });
      clicks += count;
    } catch (err) {
      // A deleted link is not worth retrying forever; anything else is logged
      // and the entry still acked, since counters are advisory and a stuck
      // consumer group would block the whole stream.
      console.error(`[drain-click-counters] link ${linkId} not updated:`, err);
    }
  }

  for (const [workspaceId, count] of byWorkspace) {
    try {
      await prisma.project.update({
        where: { id: workspaceId },
        data: { totalClicks: { increment: count }, usage: { increment: count } },
      });
    } catch (err) {
      console.error(
        `[drain-click-counters] workspace ${workspaceId} not updated:`,
        err,
      );
    }
  }

  // Counters are advisory: acknowledge everything read, so a persistently bad
  // row cannot wedge the stream. Clicks themselves are delivered by
  // drain-clicks, which does retry.
  if (ids.length > 0) {
    await redis.xack(STREAM_KEY, GROUP, ids);
  }

  return NextResponse.json({ ok: true, links: byLink.size, clicks });
}

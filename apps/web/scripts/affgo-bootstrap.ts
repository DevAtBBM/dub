/**
 * AffGo: provision the one workspace AffGo mints links into.
 *
 * Replaces the dashboard onboarding this deployment does not expose. Safe to
 * re-run: the user, workspace and domain are upserted, and an API key is only
 * issued when the workspace has none (or `--new-key` is passed).
 *
 *   AFFGO_SHORT_DOMAIN=stage-go.affgo.io \
 *   AFFGO_OWNER_EMAIL=ops@affgo.io \
 *   pnpm script affgo-bootstrap [--new-key]
 *
 * Prints the API key once — it is stored only as a hash. Put it in AffGo's
 * LINK_SERVICE_API_KEY and set LINK_DEFAULT_DOMAIN to the short domain.
 */
import { createId } from "@/lib/api/create-id";
import { hashToken } from "@/lib/auth/hash-token";
import { prisma } from "@/lib/prisma";
import { clickWebhookWorkspaces } from "@/lib/webhook/click-webhook-workspaces";
import { randomBytes } from "crypto";
import "dotenv-flow/config";

const WORKSPACE_SLUG = process.env.AFFGO_WORKSPACE_SLUG || "affgo";
const SHORT_DOMAIN = process.env.AFFGO_SHORT_DOMAIN;
const OWNER_EMAIL = process.env.AFFGO_OWNER_EMAIL;

// Conversion tracking (`trackConversion`, which is what appends `dub_id`) is
// gated off the free and pro plans, and AffGo sets it on every link.
const PLAN = "business";
const LIMIT = 1_000_000_000;

async function main() {
  if (!SHORT_DOMAIN || !OWNER_EMAIL) {
    throw new Error("Set AFFGO_SHORT_DOMAIN and AFFGO_OWNER_EMAIL.");
  }

  const user = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: {},
    create: { id: createId({ prefix: "user_" }), email: OWNER_EMAIL, name: "AffGo" },
  });

  const limits = { plan: PLAN, usageLimit: LIMIT, linksLimit: LIMIT, domainsLimit: 10 };
  const workspace = await prisma.project.upsert({
    where: { slug: WORKSPACE_SLUG },
    update: limits,
    create: {
      id: createId({ prefix: "ws_" }),
      name: "AffGo",
      slug: WORKSPACE_SLUG,
      billingCycleStart: 1,
      ...limits,
    },
  });

  await prisma.projectUsers.upsert({
    where: { userId_projectId: { userId: user.id, projectId: workspace.id } },
    update: { role: "owner" },
    create: { userId: user.id, projectId: workspace.id, role: "owner" },
  });

  await prisma.domain.upsert({
    where: { slug: SHORT_DOMAIN },
    update: { projectId: workspace.id, verified: true, primary: true },
    create: {
      id: createId({ prefix: "dom_" }),
      slug: SHORT_DOMAIN,
      projectId: workspace.id,
      verified: true,
      primary: true,
    },
  });

  // The click stream only carries workspaces in this set; its dashboard
  // toggle went with the enterprise code. Without it no click reaches AffGo.
  await clickWebhookWorkspaces.add(workspace.id);

  const existingKeys = await prisma.restrictedToken.count({
    where: { projectId: workspace.id },
  });
  let apiKey: string | null = null;
  if (existingKeys === 0 || process.argv.includes("--new-key")) {
    apiKey = `dub_${randomBytes(24).toString("base64url")}`;
    await prisma.restrictedToken.create({
      data: {
        name: "AffGo",
        hashedKey: await hashToken(apiKey),
        partialKey: `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`,
        scopes: "links.read links.write",
        userId: user.id,
        projectId: workspace.id,
      },
    });
  }

  console.log(`workspace   ${workspace.id} (${workspace.slug}, plan ${PLAN})`);
  console.log(`domain      ${SHORT_DOMAIN}`);
  console.log(`click feed  enabled`);
  console.log(
    apiKey
      ? `api key     ${apiKey}   <- shown once; set as AffGo LINK_SERVICE_API_KEY`
      : `api key     unchanged (${existingKeys} existing; pass --new-key to issue another)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

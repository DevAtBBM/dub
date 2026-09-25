# AffGo link-service image — self-hosted build of this AGPL fork.
#
# Upstream deploys to Vercel and ships no image. Only the `web` app is built,
# with the workspace packages it depends on (`@dub/ui`, `@dub/utils`, ...).
# Backing services (MySQL + ps-http-sim, Redis + serverless-redis-http) run as
# separate containers; see NOTICE and AffGo's docs/ops/coolify-deploy.md.

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The web app's own build script generates the Prisma client first. Upstream's
# build is large; give Node room so it does not die mid-build.
ENV NODE_OPTIONS=--max-old-space-size=8192 NEXT_TELEMETRY_DISABLED=1
# `next build` imports every route to collect page data, and some SDK clients
# are constructed at module load and throw without credentials (Upstash Vector
# does). These placeholders exist only in this build stage — the runtime stage
# starts again from `base` and gets real values from the deploy environment.
# Nothing here is inlined into the bundle: only NEXT_PUBLIC_* would be.
RUN UPSTASH_VECTOR_REST_URL=https://build-placeholder.invalid \
    UPSTASH_VECTOR_REST_TOKEN=build-placeholder \
    UPSTASH_REDIS_REST_URL=https://build-placeholder.invalid \
    UPSTASH_REDIS_REST_TOKEN=build-placeholder \
    QSTASH_TOKEN=build-placeholder \
    QSTASH_CURRENT_SIGNING_KEY=build-placeholder \
    QSTASH_NEXT_SIGNING_KEY=build-placeholder \
    pnpm turbo build --filter=web...

FROM base AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start", "-p", "3000"]

# syntax=docker/dockerfile:1
# Multi-stage: install the workspace with the frozen lockfile, then run the worker with its
# workspace packages. The workspace packages export their TypeScript sources, so the runtime
# image runs through tsx rather than a tsc build (docs/backlog/ops.md OPS-1), like the API's.
# The native pieces (onnxruntime-node for Silero, @livekit/rtc-node) are prebuilt for linux-x64;
# their build scripts are allowed through `pnpm.onlyBuiltDependencies` in the root package.json.
# The worker is an outbound WebSocket client of LiveKit Cloud: no port is exposed.
# `ca-certificates` is not in node:24-slim; Node's own fetch and WebSocket carry their roots, but
# @livekit/rtc-node's Rust engine reads the system store and otherwise fails every room join with
# "no native root CA certificates found" (seen on the first deploy, 2026-11-06).
FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/voice/package.json apps/voice/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/tools-demo/package.json packages/tools-demo/
COPY packages/tools-mail/package.json packages/tools-mail/
RUN pnpm install --frozen-lockfile --filter @va/voice...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/voice/node_modules ./apps/voice/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/integrations/node_modules ./packages/integrations/node_modules
COPY --from=deps /app/packages/tools-demo/node_modules ./packages/tools-demo/node_modules
COPY --from=deps /app/packages/tools-mail/node_modules ./packages/tools-mail/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/voice ./apps/voice
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY packages/integrations ./packages/integrations
COPY packages/tools-demo ./packages/tools-demo
COPY packages/tools-mail ./packages/tools-mail
RUN pnpm --filter @va/voice typecheck
RUN mkdir -p apps/voice/logs && chown node apps/voice/logs
USER node
WORKDIR /app/apps/voice
CMD ["node", "--import", "tsx", "src/agent.ts", "start"]

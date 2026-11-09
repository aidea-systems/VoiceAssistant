# syntax=docker/dockerfile:1
# Multi-stage: install the workspace with the frozen lockfile, then run the API with its
# workspace packages. The workspace packages export their TypeScript sources (`src/index.ts`),
# so the runtime image runs through tsx rather than a tsc build of the api alone; see
# docs/API.md → Running and docs/backlog/ops.md OPS-1.
FROM node:25-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/integrations/package.json packages/integrations/
COPY packages/tools-demo/package.json packages/tools-demo/
COPY packages/tools-mail/package.json packages/tools-mail/
RUN pnpm install --frozen-lockfile --filter @va/api...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/integrations/node_modules ./packages/integrations/node_modules
COPY --from=deps /app/packages/tools-demo/node_modules ./packages/tools-demo/node_modules
COPY --from=deps /app/packages/tools-mail/node_modules ./packages/tools-mail/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY packages/integrations ./packages/integrations
COPY packages/tools-demo ./packages/tools-demo
COPY packages/tools-mail ./packages/tools-mail
RUN pnpm --filter @va/api typecheck
EXPOSE 3000
USER node
# From the app's directory, so `tsx` (a dependency of @va/api, not of the root) resolves.
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/index.ts"]

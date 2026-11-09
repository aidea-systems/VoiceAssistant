# syntax=docker/dockerfile:1
# The PWA as a static image: the workspace is installed with the frozen lockfile, the app is
# typechecked and built with the three VITE_ variables baked in (they are build-time: the
# browser reads them from the bundle, so one image serves one backend), then served by nginx
# with the SPA fallback and the caching rules in nginx.conf. HTTPS, which the service worker
# needs, is the host's job (a load balancer, Caddy, or the static host's own certificate).
FROM node:25-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @va/web...
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/db ./packages/db
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @va/web typecheck && pnpm --filter @va/web build

FROM nginx:1.28-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

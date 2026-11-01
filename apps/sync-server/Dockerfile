# syntax=docker/dockerfile:1
# Build context: the repository root.
#   docker build -f apps/sync-server/Dockerfile -t sync-server .
# The image never contains a config file or .env: mount the apps registry at
# runtime and point SYNC_CONFIG_PATH at it (M1).

# node:24-alpine, pinned by digest (L8). Bump deliberately:
#   docker buildx imagetools inspect node:24-alpine
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first, so dependency installation is cached separately.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/sync-server/package.json apps/sync-server/
RUN pnpm install --frozen-lockfile
# Sources only: never the repo root (M1).
COPY packages/ packages/
COPY apps/ apps/
RUN pnpm --filter @sync-system/server... build \
  && pnpm --filter @sync-system/server deploy --prod --legacy /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay owned by root, so the node user cannot modify the app.
COPY --from=build /out ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1
# Build context: the repository root.
#   docker build -f apps/reader/Dockerfile -t reader .
# The image holds the built app (dist/), the server (dist-server/) and zod,
# its only runtime dependency. Configuration comes from env variables only
# (apps/reader/README.md); never put a secret in them: the reader has none.
# Published as ghcr.io/mosherw/sync-system-reader and
# docker.io/moshewin/sync-system-reader by hand (ADR 0023, RELEASING.md
# "Reader image release").

# node:24-alpine, pinned by digest (same as the sync server). Bump deliberately:
#   docker buildx imagetools inspect node:24-alpine
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first, so dependency installation is cached separately.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY packages/react/package.json packages/react/
COPY apps/reader/package.json apps/reader/
# Manifest only: pnpm deploy resolves the whole workspace graph (the client
# has a dev dependency on the server); no server source enters the image.
COPY apps/sync-server/package.json apps/sync-server/
RUN pnpm install --frozen-lockfile
# Sources only: never the repo root.
COPY packages/ packages/
COPY apps/reader/ apps/reader/
# vite build validates every bundled book (AC38); tsc builds the server.
RUN pnpm --filter @mosherw/sync-system-reader build \
  && pnpm --filter @mosherw/sync-system-reader deploy --prod --legacy /out

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay owned by root, so the node user cannot modify the app. No
# source maps (Vite default) and no Vite in the image: only what runs.
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/dist-server ./dist-server
# The license text, one file only (never a directory or the context root).
COPY LICENSE ./LICENSE
# Static OCI labels (ADR 0017, ADR 0023). A release adds only .version and
# .revision with --label at build time; no credential is ever a build ARG or ENV.
LABEL org.opencontainers.image.source="https://github.com/MosheRW/sync-system" \
  org.opencontainers.image.licenses="GPL-3.0-only" \
  org.opencontainers.image.title="sync-system-reader" \
  org.opencontainers.image.description="Reading app: renders JSON content with RTL, LTR and mixed-direction text, and fingerprints it for group sync."
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/server/main.js"]

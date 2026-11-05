# 0001. Reading app framework, location and serving

- Status: Proposed
- Date: 2026-11-05
- Issue: #19

## Context

The reading app (PRD product 1) does not exist yet. It must:

- render JSON content entirely in the browser (Web Crypto fingerprint,
  swipe/keyboard navigation, live region), with no server-side data;
- integrate with the sync stack only through the workspace packages
  (`@sync-system/react`, `@sync-system/client`), AC19;
- be "its own Docker service" (PRD, Deliverables 4), self-hostable and
  configured by env variables;
- reject invalid configuration at startup, not at runtime (AC30, AC41);
- send security headers (a strict CSP is the main defence for fetched,
  untrusted content, see 0006).

The repo is a pnpm monorepo: `packages/*` are libraries, `apps/*` are
deployables. React 19.3, Vitest 4 (on Vite 8), jsdom and Testing Library are
already in the lockfile (via `packages/react`).

## Options

1. **React 19 + Vite SPA in `apps/reader`, served by a minimal Node static
   server in its own image (recommended).**
   - Pros: the content pipeline is client-only anyway; Vite 8 is already in the
     lockfile (Vitest uses it), so the only new direct dev dependency is `vite`
     itself; static output is small and cacheable. A small `node:http` server
     (no framework, no new runtime dependency) validates env config at startup
     (AC30), injects the public config into `index.html`, sets the CSP and
     other headers, and serves only files that exist in the build (an
     in-memory allow-list built at startup, so no path traversal is possible).
   - Cons: we own a small server (tests needed); no SSR, so the reading app
     does not exercise the React package's SSR safety (its own tests already
     do, `packages/react/test/ssr.node.test.tsx`).
2. **Next.js (App Router) in `apps/reader`.**
   - Pros: runtime env and headers built in; demonstrates the React package
     under SSR as the "working example" (PRD).
   - Cons: large new dependency tree (audit surface, upgrade churn); every
     content module needs client-only boundaries (Web Crypto, DOM); SSR brings
     nothing for client-fetched content; heavier image.
3. **Vite SPA served by nginx, config at build time (`VITE_*`).**
   - Pros: no server code of ours.
   - Cons: changing config means rebuilding the image; validation runs at
     build, not at container start; a per-deployment CSP needs templating; a
     second base image to pin and patch.

Docker service timing:

- a. **In item 7 (recommended)**: `apps/reader/Dockerfile` and a `reader`
  service in `compose.yaml` (loopback port 8081). The startup validation
  (AC30) and the CSP live in that server, so item 7 cannot be verified
  end to end without it.
- b. Defer to item 9: item 7 then runs only through `vite dev`/`vite preview`,
  and AC30 is checked only by the dev plugin.

## Decision

Option 1 with Docker timing a: React 19 + Vite SPA at `apps/reader`
(package `@sync-system/reader`, `private: true`), built with `vite build`,
served in production by `apps/reader/server` (plain `node:http`, Node 24),
with its own Dockerfile and compose service in this issue. Runner-up:
Next.js, if demonstrating SSR in the reading app matters more than a small
dependency and attack surface.

No `@vitejs/plugin-react`: Vite transforms TSX itself with the automatic JSX
runtime; the plugin only adds Fast Refresh in development and can be added
later as a dev-only dependency.

## Consequences

- New direct dev dependency: `vite` (^8, already in the lockfile). New direct
  dependencies of the app: `react`, `react-dom` (19.x, already in the
  lockfile), `zod` (^4.6, already used by `protocol` and `server`),
  `@sync-system/react` (workspace).
- The app is client-rendered: no SSR, so DOM access needs no guards (AC21).
- The Node server stays minimal and is covered by tests (headers, 404,
  methods, config injection, startup errors).
- A second image built from the same pinned `node:24-alpine` digest as the
  sync server.

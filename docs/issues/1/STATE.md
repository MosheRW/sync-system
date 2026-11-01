# State: #1 Sync server core and monorepo scaffold
- Path: full
- Phase: implementation
- Branch: feat/1-sync-server-core
- PR: #2
- Plan approved by user: yes
- QA loops: 0
- Last updated by: engineer

## Gate 1
- Gate 1 approved by user with edits (spec updated: AC27 max message size, AC28 CI workflow; open questions resolved).

## Intake decisions (user)
- TypeScript monorepo, pnpm workspaces (confirmed at Gate 1); Node sync server over WebSockets (ws or Socket.IO, architect decides); Vitest; Docker Compose.
- Later packages: framework-free TS core client, React/Next package, Next.js reading app.
- PRD split into 9 issues worked in order; this is #1. Temporary join by group ID (join methods A-D are issue 4).

## Gate 1 decisions (user)
- Defaults/ceilings accepted: group size 30 / 100 (leader counts); leader updates 5/s / 10/s; max message size 4 KB app default, env ceiling MAX_MESSAGE_SIZE_CEILING 16 KB (block list in #3 gets its own separate limit).
- #5 timers recorded: grace 30 s / 120 s, inactivity 20 min / 60 min, keep-alive countdown 60 s / 120 s, max session 3 h / 8 h. Lock tolerance 30 s confirmed.
- Over-ceiling app value = startup error (no clamping).
- App versions and minimum app version are semver.
- Leader disconnect in #1 ends the group with a "group ended" event.
- Over-rate leader updates are rejected, not coalesced.
- Add CI workflow (push + pull_request: frozen-lockfile install, lint, typecheck, test, build).

## Architecture
- Plan: docs/issues/1/architecture.md (ws chosen over Socket.IO; packages/protocol + apps/sync-server).
- Rev 2: all security findings folded in (H1-H4, M1-M6, L1-L8) per user decision; mapping in architecture.md section 10; 24 planned commits.
- New defaults: MAX_CONNECTIONS 10000, MAX_PENDING_HANDSHAKES 1000, MAX_APP_CONNECTIONS_CEILING 10000 (app maxConnections default 1000), MAX_INBOUND_MESSAGES_PER_SECOND 20, MAX_INBOUND_BURST 40, MAX_BUFFERED_BYTES 1 MiB; handshake timeout 5 s; queue cap 32; JSON depth 64; apiKey 32-256 chars.

## Gate 2 decisions (user, 2026-11-01): plan approved
- Plan approved by user: yes (architecture.md rev 2, including section 10 security controls and the 24-commit list).
- Q1: a connection exceeding the inbound message limit (20/s, burst 40) is closed with 4008 TOO_MANY_MESSAGES, even if it is the leader (which ends the group). Below that, a leader over its update rate gets RATE_LIMITED and stays connected (AC22).
- Q2: JSON nesting is capped at 64 levels for the whole message; accepted refinement of AC14.
- Q3: per-app maxConnections default 1000, ceiling MAX_APP_CONNECTIONS_CEILING 10000; accepted fourth limit under AC5.
- All other new defaults in architecture.md rev 2 approved as written.

## Security (plan review)
- docs/issues/1/security.md: FAIL (0 critical, 4 high, 6 medium, 8 low) on rev 1; all required controls implemented per architecture.md rev 2 section 10.

## Implementation
- 24 planned commits pushed on feat/1-sync-server-core (see PR #2 checklist), plus this state commit.
- Checks: pnpm lint, typecheck, test (protocol 22 tests, server 317 tests), build and `pnpm audit --audit-level=high` all pass locally; CI green on the PR.
- AC25 (Docker), verified locally: `docker compose build` builds the image. The image contains no config or .env and runs as `node`. Run with the dev registry copied in (`docker cp`) and the compose healthcheck command: status `healthy`, `curl 127.0.0.1/health` returns 200 with the expected body, and the log shows the `dev api key in use` warning. With the image default `NODE_ENV=production` it prints the dev-key ConfigError and exits 1.
- AC25 not verified: `docker compose up` itself. On this machine Docker Desktop hangs on every bind mount (even a plain `docker run -v`), so the compose volume `./config/apps.dev.json:/config/apps.json:ro` could not be mounted. Needs a manual `docker compose up --build` on a machine with working bind mounts.
- Accepted audit finding: 2 moderate advisories (minimatch through eslint 9, dev-only), below the CI threshold `--audit-level=high`.

## Open questions
- none

## Deviations from plan
- Added root `.gitattributes` (`* text=auto eol=lf`). On Windows with core.autocrlf the working tree would otherwise be CRLF and fail prettier `endOfLine: lf`.
- `.prettierignore` also ignores `docs/issues` and `.claude` (agent-maintained docs and config are not prettier-formatted), not only `docs/PRD*`.
- Tool versions: TypeScript `~6.0.3` (TS 7 is the latest, but typescript-eslint 8.72 supports `<6.1`); ESLint 9 as planned (pnpm reports 9.x as out of support; ESLint 10 exists); Vitest `^4.1` (Vitest 5 needs a separate vite peer).
- Extra small files: `src/limits/constants.ts` (the fixed limits), `src/ws/error-messages.ts` (fixed error text per code, so cross-app and unknown-ID errors are byte-identical), `src/groups/session.ts` (`Session`/`GroupActions` interfaces between the connection and group layers). Extra test helpers: `log-capture.ts`, `wait.ts`, `groups.ts`, `failing-store.ts`, plus `test/setup.ts` (unhandled-rejection hook) and `test/raw-client.test.ts`.
- Protocol: added `MAX_APP_VERSION_INPUT_LENGTH = 256`. The hello schema bounds `appVersion` at 256, and the handshake returns `INVALID_APP_VERSION` for more than 64 chars before semver parsing. This satisfies both "bounded before semver" (L2) and "65 chars gives INVALID_APP_VERSION" (test plan). `apiKey` is optional in the hello schema so a missing key gives `INVALID_API_KEY` (AC7).
- Protocol also exports server-message schemas (`serverMessageSchema`, `parseServerMessage`) for the client in #2.
- Heartbeat: each ping carries a random 8-byte payload and a pong counts only if it echoes the outstanding ping's payload. This is stricter than "a pong counts only while a ping is outstanding", so unsolicited pongs cannot keep a socket alive.
- When a flood is detected, frames already queued from that socket are dropped, not processed (the connection is closing).
- `server.close()` sends close 1001 to every client, waits up to 1 s, then terminates the rest.
- Server `package.json` has `files: ["dist"]`, so `pnpm deploy` ships only the build output into the image.
- Test placement: `test/helpers/test-server.ts` landed in commit 10 (not 5) because it needs `createSyncServer`. The queue-overflow test landed in commit 14 (needs store injection), and the NOT_LEADER/random-join flood test in commit 15. The AC24 privacy test landed in commit 21, whose message became `test(server): add malformed frame, robustness and log privacy tests`.
- Intermediate commits had temporary gaps that later commits closed: commits 12-13 answered group actions with INTERNAL_ERROR (not wired yet); commit 14 had no position updates yet and no group size limit (until 18); leader disconnect ended the group only from commit 17.

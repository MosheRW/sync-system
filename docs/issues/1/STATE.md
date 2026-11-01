# State: #1 Sync server core and monorepo scaffold
- Path: full
- Phase: validation
- Branch: feat/1-sync-server-core
- PR: #2
- Plan approved by user: yes
- QA loops: 2
- Last updated by: qa

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

## QA (round 1)
- Verdict: PASS (review comment on PR #2). Checks: install, lint, typecheck, test (22 + 317), build all pass; CI 2/2 green.
- ACs: 27/28 met; AC25 partly verified: image builds, container from image is healthy with the compose healthcheck (config via docker cp); `docker compose up` hangs on Docker Desktop bind mounts here. Needs a manual `docker compose up --build` check by the user before merge.
- Gate 2 Q1-Q3 implemented as decided; all engineer deviations judged acceptable.

## Fixes (PR #2 review: Copilot findings 1-4, security advisories S1-S4)
- User enabled Auto-fix on PR #2 and later asked to fix S1-S4 in this PR too. One commit per finding, each with regression tests:
  - Copilot 1 (dev script resolved protocol from dist): 43a4401 fix(server): resolve protocol from source in the dev script. Verified `pnpm --filter @sync-system/server dev` starts and serves /health with packages/protocol/dist removed.
  - Copilot 3 (stray participant if get failed after addParticipant): 3dccd7b fix(server): add a participant and snapshot the group atomically.
  - Copilot 2 (join committing to a group torn down meanwhile): 7d818cf fix(server): serialize join and group teardown per group.
  - Copilot 4 (ping/pong bypassed the inbound limiter and the outbound buffer check): 2b43041 fix(server): rate-limit ping and pong frames and buffer-check pongs.
  - S1: 3e3fc8d fix(server): drop unresponsive closing sockets after 2 s.
  - S2: f6a8bd9 fix(config): lower the default outbound buffer limit to 256 KiB.
  - S3: eda6fed fix(docker): ignore env files and app registries at any depth.
  - S4: 7211db9 fix(config): refuse the dev key unless NODE_ENV is development or test.
- Checks: pnpm lint, typecheck, test (protocol 22, server 343), build pass; pnpm audit --audit-level=high passes (2 moderate dev-only, accepted).
- Needs a QA re-run (round 2).

## QA (round 2)
- Verdict: PASS (review comment on PR #2). Reviewed head 5153780 (product code); 4c15041 adds only the security re-review doc.
- Checks: install --frozen-lockfile, lint, typecheck, test (protocol 22, server 343), build all pass; `docker compose build` passes; CI 2/2 green on 5153780.
- All 8 fixes verified with their regression tests (Copilot 1-4, S1-S4). S4 also checked in the container: NODE_ENV=staging exits 1 with the dev-key ConfigError, NODE_ENV=development warns and listens. README and compose.yaml match (NODE_ENV, MAX_BUFFERED_BYTES 262144).
- ACs: 27/28 met, no regressions; Gate 2 Q1-Q3 unchanged. AC25 partly verified: Docker bind mounts still hang here, so the user needs to run `docker compose up --build` once before merge.

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
- Review fixes: `GroupStore.addParticipant` now returns `{ status: 'ok', group } | { status: 'not_found' } | { status: 'full' }` (internal store interface, not the wire protocol), so join no longer calls `get`.
- Review fixes: new `src/groups/keyed-lock.ts` (per-group async mutex for join, leader teardown and member removal) and `Session.afterPending`, so group.ended is delivered through each member's own message queue (after the replies to messages it already sent; a member whose join was in flight gets group.joined, then group.ended).
- Review fixes: ws `autoPong: false`; `Connection` answers pings with `sendPong` (src/ws/send.ts), which skips the pong if the buffer is at the limit or the pong would push it over.
- Review fixes: `closeTimeout` is not in @types/ws 8.18.1, so the server options are typed as `ServerOptions & { closeTimeout: number }`; `CLOSE_TIMEOUT_MS = 2_000` in limits/constants.ts. compose.yaml MAX_BUFFERED_BYTES set to the new 262144 default.
- Review fixes: test helpers: RawClient records server pongs and can ignore close frames; vitest.config sets NODE_ENV=test.

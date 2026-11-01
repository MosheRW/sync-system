# State: #1 Sync server core and monorepo scaffold
- Path: full
- Phase: architecture
- Branch: feat/1-sync-server-core
- PR: #2
- Plan approved by user: no
- QA loops: 0
- Last updated by: architect

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
- Awaiting Gate 2 approval.

## Security (plan review)
- docs/issues/1/security.md: FAIL (0 critical, 4 high, 6 medium, 8 low).
- Blocking (all DoS/availability): H1 no connection / pending-handshake caps; H2 no outbound backpressure (slow readers); H3 no per-connection inbound limit, unbounded queue; H4 ws error listeners / unhandled rejections can crash the process.
- Architect must add the required controls (security.md section 4) before Gate 2.

## Open questions
- Q1: close flooding connections (incl. leaders, which ends the group) with 4008 / TOO_MANY_MESSAGES? (architecture.md section 12)
- Q2: JSON depth cap 64 acceptable vs AC14 "arbitrary" payloads?
- Q3: confirm per-app maxConnections defaults (app 1000, ceiling 10000) widening AC5's list.

## Deviations from plan
- none

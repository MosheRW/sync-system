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
- Plan: docs/issues/1/architecture.md (ws chosen over Socket.IO; packages/protocol + apps/sync-server; 19 planned commits).
- Awaiting Gate 2 approval.

## Open questions
- none

## Deviations from plan
- none

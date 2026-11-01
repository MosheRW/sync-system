# State: #1 Sync server core and monorepo scaffold
- Path: full
- Phase: grooming
- Branch: feat/1-sync-server-core
- PR: none
- Plan approved by user: no
- QA loops: 0
- Last updated by: pm

## Gate 1
- Gate 1 approved by user with edits (spec updated: AC27 max message size, AC28 CI workflow; open questions resolved).

## Intake decisions (user)
- TypeScript monorepo, pnpm workspaces (confirmed at Gate 1); Node sync server over WebSockets (ws or Socket.IO, architect decides); Vitest; Docker Compose.
- Later packages: framework-free TS core client, React/Next package, Next.js reading app.
- PRD split into 9 issues worked in order; this is #1. Temporary join by group ID (join methods A-D are issue 4).

## Gate 1 decisions (user)
- Defaults/ceilings accepted: group size 30 / 100 (leader counts); leader updates 5/s / 10/s; max message size 16 KB app default with env ceiling.
- #5 timers recorded: grace 30 s / 120 s, inactivity 20 min / 60 min, keep-alive countdown 60 s / 120 s, max session 3 h / 8 h. Lock tolerance 30 s confirmed.
- Over-ceiling app value = startup error (no clamping).
- App versions and minimum app version are semver.
- Leader disconnect in #1 ends the group with a "group ended" event.
- Over-rate leader updates are rejected, not coalesced.
- Add CI workflow (push + pull_request: frozen-lockfile install, lint, typecheck, test, build).

## Open questions
- Max message size env ceiling default not specified by user; proposed 64 KB (working value).

## Deviations from plan
- none

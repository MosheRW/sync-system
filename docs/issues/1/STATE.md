# State: #1 Sync server core and monorepo scaffold
- Path: full
- Phase: grooming
- Branch: feat/1-sync-server-core
- PR: none
- Plan approved by user: no
- QA loops: 0
- Last updated by: pm

## Intake decisions (user)
- TypeScript monorepo, pnpm workspaces; Node sync server over WebSockets (ws or Socket.IO, architect decides); Vitest; Docker Compose.
- Later packages: framework-free TS core client, React/Next package, Next.js reading app.
- PRD split into 9 issues worked in order; this is #1. Temporary join by group ID (join methods A-D are issue 4).
- Lock tolerance working assumption: 30 seconds.

## Open questions
- Confirm defaults/ceilings: group size 30 / 100, leader update rate 5/s / 10/s; timer proposals for issue 5 (grace 30 s / 120 s, inactivity 20 min / 60 min, keep-alive countdown 60 s / 120 s, max session 3 h / 8 h).
- Confirm 30 s lock tolerance.
- Over-ceiling app values: fail at startup (proposed) or clamp with warning?
- Is semver required for app versions?
- Leader disconnect in #1: end group and notify members (proposed) or keep until empty?
- Over-rate leader updates: reject with error (proposed) or coalesce?
- Add a max message size with env ceiling (proposed 16 KB) in #1?
- Add CI workflow in #1 or defer?

## Deviations from plan
- none

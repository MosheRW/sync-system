# State: #35 feat: redis storage with restart survival and several instances (PRD item 9a)
- Path: full
- Phase: grooming
- Branch: feat/35-redis-docs-release
- PR: none
- Spec approved at Gate 1: yes (2026-11-12, with the edits below)
- Gate 1 decisions (2026-11-12): all recommended defaults accepted except Q1, Q3, Q4 and Q13.
  - Q1: user's 3-way split: 9a #35 = all Redis storage (restart survival, server-side block lists, several instances; AC1-AC32; the architect may plan it as two PRs on this issue), 9b #36 = health, readiness and config errors (AC33-AC42), 9c #37 = docs, changelog, release (AC43-AC56). Order 9a, 9b, 9c.
  - Q3: license GPL-3.0, SPDX `GPL-3.0-only` (keeps future terms under the owner's control); the user may relicense to MIT later, simple only while sole copyright holder.
  - Q4: publish under the user's npm scope `@mosherw` (`@mosherw/sync-system`), not `@sync-system`; exact package names, image registry and repo visibility are open for 9c's Gate 1.
  - Q13: Markdown in the repo and a GitHub wiki; source of truth and wiki publishing are open for 9c's Gate 1.
  - Q8 moot (no single-instance guard; AC6 now requires several instances). Redis config errors and startup errors (AC3, AC4) stay in 9a.
- Plan approved by user: no
- Security-sensitive: yes (expected: new runtime dependency, Redis credentials, names of possible minors in Redis, cross-instance concurrency; the architect confirms)
- Review rounds: 0
- Last updated by: pm
## Model log
- pm groom: opus (orchestrator: broad scope and split proposal) → DONE
- pm update-spec (Gate 1 decisions): opus (orchestrator: split restructure and new issues) → DONE
## Open questions
- 9a: none (implementation choices to the architect; Redis client ADR at Gate 2).
- 9b (#36): Q20 for its own Gate 1. 9c (#37): Q16-Q19 for its own Gate 1. See spec.md.
## Deviations from plan
- none

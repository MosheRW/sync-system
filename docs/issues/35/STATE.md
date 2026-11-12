# State: #35 feat: redis storage with restart survival and several instances (PRD item 9a)
- Path: full
- Phase: architecture
- Branch: feat/35-redis-docs-release
- PR: #38 (draft)
- Spec approved at Gate 1: yes (2026-11-12, with the edits below)
- Gate 1 decisions (2026-11-12): all recommended defaults accepted except Q1, Q3, Q4 and Q13.
  - Q1: user's 3-way split: 9a #35 = all Redis storage (restart survival, server-side block lists, several instances; AC1-AC32; the architect may plan it as two PRs on this issue), 9b #36 = health, readiness and config errors (AC33-AC42), 9c #37 = docs, changelog, release (AC43-AC56). Order 9a, 9b, 9c.
  - Q3: license GPL-3.0, SPDX `GPL-3.0-only` (keeps future terms under the owner's control); the user may relicense to MIT later, simple only while sole copyright holder.
  - Q4: publish under the user's npm scope `@mosherw` (`@mosherw/sync-system`), not `@sync-system`; exact package names, image registry and repo visibility are open for 9c's Gate 1.
  - Q13: Markdown in the repo and a GitHub wiki; source of truth and wiki publishing are open for 9c's Gate 1.
  - Follow-ups for 9c / #37 (2026-11-12): Q16 decided: three packages `@mosherw/sync-system-protocol`, `-client`, `-react`. Q19/Q13 decided: no GitHub wiki for now, docs are Markdown in the repo only (AC44 withdrawn; a wiki may be reconsidered later). Q17 (image registry) and Q18 (repo visibility) stay open for #37's Gate 1; the paid-plan/wiki argument no longer applies to Q18.
  - Q8 moot (no single-instance guard; AC6 now requires several instances). Redis config errors and startup errors (AC3, AC4) stay in 9a.
- Plan approved by user: no
- Security-sensitive: yes (confirmed by the architect: new dependency @redis/client, Redis credentials, names of possible minors in Redis, recovery fence, concurrency)
- Review rounds: 0
- Delivery: two PRs on this issue proposed (Gate 2 Q-A1): PR 1 single-instance Redis + restart survival (this branch), PR 2 several instances (branch feat/35-redis-multi-instance after PR 1 merges)
- Plan: docs/issues/35/architecture.md; ADRs 0010-0014 Proposed
- Security plan review: docs/issues/35/security.md (PASS, required controls C1-C10 join the plan)
- Last updated by: security
## Model log
- pm groom: opus (orchestrator: broad scope and split proposal) → DONE
- pm update-spec (Gate 1 decisions): opus (orchestrator: split restructure and new issues) → DONE
- architect plan: opus (default; NEXT_MODEL opus) → DONE
- pm update-spec (9c follow-up decisions): sonnet (default) → DONE
- security plan: opus (rule) → PASS (0 critical, 0 high, 9 medium, 6 low; required controls C1-C10 in docs/issues/35/security.md)
## Open questions
- 9a Gate 2: Q-A1 two PRs, Q-A2 TTL slack 5 s, Q-A3 restart grace for running pauses, Q-A4 PR 1 body Refs vs Closes, Q-A5 approvals in PR 2, Q-A6 eviction policy warning; ADRs 0010-0014 (architecture.md section 18).
- 9b (#36): Q20 for its own Gate 1. 9c (#37): Q17, Q18 for its own Gate 1 (Q16, Q19 decided). See spec.md.
## Deviations from plan
- none

# State: #35 feat: redis storage with restart survival and several instances (PRD item 9a)
- Path: full
- Phase: implementation
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
- Plan approved by user: yes (Gate 2, 2026-11-12, "Approve all")
- Gate 2 decisions (2026-11-12):
  - ADR 0010 Accepted: `@redis/client` pinned exactly 6.3.1, dynamic import only when configured; Redis 7.2+ and Valkey 7.2+, single endpoint (replaces the `redis` package named at Gate 1).
  - ADR 0011 Accepted: per-group unit of work + effect outbox (PR 1); fenced Redis lease lock in PR 2.
  - ADR 0012 Accepted (applied in PR 2): per-instance pub/sub channel + attachment registry.
  - ADR 0013 Accepted: due-time sorted set, Lua lease claim, 1 s poll, 30 s lease.
  - ADR 0014 Accepted, option 1: close with 1001, 503 on upgrades, bounded in-memory disconnect replay; no protocol change.
  - Q-A1 yes (two PRs; PR 2 on feat/35-redis-multi-instance after PR 1 merges, own plan revision and Gate 2). Q-A2 TTL = max-session deadline + 5 s. Q-A3 yes (a grace/hold running at shutdown ends no earlier than disconnectGraceSeconds after the server is back). Q-A4 yes (PR #38 body `Refs #35`). Q-A5 yes (pending method B approvals move to PR 2). Q-A6 startup warning, not error.
  - Security required controls C1-C10 (security.md) are mandatory.
  - Security advisories folded into PR 1 by the user: F10 (position in its own small key written in the same commit; document size measured at the default ceiling), F12 (P:epoch gets PEXPIRE GT like the shared keys), F13 (prune past-E members of due/live/ended sets in the timer poll and startup sweep; AC24 test for a group that expired while the server was down), F14 (README: Redis ACL user limited to the prefix, least commands), F15 (ci.yml starts Redis with `docker run` in a step, pinned digest, password, no persistence, bound to 127.0.0.1). P2-1 (commit as a Lua script) optional.
- Security-sensitive: yes (confirmed by the architect: new dependency @redis/client, Redis credentials, names of possible minors in Redis, recovery fence, concurrency)
- Review rounds: 0
- Delivery: two PRs on this issue proposed (Gate 2 Q-A1): PR 1 single-instance Redis + restart survival (this branch), PR 2 several instances (branch feat/35-redis-multi-instance after PR 1 merges)
- Plan: docs/issues/35/architecture.md; ADRs 0010-0014 Proposed
- Security plan review: docs/issues/35/security.md (PASS, required controls C1-C10 join the plan)
- Last updated by: engineer
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
- Gate 2 additions to the section 17 chunks: F10 (position key), F12 (epoch expiry), F13 (pruning), F14 (README ACL advice), F15 (CI Redis via `docker run`) are folded into the matching chunks (8, 11, 10/11, 16 and 15).

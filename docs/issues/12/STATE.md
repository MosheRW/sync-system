# State: #12 fix(server): limit group creation and live groups per app (follow-up to #10)
- Path: fast
- Phase: validation
- Branch: fix/12-limit-group-creation
- PR: #46
- Plan approved by user: yes (Gate 2, 2026-11-22; the condition, Revision 2 plus a passing security delta check, is met: round 3 PASS at 7e1a4d5)
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: qa
## Gate 2 decisions (user, 2026-11-22)
- Q-1: option A (global per-app token bucket checked with the cap, derived sustained rate).
- Q-2: env variables with the constants as defaults (overrides the fixed-constants recommendation): `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE` (6), `MAX_GROUP_CREATE_BURST_PER_APP` (120), `MAX_GROUP_CREATES_PER_APP_PER_MINUTE` (120, upper bound of the derived rate), `MAX_LIVE_GROUPS_PER_APP` (10 000); cross rule cap > 2 x burst. Names carry the `MAX_` prefix (ADR 0015 family) instead of the suggested `GROUP_` prefix; see architecture.md Q-2.1.
- Q-3: `APP_GROUP_LIMIT`, `details.maxLiveGroups` = the configured value.
- Q-4: as recommended (counted, never refused, not charged).
- Q-5: as recommended (throttled warn, namespace only).
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (default) → DONE
- security plan: opus (rule) → FAIL (H1: one instance can fill the live-group cap via leader-return keep-alive; see security.md)
- architect plan revision 1: opus (rule: revision after a failed review) → DONE (H1: global per-app token bucket with rate derived from maxSessionMinutes; M2, L1, L2, L4 folded in)
- security plan round 2: opus (rule) → PASS (H1, M3 closed; new advisories M4 app-wide flood DoS while it runs, L6-L9; required controls R1-R14 in security.md R2.4)
- architect plan amendment (revision 2): opus (rule: plan revision touching config/security) → DONE (Gate 2 decisions recorded; four MAX_ env variables with startup validation; R13/R14 adopted; new config chunk, 6 chunks)
- security plan round 3 (delta, env config): opus (rule) → PASS (H1 bound holds for every valid config; transition bound < cap confirmed; advisories L10 cap mismatch across instances, L11 large burst vs reset margin, L12 tiny refill formatting; R15 added)
- qa validation round 1: opus (NEXT_MODEL from engineer: security-sensitive, plan deviations) → PASS
## QA verdict
- Round 1: PASS (2026-11-22, head 05ea216). Checks run locally in Docker (node:24 + redis:7.2.17-alpine, private network, repo with .git copied in): lint, typecheck, test (all 5 packages, Redis suites included), build, audit all pass; only failure is the pre-existing repo-hygiene "CI workflow ... runs on push and pull_request", which fails identically on main 085700a. CI: no checks (Actions billing-blocked). AC 8/8 met. All six recorded deviations judged acceptable. Advisories A1-A4 (forgetGroup regression test, README wording, unbounded CLAIM_DUE range, #32 commits on this branch), none blocking. All 19 commits signed.
## Open questions
- Resolved at Gate 2 (2026-11-22): Q-1 to Q-5, see "Gate 2 decisions" above.
- Resolved: security.md R2.4 controls folded into the plan; M4 wording corrected in Q-1 and section 8 (R12).
- Resolved: security delta check of Revision 2 (round 3) PASS; new advisories L10-L12 and control R15 in security.md R3.5.
- To confirm (non-blocking): variable names use the `MAX_` prefix rather than `GROUP_` so ADR 0015's typo check covers them; keeping `GROUP_` would need an ADR 0015 amendment.
## Implementation (engineer, 2026-11-22)
- Chunks 1-6 done (b521671, f54ca35, 07b933c, b54ac47, 8bc5c28, 43121a6), plus cb3c44a and 140c8ad (see below). PR #46 marked ready.
- Controls: R1-R15 as amended in security.md R3.5 are in place; R13 (strictest r/b until u, Redis TIME) and R14 (integer clamps, L12 refill formatting) done; L11 burst guidance and the L10 note in the README. L10 itself not implemented (below).
- Checks: lint, typecheck, test (all packages, Redis suites against redis:7.2.17-alpine), build and `pnpm audit --audit-level=high` pass in local Docker (node:24 + Redis on a private network, repo copied in, no bind mounts). Only failure: `repo-hygiene.test.ts` "CI workflow ... runs on push and pull_request", which fails on the base branch too (the workflow triggers are commented out while Actions is billing-blocked); not touched.
## Deviations from plan
- Client README `APP_GROUP_LIMIT` row committed right after chunk 1 (cb3c44a) instead of in the docs chunk: the client README drift test requires every error code as soon as it exists.
- `RATE_LIMITED` has a `group.create` text, "Too many groups created; try later", in the server's `ACTION_ERROR_TEXT` and the client's `ACTION_MESSAGES` (shared codes need a text per action, #7 A1). Not in the plan's file table.
- `MAX_RETRY_AFTER_MS` lives in `limits/constants.ts` (chunk 4) and is re-exported by `groups/live-groups.ts`, where chunk 3 first defined it.
- Redis clocks (140c8ad): `RESERVE_LIVE` takes the caller's `now` next to `expiresAt` and uses only their difference (the group's remaining life). Scores, `u`, the prune and every TTL are in Redis TIME, instead of instance-clock scores. The bucket TTL is `max(time to full, u - now)` without the extra 1 s (it already outlives `u` and the refill). Why: #35 AC24 requires every key TTL to be at most the group's end bound, which the +1 s broke, and instance-clock scores mixed two clocks in one script. This makes L7 stronger: a skewed instance cannot shift scores either.
- `CLAIM_DUE` (due timers and the restart prune of `live`) also removes each expired `live` member from its app's `lg` set (140c8ad). Without it, a group that expired while the server was down kept its ID in Redis until the next create (#35 F13 privacy test). This touches `scripts.ts` and `timers.ts` beyond the plan's list.
- The memory store prunes expired entries only before the cap check and when counting, not on every reserve. This keeps a reserve O(1) without changing results.
- `server.ts` exports `groupCreateLimits(env, override)`, which builds the frozen limits and validates the test-only `groupLimits`. It runs first in `createSyncServer`.
- L10 (smallest recent cap and longest lifetime in the bucket) not implemented. The README "Several instances" notes instead that an instance with a lower `MAX_LIVE_GROUPS_PER_APP` can refuse every create while the others still create. Why: the store would recompute the rate from its own state and override the test-only refill, for a misconfiguration the README already forbids. security.md R3.5 allows the README note plus this entry.
- Test plan: the cap examples use cap 3 / burst 1 (the plan's "cap 2, large burst" breaks the cross rule). The `endInvalid` test seeds the `lg` set directly. No dedicated test that `forgetGroup` keeps the slot: `endGroup` is the only release site by construction. New test files: `live-groups.test.ts`, `live-groups.redis.test.ts`, `group-create-limits.int.test.ts`, `group-create-limits.redis.test.ts`.

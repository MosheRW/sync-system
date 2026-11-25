# Spec: #47 fix(storage): bound create-budget key TTL and batch expired live-group cleanup

Issue: https://github.com/MosheRW/sync-system/issues/47 (follow-up to #12 / PR #46; advisories A1, A2, QA A3). Path: fast.

## Problem
1. **Create-budget key TTL (A1, low).** In `RESERVE_LIVE` the bucket TTL is `max(time to full, u - now)`. With a burst above cap/4, the time to full can exceed the group's end bound (up to the 1e13 clamp), so `<prefix>:v1:lb:<ns>` can outlive every group of the app. This conflicts with #35 AC24 ("every key TTL <= the group's end"). The key holds counters and times only. The privacy test runs only at defaults (about 0.03 L) and misses it.
2. **Unbounded expired-slot read in `CLAIM_DUE` (A2, low; QA A3).** `ZRANGEBYSCORE live -inf (now` has no `LIMIT`. After a long outage the first claim walks every expired member (up to apps x cap) in one script call and blocks Redis.

## Acceptance criteria
- [ ] Either the `lb:<ns>` TTL never exceeds `max(u - now, L)`, with a test at a burst above cap/4, or the README/ADR documents `lb` as an app-level counter outside #35 AC24 (the chosen option is recorded in the plan).
- [ ] `CLAIM_DUE` reads and removes expired live-set members in bounded batches (`LIMIT`), and a test with more expired members than one batch shows they are all freed.
- [ ] Behavior of `RESERVE_LIVE` and `CLAIM_DUE` is otherwise unchanged (existing #12 and #35 tests pass).
- [ ] lint, typecheck, test (including the Redis suites) and build pass; no new dependencies.

## Out of scope
- Changing the rate or cap formulas from #12 (H1 bound).
- The existing O(n) `ZREMRANGEBYSCORE` prune, beyond what batching needs.
- The L10 cap-mismatch note.

## Open questions
- none (the TTL-cap vs. document-only choice is left to the architect and recorded in the plan).

# Spec: RELEASING.md lessons from the 1.0.0 release

Issue: https://github.com/MosheRW/sync-system/issues/81

## Problem
Several tests outside #47's change fail only when the machine is loaded (e.g. two test runs in parallel). Each passes 3/3 in isolation and the full suite is green on a quiet machine. On origin/main the AC24 test behaves the same way (20/20 alternating runs passed on both main and the branch when quiet). Found in QA round 1 on PR #75.

Related: #78 covers the 5 s timeouts in `main.test`, `redis-startup` and `release-files`. This issue also covers the Redis tests below; the two should be groomed together.

Failures seen under load:
- `redis-privacy` AC24 test: a `lock:` key is released between `KEYS` and `PTTL`, so PTTL returns -2 and the assertion fails (3 times under load). Suggested: skip keys whose PTTL is -2 (key vanished) in the loop.
- 5 s timeouts in `main.test`, `redis-startup`, `heartbeat` and `release-files` (tests that spawn processes or wait on refused ports). Suggested: longer, explicit timeouts for process-spawning tests.
- `multi-delivery.redis` "a stalled subscriber link is found by its probe and replaced" failed twice in loaded full runs.

## Running the Redis tests
- The env var is `SYNC_TEST_REDIS_URL` (not `TEST_REDIS_URL`; a wrong name silently skips 22 Redis test files).
- Redis needs CI's password set, or the main-redis wrong-password test fails.
- CI uses Redis 7.2.17.

## Acceptance criteria
- [ ] The listed tests pass reliably under concurrent load (e.g. N repeated full runs with two suites in parallel).
- [ ] No assertion is weakened beyond tolerating a vanished key (PTTL -2) or a longer timeout.
- [ ] lint, typecheck, test and build pass.
- [ ] No new dependencies.

## Out of scope
- Product code changes in sync-server beyond test helpers.

Reference: PR #75 QA comment (follow-up to #47).

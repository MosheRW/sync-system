# Spec: #80 test: make load-sensitive tests stable under machine load

Issue: https://github.com/MosheRW/sync-system/issues/80
Path: fast. Type: test (test-only stability fix, follow-up to #47).

## Problem
Some tests fail intermittently when the machine is loaded (e.g. two suites
running in parallel). Issue #78 (branch `fix/78-sync-server-flaky-tests`,
another session) already covers the 5 s timeouts in `main.test.ts`,
`redis-startup.test.ts` and `release-files.test.ts`. #80 covers the rest:

1. `redis-privacy` AC24 test (`apps/sync-server/test/redis-privacy.redis.test.ts`):
   a `lock:` key expires between `KEYS` and `PTTL`, so PTTL returns -2 and
   the bound check fails.
2. `heartbeat` test: hits the 5 s test timeout under load (process spawning,
   refused-port waits).
3. `multi-delivery.redis`: "a stalled subscriber link is found by its probe
   and replaced" fails in loaded full runs.

## Acceptance criteria
- [ ] AC24 test tolerates a key that vanishes between `KEYS` and `PTTL`
      (PTTL -2); the TTL bound is still asserted for every key that still exists.
- [ ] The heartbeat test passes under load (explicit/longer timeout or
      de-flaked waits), without removing assertions.
- [ ] The multi-delivery stalled-subscriber-link test passes under load
      without weakening what it asserts (link found by probe and replaced).
- [ ] The three tests pass reliably across repeated full runs with two suites
      running in parallel.
- [ ] No assertion is weakened beyond: tolerating a vanished key (PTTL -2),
      or a longer/explicit timeout.
- [ ] `lint`, `typecheck`, `test`, `build` pass.
- [ ] No new dependencies; no product code changes in sync-server beyond
      test helpers.

## Out of scope
- `main.test.ts`, `redis-startup.test.ts`, `release-files.test.ts`: owned by
  #78. These files must not be edited here.
- Any product (non-test) code changes.
- `docs/roadmap.md`.

## Notes
- PR #75 (#47, not yet merged) edits the AC24 test in
  `redis-privacy.redis.test.ts` (comment + pExpireTime assertion); expect a
  small merge overlap there.
- Redis tests need env var `SYNC_TEST_REDIS_URL` (a wrong name silently skips
  22 files). CI uses Redis 7.2.17 with a password (needed by the main-redis
  wrong-password test).

## Open questions
- none

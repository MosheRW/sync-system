# Spec: #87 test(sync-server): main-redis AC4 and multi-process reconnect tests flaky under load

Issue: https://github.com/MosheRW/sync-system/issues/87

## Problem
Under load (full sync-server and reader suites running concurrently, seen during #80), two Redis tests fail:
- `apps/sync-server/test/main-redis.redis.test.ts` "the process exits 1 after a Redis failure while starting (AC4)": child SIGTERM'd at the 30 s spawn timeout.
- `apps/sync-server/test/multi-process.redis.test.ts` "a killed process's clients reconnect...": "server did not start".

Run with `SYNC_TEST_REDIS_URL` (a wrong name silently skips 22 Redis files); CI uses Redis 7.2.17 with a password.

## Acceptance criteria
- [ ] Each of the two failures is root-caused (load/timing vs real bug) with recorded evidence.
- [ ] Both tests pass reliably under concurrent load: repeated runs with two suites in parallel.
- [ ] No assertion weakened beyond explicit, justified timeouts; no test skipped.
- [ ] Only test files (and possibly `.github/workflows/ci.yml`) change, unless the root cause is a real product bug.
- [ ] The approach of #80 / PR #85 is reused (`docs/issues/80/architecture.md`).
- [ ] Any shared vitest config change is coordinated with #78.

## Out of scope
- Other candidates listed in the issue comment (multi-delivery leader moves, multi-cluster AC18/19, etc.).
- The race in the `pubsub.ts` probe (#86, fixed in parallel). If a flake traces to it, record it here; do not fix it.
- Tests covered by #78 and #80.
- `docs/roadmap.md`.

## Open questions
- none

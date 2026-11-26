# Spec: #78 fix(sync-server): flaky test failures in the full parallel test run

Issue: https://github.com/MosheRW/sync-system/issues/78

## Problem
The full root `pnpm test` run fails in `apps/sync-server` while the same tests pass alone. Found during #27 (PR #73), which does not touch sync-server.

Failures seen in the full parallel run:
- `test/main.test.ts` "exits non-zero and prints the config error to stderr": 5 s timeout. Reproduced on clean main (d37f1b3).
- `test/redis-startup.test.ts`: 5 s timeout (not reproduced on main).
- `test/release-files.test.ts`: 2 failures, old placeholder scope and Docker Hub mirror name (not reproduced on main).

Run alone, the three files pass 82/82 on main and on the #27 branch. The timeouts look load-related. The `release-files` failures may have a separate cause (stale expectation or environment) that must be confirmed or ruled out.

## Acceptance criteria
- [ ] Root `pnpm test` passes on main over several consecutive full runs (number agreed in the plan, at least 3).
- [ ] Each of the four failures is root-caused and the cause documented (timing/load vs. stale expectation vs. environment).
- [ ] The `release-files.test.ts` failures are either fixed (stale expectation) or ruled out as not reproducible, with evidence.
- [ ] No test is skipped, deleted or have its assertions weakened to hide a failure.

## Out of scope
- Reader app tests.
- Release-process changes beyond what the tests need.
- `docs/roadmap.md`.

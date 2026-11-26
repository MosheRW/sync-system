# Spec: #103 test(server): multi-cluster AC18 take-back race times out under load

Issue: https://github.com/MosheRW/sync-system/issues/103
Path: fast | Type: test

## Problem
`apps/sync-server/test/multi-cluster.redis.test.ts` ("a take-back on A racing a grace handoff fired on B leaves exactly one leader (AC18)", ~line 203) timed out once in a full `pnpm test` run with Redis 7 under machine load. It passes alone, on the PR #93 branch and on `origin/main`. Found during QA of #48. Cause is unknown: timing/load, or a real race in the take-back / grace handoff path.

## Acceptance criteria
- [ ] Root cause recorded (timing/load vs a real race in the take-back / grace handoff path) with evidence.
- [ ] If it is a real bug, it is fixed; if timing only, the test passes reliably under concurrent load (repeated runs with two suites in parallel), with only explicit, justified timeout changes.
- [ ] No assertion weakened, no test skipped.
- [ ] Lint, typecheck, test and build pass; no new dependencies.

## Out of scope
- Other flaky tests: #87 (PR #98), #80, #101, #102.
- Editing `docs/roadmap.md`.
- Coordination: open PR #98 edits `apps/sync-server/test/helpers/child-env.ts`, `main-redis.redis.test.ts` and `multi-process.redis.test.ts`. Avoid touching those files, or coordinate with #98 before any shared test-helper or vitest config change.

## Open questions
- If root-causing finds a real product race, the path may switch from fast to full (needs architecture/plan).

Refs: #48, #35, #87, #80

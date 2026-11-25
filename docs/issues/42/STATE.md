# State: #42 fix(server): treat a just-started instance as live when picking a successor (follow-up to #35)
- Path: fast
- Phase: validation
- Branch: fix/42-successor-liveness
- PR: #74
- Plan approved by user: yes (Gate 2, as written, no ADRs)
- Security-sensitive: yes (touches control C12: liveness feeding leadership hints)
- Review rounds: 1
- Last updated by: qa
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule: security-sensitive; architect Implementer model) → BLOCKED (all chunks done; Docker Desktop went down mid-run, so the full Redis suite and SYNC_TEST_STORE=redis could not run; the new multi-liveness suite passed 6 times on Redis 7.2 before that)
- engineer continue: opus (rule: continuation) → DONE (Redis suites run on Redis 7.2, both plain and SYNC_TEST_STORE=redis; PR #74 marked ready)
- qa review r1: sonnet (NEXT_MODEL) → PASS (QA verdict PASS: lint, typecheck, build, unit and Redis suites pass; 8/8 criteria met; all commits signed; known load flakes confirmed on rerun)
## Open questions
- Resolved in architecture.md: direct Redis check on a cache miss (one MGET per grace end or take-back); re-arm rejected (does not cover handoff/S4). Security plan review (C12): PASS, see security.md (R1-R9, advisories L1-L2).
## Deviations from plan
- Unrelated flaky tests seen during the full runs (not changed here): 5 s timeouts in spawn-heavy `main`, `redis-startup` and `release-files` under full-suite load (they pass when rerun on their own); `redis-privacy` AC24 (a lock key expires between KEYS and PTTL, -2), which flakes the same way on `main`.
- `open-hints.ts` also exports `logHintFailure(logger)` (the `liveness_hint_failed` warn line with `err: safeErr(err)` only), so the R5/R9 log-shape test can unit-test it; the plan said "no logger import (the caller logs)". `openHints` itself stays pure; `group-service.ts` passes `logHintFailure(deps.logger)` as `onError`.
- `graceEnded` returns early (no hint read) when the group is not in `auto` handoff or has no pause, so a frozen group's grace end makes no Redis read (R4); behaviour otherwise as planned.
- `handoff` skips the `[old]` read when the old leader has no recipient at all (nobody attached: nothing to confirm).
- Multi-instance test 2 (take-back) uses the fixed grace handoff on A for its setup, so it fails without chunk 1 too; verified it also fails with only chunk 2 reverted (timed out waiting for `leader.lost`). Test 1 fails with the lifecycle change reverted.

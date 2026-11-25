# State: #42 fix(server): treat a just-started instance as live when picking a successor (follow-up to #35)
- Path: fast
- Phase: implementation (all 5 chunks pushed; full Redis suite not yet run, PR still draft)
- Branch: fix/42-successor-liveness
- PR: #74
- Plan approved by user: yes (Gate 2, as written, no ADRs)
- Security-sensitive: yes (touches control C12: liveness feeding leadership hints)
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule: security-sensitive; architect Implementer model) → BLOCKED (all chunks done; Docker Desktop went down mid-run, so the full Redis suite and SYNC_TEST_STORE=redis could not run; the new multi-liveness suite passed 6 times on Redis 7.2 before that)
## Open questions
- Before PR #74 goes ready: run the Redis suites (`SYNC_TEST_REDIS_URL=... pnpm --filter @mosherw/sync-system-server test`, and the whole suite with `SYNC_TEST_STORE=redis`) once Docker is back. Lint, typecheck, build and the memory unit suite pass.
- Resolved in architecture.md: direct Redis check on a cache miss (one MGET per grace end or take-back); re-arm rejected (does not cover handoff/S4). Security plan review (C12): PASS, see security.md (R1-R9, advisories L1-L2).
## Deviations from plan
- `open-hints.ts` also exports `logHintFailure(logger)` (the `liveness_hint_failed` warn line with `err: safeErr(err)` only), so the R5/R9 log-shape test can unit-test it; the plan said "no logger import (the caller logs)". `openHints` itself stays pure; `group-service.ts` passes `logHintFailure(deps.logger)` as `onError`.
- `graceEnded` returns early (no hint read) when the group is not in `auto` handoff or has no pause, so a frozen group's grace end makes no Redis read (R4); behaviour otherwise as planned.
- `handoff` skips the `[old]` read when the old leader has no recipient at all (nobody attached: nothing to confirm).
- Multi-instance test 2 (take-back) uses the fixed grace handoff on A for its setup, so it fails without chunk 1 too; verified it also fails with only chunk 2 reverted (timed out waiting for `leader.lost`). Test 1 fails with the lifecycle change reverted.

# State: #80 test: make load-sensitive tests stable under machine load (follow-up to #47)
- Path: fast
- Phase: validation
- Branch: test/80-load-stable-tests
- PR: #85
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 1
- Last updated by: qa
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (rule: one tier up from NEXT_MODEL sonnet) → DONE
- engineer implement: sonnet (Implementer model line) → DONE
- qa review r1: sonnet (default/NEXT_MODEL) → PASS
## Open questions
- Gate 2 decisions: plan approved as written, no ADRs. Follow-up for the RedisPubSub.probe() stale-probe race: #86 (out of scope). Other load-flaky tests (main-redis AC4, multi-process reconnect, and the ones listed under Verification): #87 (out of scope).
## Deviations from plan
- Merged origin/main first (merge commit 4057ce9); main now holds #75 and #78 (PR #83), so the #78 files were not touched but are now the merged versions.
- Heartbeat timeout is written as a describe option `{ timeout: 15_000 }` as planned.

## Verification (2026-11-25/26, Windows, Redis 7.2.17 in Docker with CI flags, SYNC_TEST_REDIS_URL set; Redis tests ran, not skipped)
- AC24 alone, 10 runs: 10/10 pass. Stalled-link test alone, 6 runs: 6/6 pass.
- Stress, 3 rounds (full sync-server + full reader in the background, 3 foreground runs of the three files each, 26 tests per run): 8 of 9 foreground runs fully green. One failure in round 2: `multi-delivery.redis` "a member on B gets the leader moves from A in order, each well under a second" (a different test in the same file, 8.9 s, a timing test), not one of the three targets. Heartbeat real-socket, AC24 and stalled-link tests passed in all 9 foreground runs. Background full sync-server runs: rounds 1 and 3 145/145 files green; round 2 had 6 load failures in other files (main-redis AC4, multi-process reconnect, outage C4, multi-cluster AC19, lease-lock busy wait, a keep-alive pause test).
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: pass. `pnpm test` (workspace, run 3 times while other sessions' containers were running on this machine, about 40% CPU idle load): packages/protocol and reader pass; sync-server had 5 to 10 failures per run in other multi-instance Redis tests (multi-cluster, multi-delivery C14 and in-order moves, multi-timers, multi-approvals, multi-sweep, redis-stored-values, redis-timers, restart); the three target tests passed in every run. The same six files run alone: 116/116 pass. Not caused by this change (no product, helper or config change; these tests are unchanged). Candidates for #87.
- Diff vs origin/main: three test files and docs/issues/80 only.

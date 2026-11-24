# State: #67 fix(release): 12 pnpmfile tests fail in the node:24 CI container
- Path: fast
- Phase: validation
- Branch: fix/67-pnpmfile-tests-container
- PR: #68
- Plan approved by user: yes (2026-11-24)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL, unknown root cause) → DONE
- security plan: opus (rule) → PASS
- pm gate-2 update: sonnet (default) → DONE
- engineer implement: opus (rule: security-sensitive plan, Implementer model: opus) → DONE
## Gate 2 decisions (2026-11-24)
1. Host criterion: a full pass through `pnpm test` on the Windows host counts as passing; bare `node --test` on Windows keeps skipping the two pnpm suites (#63 design).
2. Acceptance criterion changed from 103 of 103 to 104 of 104 (the plan adds one test).
3. Security advisory L1 (packAll should check `pnpm --version` against the packageManager pin): follow-up issue #69.

## Open questions
- none
## Deviations from plan
- Offline container run used `docker network disconnect bridge` on the running container (no networks attached, no DNS), equivalent to `--network none` after the online `pnpm install`.
- Container full `pnpm test` with `CI=true` fails only `apps/sync-server` `redis-required.test.ts` (needs `SYNC_TEST_REDIS_URL` in CI, #35 AC31; no Redis in this container). Unrelated to #67; full `pnpm test` without `CI` passes. The bare release run with `CI=true` is 104/104.

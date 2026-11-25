# State: #78 fix(sync-server): flaky test failures in the full parallel test run
- Path: fast
- Phase: ready-to-merge
- Branch: fix/78-sync-server-flaky-tests
- PR: #83
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 1
- Last updated by: qa
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL + default) → DONE (root causes: 1 main.test tsx child without test timeout; 2 redis-startup lazy @redis/client import in timed window, reproduced under stress; 3+4 release-files not reproduced, stale expectation/environment ruled out, likely load)
- engineer implement: sonnet (architect Implementer model) → DONE
- qa review r1: sonnet (default + NEXT_MODEL) → PASS (lint, typecheck, 2 full root test runs, 3 files alone 82/82; 4/4 criteria met; all commits signed)
- security code r1: opus (rule) → PASS (0 critical/high/medium; L1 low: .npmrc _authToken check now skips tracked-but-missing files; pnpm audit clean; gitleaks/semgrep not installed)
## Open questions
- none
## Deviations from plan
- none

## Reliability runs (engineer, 2026-11-25, Windows 11, Node 24.18, Vitest 4.1.12)
Run on the three fixed test files (commits c0c0828, 225d683, 271f035).
- Changed files alone (`npx vitest run test/main.test.ts test/redis-startup.test.ts test/release-files.test.ts`): 3 runs, 82/82 pass each (26 s cold, 2.6 s and 2.8 s warm).
- `pnpm lint`, `pnpm typecheck`: pass.
- 5 consecutive full root `pnpm test` runs, nothing else running: all exit 0, 316 s, 230 s, 307 s, 214 s, 234 s.
- Stress round 1 (root `pnpm test` + sync-server `vitest run` + reader `vitest run` at once): all three exit 0 (root 408 s, server 201 s, reader 239 s).
- Stress round 2 (same): all three exit 0 (root 329 s, server 198 s, reader 225 s).
- Negative checks (local, reverted, not committed): `docker.io/` + `mosherw` line in README.md made the mirror test fail with `['README.md']`; the old `@sync` + `-system/` scope line made the placeholder test fail with `['README.md']`.

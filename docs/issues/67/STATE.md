# State: #67 fix(release): 12 pnpmfile tests fail in the node:24 CI container
- Path: fast
- Phase: architecture
- Branch: fix/67-pnpmfile-tests-container
- PR: #68
- Plan approved by user: yes (2026-11-24)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: pm
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL, unknown root cause) → DONE
- security plan: opus (rule) → PASS
## Gate 2 decisions (2026-11-24)
1. Host criterion: a full pass through `pnpm test` on the Windows host counts as passing; bare `node --test` on Windows keeps skipping the two pnpm suites (#63 design).
2. Acceptance criterion changed from 103 of 103 to 104 of 104 (the plan adds one test).
3. Security advisory L1 (packAll should check `pnpm --version` against the packageManager pin): follow-up issue #69.

## Open questions
- none
## Deviations from plan
- none

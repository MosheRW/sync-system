# State: #67 fix(release): 12 pnpmfile tests fail in the node:24 CI container
- Path: fast
- Phase: architecture
- Branch: fix/67-pnpmfile-tests-container
- PR: #68
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL, unknown root cause) → DONE
- security plan: opus (rule) → PASS
## Open questions
- Windows host: bare `node --test` keeps skipping the two pnpm suites (R4, by design); the host 103/103 (104/104) check is through `pnpm test`. Confirm at Gate 2.
## Deviations from plan
- none

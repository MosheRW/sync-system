# State: #63 chore(release): close remaining pnpmfile routes in pack:check guard
- Path: fast
- Phase: architecture
- Branch: chore/63-pnpmfile-routes
- PR: #64
- Plan approved by user: no
- Security-sensitive: yes (release integrity)
- Review rounds: 0
- Last updated by: security
## Model log
- pm spec: sonnet (default) → DONE
- architect plan: opus (default + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
## Open questions
- Gate 2: ADR 0021 option A / B / C (recommended C: pack with `--config.ignore-pnpmfile=true` + dash-normalised env guard). `pnpm pack --ignore-pnpmfile` is rejected by pnpm 10.28.0; the `--config.` form works (evidence in architecture.md).
## Deviations from plan
- none

# State: #63 chore(release): close remaining pnpmfile routes in pack:check guard
- Path: fast
- Phase: implementation
- Branch: chore/63-pnpmfile-routes
- PR: #64
- Plan approved by user: yes (Gate 2, 2026-11-24: ADR 0021 option C)
- Security-sensitive: yes (release integrity)
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm spec: sonnet (default) → DONE
- architect plan: opus (default + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (architect Implementer model; security-sensitive) → DONE
## Open questions
- none (Gate 2 decided: ADR 0021 option C, Accepted)
## Deviations from plan
- Integration test: three extra route cases beyond the plan's list
  (`@pnpm/plugin-*` scoped config dependency, env `npm_config_globalconfig`,
  env `XDG_CONFIG_HOME` pnpm/rc), the last two from security.md; all pass.
- Docker negative check 3: through `pnpm pack:check`, a `pnpmfile` in root
  `.npmrc` or `pnpm-workspace.yaml` makes the outer pnpm export
  `npm_config_pnpmfile` to the script, so the guard fails closed (exit 1)
  instead of passing. The flag itself was shown by running
  `node scripts/release/pack-check.ts` directly with the same settings: exit
  0, no hook field, INTEGRITY identical to the 40/40 baseline. Likewise the
  dashed env var reaches the script as `npm_config_global_pnpmfile` through
  `pnpm`, and as `npm_config_global-pnpmfile` when run directly; both fail.

# State: #63 chore(release): close remaining pnpmfile routes in pack:check guard
- Path: fast
- Phase: validation
- Branch: chore/63-pnpmfile-routes
- PR: #64
- Plan approved by user: yes (Gate 2, 2026-11-24: ADR 0021 option C)
- Security-sensitive: yes (release integrity)
- Review rounds: 3
- Last updated by: engineer
## Model log
- pm spec: sonnet (default) → DONE
- architect plan: opus (default + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (architect Implementer model; security-sensitive) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS
- security code r1: opus (rule) → PASS (low A1, A2)
- Gate 3: PR #64 ready to merge (2026-11-24); user chose to fix A1, A2 now
- engineer fix r1: opus (rule) → DONE
- qa review r2: opus (rule) → PASS (local Docker CI green, 3/3 pack:check = baseline, new tests mutation-checked)
- security code r2: opus (rule) → PASS (low A3)
- Gate 3 (round 2): PR #64 ready to merge (2026-11-24)
- engineer fix r2: opus (rule) → DONE
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
- Fix r1 (security A1, A2; local Docker, pinned node:24 digest + redis
  sidecar, CI=true): full suite green (vitest 4158, node --test 103 incl. the
  new env route case and the `pnpm run` export test); 3/3 pack:check runs
  match the 40/40 baseline; `pnpm pack:check` with `pnpmfile` in `.npmrc`
  or `pnpm-workspace.yaml` exits 1 on `npm_config_pnpmfile is set`.
- Fix r2 (security A3): the A1 fixture script now writes only the
  `npm_config_*` keys (name lowercased, `-` read as `_`, as the guard does)
  instead of the whole child env, and the test asserts the dump is non-empty
  and holds only such keys. Every name checkNoPnpmfile reads
  (`PNPMFILE_ENV`) has that prefix. Local Docker CI (node:24 pinned digest +
  redis sidecar, CI=true): audit, lint, typecheck, test (vitest + node
  --test 103/103), build, smoke green; 3/3 pack:check match the 40/40
  baseline. Mutations (filter drops pnpmfile keys, filter dumps whole env,
  filter dumps nothing, guard drops `npm_config_pnpmfile`) each fail A1.
  Note: A1 needs the outer `pnpm run` env, as `pnpm test` provides; plain
  `node --test` or `pnpm exec` fails its set cases, before and after this
  fix (unchanged harness behaviour).

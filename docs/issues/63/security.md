# Security review (plan): #63 close remaining pnpmfile routes in pack:check guard

Mode: plan. Branch: `chore/63-pnpmfile-routes`. PR: #64. Reviewed:
`spec.md`, `architecture.md`,
[ADR 0021](../../decisions/0021-pack-with-pnpmfiles-ignored.md), ADR 0020,
`scripts/release/lib.ts`, `RELEASING.md`.

**Verdict: PASS** (critical 0, high 0, medium 1, low 4). Option C is the
right choice. A is acceptable. B alone is weaker (see M1).

## Assets and trust boundaries

- **Asset:** the bytes of the three tarballs that `pack:check` verifies
  and the publish container ships unchanged (`npm publish <tarball>`).
- **Boundary 1, the repo:** `.pnpmfile.cjs`, `.npmrc`, `pnpm-workspace.yaml`,
  `package.json` (`pnpm.configDependencies`). Changing them takes a
  reviewed commit.
- **Boundary 2, the build environment:** env vars, user and global rc
  files, `XDG_CONFIG_HOME`. Whoever runs the build container controls
  them.
- **Boundary 3, the pnpm binary:** pinned by `packageManager` with a sha512.

## Threats

- **Tampering:** a pnpmfile `beforePacking` hook rewrites the packed
  `package.json` after the source-level checks (for example, it adds an
  install script or a dependency), and that tarball is published.
- **Elevation:** any pnpmfile is arbitrary code in the pnpm process
  (install, `pnpm run`, `pnpm pack`).
- Spoofing, repudiation, information disclosure and DoS: this change does
  not affect them.

## Independent verification

I used pnpm 10.28.0 (the corepack copy) in a scratch workspace outside the
repo.

Source (`dist/pnpm.cjs`): pnpm loads pnpmfiles through `requireHooks` in
exactly two places, `getConfig` (`cli/cli-utils`) and the recursive install
loop. Both are gated by `ignorePnpmfile`. In `getConfig`, everything that
loads hooks sits inside `if (!config.ignorePnpmfile)`: the default
`.pnpmfile.cjs`, `pnpmfile`, `globalPnpmfile`, the pnpmfiles of
config-dependency plugins, and the `updateConfig` hooks. So no hook can
turn the setting back off. `installConfigDeps` runs before the gate, but it
only fetches and imports.

Runs: `pnpm pack` in a workspace package, then I read `hookedBy` from the
packed manifest.

| Case                                                                    | Plain      | `--config.ignore-pnpmfile=true`                     |
| ----------------------------------------------------------------------- | ---------- | --------------------------------------------------- |
| root `.pnpmfile.cjs`                                                    | hooked     | not hooked                                          |
| `pnpm pack --ignore-pnpmfile`                                           | exit 1     | n/a                                                 |
| `pnpm-workspace.yaml` `ignorePnpmfile: false` + root pnpmfile           | n/a        | not hooked                                          |
| `.npmrc` `ignore-pnpmfile=false` + root pnpmfile                        | n/a        | not hooked                                          |
| `configDependencies` `pnpm-plugin-*` (simulated offline)                | hooked     | not hooked (also with yaml `ignorePnpmfile: false`) |
| env `npm_config_global-pnpmfile` (dashed)                               | hooked     | guard + flag                                        |
| env `NPM_CONFIG_PNPMFILE` (upper case)                                  | hooked     | guard + flag                                        |
| env `npm_config_globalpnpmfile` / `globalPnpmfile` / `global__pnpmfile` | not hooked | n/a                                                 |
| env `npm_config_userconfig=<rc with pnpmfile>`                          | hooked     | flag                                                |
| env `npm_config_globalconfig=<rc with pnpmfile>` (new)                  | hooked     | flag                                                |
| env `XDG_CONFIG_HOME` with `pnpm/rc` setting `pnpmfile` (new)           | hooked     | not hooked                                          |
| outer `pnpm run x` with a root pnpmfile                                 | loaded     | not loaded (flag placed before `run`)               |

All of the architect's key claims hold. I found two more env routes that
the flag closes: `npm_config_globalconfig` and `XDG_CONFIG_HOME`. This
supports C over B.

One more result: with env `npm_config_ignore_pnpmfile=true`, the hook
still applied when `pnpm-workspace.yaml` set `ignorePnpmfile: false`. The
env var loses to the workspace file. So the setting must go on the command
line, never in the environment. The plan already does this.

## Findings

| #   | Severity | Location                                                  | Issue                                                                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Medium   | ADR 0021 option B                                         | If B is chosen alone, the pack child still loads pnpmfiles from routes B does not parse: user `~/.npmrc`, `npm_config_userconfig`, `npm_config_globalconfig`, the `XDG_CONFIG_HOME` rc, and YAML forms that a line regex misses. Someone who controls the build env can then rewrite the packed manifest without anyone noticing. | Choose C (or A). If B is chosen anyway, list every unparsed route in `RELEASING.md` Known limits, as the plan says.                                                                                                                                                                                                                                                                                                  |
| L1  | Low      | architecture.md "Risks", outer process                    | With C, a `pnpmfile` in `.npmrc` or `pnpm-workspace.yaml`, or a plugin `configDependency`, still runs code in the outer `pnpm pack:check` / `pnpm smoke` process and in `pnpm install`. The guard does not name these cases. Such code can't change the pack child's hooks, but it can still change files. Adding one takes a reviewed repo change, and the same code already runs at install. | Accept as residual and state it in `RELEASING.md`, as planned. That text should tell release-PR reviewers to treat any diff that adds `pnpmfile`, `globalPnpmfile` or `configDependencies` as release-relevant. Optional follow-up issue: run the build container's pnpm commands with `--config.ignore-pnpmfile=true` on the command line (not as an env var, see above).                       |
| L2  | Low      | Test plan, integration test                               | Two failure modes make the flagged cases pass vacuously: the child env inherits `npm_config_ignore_pnpmfile`, or pnpm is not found and the test skips. In both cases a pnpm rename would go unnoticed.                                                                                                                               | See required controls R3 and R4.                                                                                                                                                                                                                                                                                                                                                                                     |
| L3  | Low      | Approach step 2, `run(..., env?)`                         | A production caller that passes a built env could drop or add variables without anyone noticing.                                                                                                                                                                                                                                       | Only tests pass `env`. Production keeps the default (inherited). Pass `env` straight to `execFileSync`, still as argument arrays, with no `shell`.                                                                                                                                                                                                                                                                         |
| L4  | Low      | ADR 0021 consequences: `configDependencies` still fetched | Every pnpm command fetches and imports a config dependency (no scripts run) before the gate.                                                                                                                                                                                                                                             | Accept. Adding one takes a reviewed repo change, it is integrity-pinned, and with the flag none of its code runs. No action in this issue.                                                                                                                                                                                                                                                                             |

No critical or high findings.

## Required controls (part of the plan)

- **R1.** The pack child gets the setting on the command line as
  `--config.ignore-pnpmfile=true`, in a single exported `PACK_ARGS`. Every
  pack in `packAll` goes through `packOne`, which covers `pack:check`,
  `release:dry-run` and `smoke`. Don't use the env-var form, and don't put
  anything after `PACK_ARGS` that sets `ignore-pnpmfile`.
- **R2.** `checkNoPnpmfile` compares env names after `toLowerCase()` and
  replacing `-` with `_`. It rejects `npm_config_global-pnpmfile` and
  `NPM_CONFIG_GLOBAL-PNPMFILE`, and it does not reject
  `npm_config_ignore_pnpmfile`. The root `.pnpmfile.cjs` check stays.
- **R3.** Integration test: each route case runs twice on the same fixture.
  First a positive control (plain `pnpm pack`, marker present), then the
  production `packOne` (marker absent, tarball written). Before adding the
  case's own keys, the child env drops every key matching
  `/pnpmfile|userconfig|globalconfig/i`, plus `XDG_CONFIG_HOME`.
- **R4.** When `CI=true` and pnpm cannot be found, the integration test
  fails instead of skipping. It runs in the local Docker CI.
- **R5.** `run()` keeps argument arrays and no `shell`. `env` defaults to
  inherited, and only tests pass it.
- **R6.** `RELEASING.md` Known limits says packing ignores every pnpmfile,
  names the outer-process residual (L1), and links ADR 0021.
- **R7.** The PR shows the 40/40 identical-pack result and the Docker
  negative checks (architecture.md steps 2 and 3).

## Checks in code mode

- R1 to R7 above, in the diff.
- `PACK_ARGS` is the only way `pnpm pack` is called (grep for `'pack'`).
- No new dependency, lockfile unchanged.
- gitleaks, semgrep (changed files) and `npm audit`, whichever are
  installed.

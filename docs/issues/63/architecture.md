# Architecture: #63 chore(release): close remaining pnpmfile routes in pack:check guard

Path: fast. Branch: `chore/63-pnpmfile-routes`. PR: #64.

## Repo layout

Single repo, a pnpm workspace monorepo (`pnpm-workspace.yaml`, no
submodules, no `.pnpmfile.cjs`, no `.npmrc`, no `configDependencies`).
This issue touches:

- `scripts/release` (`lib.ts`, `pack-check.ts` header comment,
  `pack-check.test.ts`).
- `RELEASING.md` ("Known limits" bullet only) and its marker test
  `apps/sync-server/test/release-files.test.ts`.
- `docs/decisions/0021-…` (new), `docs/decisions/0020-…` (header link
  only), `docs/conventions.md` (one row).

Checks: `pnpm lint` (ESLint, Prettier, `docs:links`), `pnpm typecheck`,
`pnpm test` (includes `node --test scripts/release/*.test.ts`),
`pnpm build`, `pnpm smoke`, `pnpm pack:check`. No other repo is affected.
`docs/roadmap.md` is not touched.

## Decisions

- [ADR 0021](../../decisions/0021-pack-with-pnpmfiles-ignored.md), Proposed.
  Options for Gate 2:
  - **A.** Pass `--config.ignore-pnpmfile=true` to `pnpm pack`.
  - **B.** Extend `checkNoPnpmfile` to parse `.npmrc`, `pnpm-workspace.yaml`,
    `configDependencies` and dashed env names.
  - **C (recommended).** A, plus keep `checkNoPnpmfile` and make its env
    match treat `-` and `_` alike. No config-file parsing.

  Trade-off: A/C switch off pnpm's pnpmfile loader for the pack child, so
  they hold against every route, including ones nobody listed (we found one
  more: `npm_config_userconfig`). B fails loudly and names the setting, but
  is an enumeration that can't be complete and needs a hand-rolled YAML
  match (Node built-ins only). The cost of A/C: the `--config.` form is not
  validated by pnpm, so a later pnpm that renamed the setting would ignore
  it silently; the planned integration test catches that.

## Evidence

All runs on pnpm 10.28.0 (the pinned `packageManager`, the corepack copy at
`…/corepack/v1/pnpm/10.28.0/dist/pnpm.cjs`), Windows host, in a throwaway
workspace outside the repo: root `package.json` (private), a
`pnpm-workspace.yaml` with `packages/*`, and `packages/a` (`@x/a@1.0.0`).
Each hook file is
`module.exports = { hooks: { beforePacking(pkg) { pkg.hookedBy = (pkg.hookedBy || []).concat('<label>'); return pkg; } } };`.
Each run is `pnpm pack --pack-destination <out> [flag]` in `packages/a`;
the result is `hookedBy` in the packed `package/package.json`.

### Is the flag accepted?

| Command                                                   | Result                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm pack --ignore-pnpmfile`                             | **Rejected**: `ERROR Unknown option: 'ignore-pnpmfile'`, exit 1          |
| `pnpm --ignore-pnpmfile pack`                             | Rejected, same error                                                     |
| `pnpm pack --config.ignore-pnpmfile=true`                 | Accepted, no warning; root `.pnpmfile.cjs` hook **not** applied          |
| `pnpm pack --config.ignorePnpmfile=true`                  | Accepted, hook not applied                                               |
| env `npm_config_ignore_pnpmfile=true` + `pnpm pack`       | Hook not applied                                                         |
| `pnpm pack` (no flag, root `.pnpmfile.cjs`)               | Hook applied: `["root"]`                                                 |

### Every route, without and with `--config.ignore-pnpmfile=true`

| Route                                                                    | Plain           | With flag |
| ------------------------------------------------------------------------ | --------------- | --------- |
| `.npmrc` `pnpmfile=<file>`                                               | `["custom"]`    | `null`    |
| `.npmrc` `global-pnpmfile=<file>`                                        | `["globalrc"]`  | `null`    |
| `pnpm-workspace.yaml` `pnpmfile: <file>`                                 | `["wsyaml"]`    | `null`    |
| `pnpm-workspace.yaml` `globalPnpmfile: <file>`                           | `["wsyaml"]`    | `null`    |
| `configDependencies` `pnpm-plugin-evil` (yaml)                           | `["plugin"]`    | `null`    |
| `configDependencies` `@pnpm/plugin-evil` (yaml)                          | `["plugin"]`    | `null`    |
| `configDependencies` `@acme/pnpm-plugin-evil` (yaml)                     | `["plugin"]`    | `null`    |
| `package.json` `pnpm.configDependencies` `pnpm-plugin-evil`              | `["plugin"]`    | `null`    |
| env `npm_config_global-pnpmfile=<file>` (dashed)                         | `["globalenv"]` | `null`    |
| env `npm_config_pnpmfile=<file>` (control, already guarded)              | `["globalenv"]` | `null`    |
| env `npm_config_userconfig=<rc with pnpmfile=…>` (new, not in advisory)  | `["custom"]`    | `null`    |
| env `pnpm_config_pnpmfile` / `pnpm_config_global_pnpmfile`               | `null`          | `null`    |

The config-dependency plugins were simulated offline: the plugin directory
`node_modules/.pnpm-config/<name>/` held a `package.json` with the matching
name and version (pnpm 10.28.0's `installConfigDeps` then skips the fetch)
and a `pnpmfile.cjs`. pnpm loads `<configModulesDir>/<name>/pnpmfile.cjs`
for names that start with `pnpm-plugin-` or `@pnpm/plugin-` or contain
`/pnpm-plugin-`.

### Can repo config switch the flag back off?

With a root `.pnpmfile.cjs` and `--config.ignore-pnpmfile=true`:
`.npmrc` `ignore-pnpmfile=false`, `pnpm-workspace.yaml`
`ignorePnpmfile: false`, and env `npm_config_ignore_pnpmfile=false` each
still gave `null`. The CLI setting wins.

### Bytes unchanged

The three real packages packed from this branch with and without the flag
give the same sha512 (client `7eb015eb…`, protocol `ce485a17…`, react
`507957a0…`, host values). A no-hook fixture package also matched.

### Source (pnpm 10.28.0 `dist/pnpm.cjs`)

- `getConfig` in `cli/cli-utils/lib/getConfig.js`: `installConfigDeps`
  runs first (fetch and import only, `requiresBuild: false`), then
  `if (!config.ignorePnpmfile) { … calcPnpmfilePathsOfPluginDeps … requireHooks(…, { globalPnpmfile, pnpmfiles, tryLoadDefaultPnpmfile }) … updateConfig … }`.
  So the setting suppresses the default `.pnpmfile.cjs`, `pnpmfile`,
  `globalPnpmfile`, plugin pnpmfiles and their `updateConfig` hooks.
- `createExportableManifest` (pack/publish) applies
  `opts.hooks.beforePacking`, which is empty when no hooks were loaded.
- The outer `pnpm run` also loads pnpmfiles (a top-level `console.error` in
  a root `.pnpmfile.cjs` printed on `pnpm run x`, and not with
  `pnpm --config.ignore-pnpmfile=true run x`). This is the residual risk
  below.

## Approach (option C)

1. In `lib.ts`, one exported constant for the pack arguments, e.g.
   `PACK_ARGS = ['pack', '--config.ignore-pnpmfile=true']`, with a comment
   naming #63, ADR 0021 and why the `--config.` form (pnpm 10.28.0 rejects
   `--ignore-pnpmfile` on `pack`). Factor the per-package call out of
   `packAll` into an exported `packOne(pkgDir, dest, env?)` that runs
   `[...PACK_ARGS, '--pack-destination', dest]` in `pkgDir`, so the test can
   drive the exact production call against a fixture. `packAll` keeps its
   signature and output; `smoke` and `pack:check` benefit unchanged.
2. `run()` gets an optional `env` argument (default: inherited), only so the
   test can control the child's environment.
3. `checkNoPnpmfile`: compare env names after `toLowerCase()` and
   `replaceAll('-', '_')`, so `npm_config_global-pnpmfile` and
   `NPM_CONFIG_GLOBAL-PNPMFILE` are reported. Message unchanged. No new
   config-file parsing.
4. `pack-check.ts` header comment: say packing ignores every pnpmfile.

Rejected: **B alone** (incomplete by design, see ADR); **A without the
guard** (loses the loud, early failure for the documented cases and the
outer-process signal); **an env var instead of the CLI flag** (lower
precedence, less visible in the code).

## Files

- `scripts/release/lib.ts`: `PACK_ARGS`, `packOne`, `packAll` uses it;
  `run(..., env?)`; dash normalisation in `checkNoPnpmfile`.
- `scripts/release/pack-check.ts`: header comment only.
- `scripts/release/pack-check.test.ts`: unit cases (args, dashed env) and
  the route integration test.
- `RELEASING.md`: "Known limits" reproducibility bullet.
- `apps/sync-server/test/release-files.test.ts`: marker `ignore-pnpmfile`
  and the 0021 link in the Known limits list.
- `docs/decisions/0021-pack-with-pnpmfiles-ignored.md`: Accepted.
- `docs/decisions/0020-deterministic-packed-manifests.md`: header line
  `Amended by: 0021` only, decision text unchanged.
- `docs/conventions.md`: "Tarball reproducibility" row: "packed with
  pnpmfiles ignored" and the 0021 link.

Data model: none. Contracts: none. Docker impact: none.

Docs impact: `RELEASING.md` (Known limits), `docs/conventions.md`, ADR 0020
header, ADR 0021.

## Risks and edge cases

- **pnpm upgrade renames or drops `ignore-pnpmfile`.** `--config.*` is not
  validated, so the flag would be ignored silently. The integration test
  (positive control plus flagged run) fails in that case. `packageManager`
  is pinned, so this only surfaces on a deliberate bump.
- **Outer process.** `pnpm pack:check` itself (a `pnpm run`) still loads a
  configured pnpmfile and runs its code. Not closable from inside the
  script; it needs a reviewed repo change or control of the build env,
  which is the release trust boundary already. `checkNoPnpmfile` still
  flags the root file and env cases. `RELEASING.md` states this.
- **Config dependencies are still fetched** by any pnpm command (no
  scripts run). Out of scope; only pnpmfile loading matters here.
- **Test isolation.** The fixture lives in `os.tmpdir()`, with no
  `packageManager` field (no corepack download) and no dependencies, so it
  needs no network (Docker CI has none). The child env is `process.env`
  with every `npm_config_*pnpmfile*` / `userconfig` key removed, plus the
  case's own keys. pnpm must be found through `npm_execpath`, which holds
  under `pnpm test`.
- **Test time.** Each `pnpm pack` takes about 1 s; about 20 runs.
  Acceptable; group cases if it gets slow.
- `smoke` also packs through `packAll` and now ignores pnpmfiles for the
  pack. Its install step is unchanged (out of scope).

## Security-sensitive areas

Security-sensitive: yes

- Release integrity: the bytes `pack:check` verifies and `npm publish`
  ships (`scripts/release/lib.ts` `packAll`/`packOne`,
  `checkNoPnpmfile`).
- Child-process arguments and environment (`run`, now with an optional
  `env`): still argument arrays, never a shell string.
- No dependency is added or changed.

Implementer model: opus
Reason: security-sensitive release-integrity change with an open ADR and
an integration test that spawns pnpm under controlled env.

## Test plan

| Acceptance criterion                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No route can affect `pack:check`                              | `pack-check.test.ts` integration test, one case per route in the Evidence table (`.npmrc` `pnpmfile` and `global-pnpmfile`, yaml `pnpmfile` and `globalPnpmfile`, `configDependencies` plugin in yaml and in `package.json`, env `npm_config_global-pnpmfile`, env `npm_config_userconfig`, root `.pnpmfile.cjs`). For each: plain `pnpm pack` shows the marker (positive control), `packOne` does not. Plus a unit test that `PACK_ARGS` contains `--config.ignore-pnpmfile=true` |
| Dashed env reported                                           | `checkNoPnpmfile` cases for `npm_config_global-pnpmfile` and `NPM_CONFIG_GLOBAL-PNPMFILE`; the existing four names still rejected; `{}` and the real repo root still accepted                                                                                                                                                                                                                                                                                              |
| Existing guards and 40/40 identical packs from #53 still hold | All existing `pack-check.test.ts` cases green; Docker step 2 below                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RELEASING.md` updated                                        | Marker test in `release-files.test.ts` (`ignore-pnpmfile`, 0021 link)                                                                                                                                                                                                                                                                                                                                                                                                      |
| Lint, typecheck, test pass in local Docker CI                 | Docker step 1 below                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Local Docker CI (GitHub Actions is billing-blocked; red checks that fail in
about 3 s were never started and are ignored). Engineer, then QA. Prefix
containers `e63-` / `qa63-` and remove them afterwards:

1. A private Docker network with a `redis:7.2.17-alpine` sidecar and a
   pinned `node:24` container (no bind mounts). Copy a fresh clone of the
   branch, `.git` included, in with `docker cp`. With `CI=true`:
   `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck &&
pnpm test && pnpm build && pnpm smoke`. All green; the new integration
   test must run (not skip) in the container.
2. In the same container, `pnpm pack:check --out /packs/$i` for
   `i=1..40`, each into a new directory (don't `rm` with a `/p*` glob, it
   matches `/proc`). `cat /packs/*/INTEGRITY.txt | sort | uniq -c` prints
   exactly three lines, each with count 40.
3. Negative checks in the container, each reverted afterwards: create a
   root `.npmrc` with `pnpmfile=/tmp/h.cjs` (a `beforePacking` hook adding
   a field); `pnpm pack:check --out /packs/neg` passes and the unpacked
   react `package.json` has no such field. Then
   `env 'npm_config_global-pnpmfile=/tmp/h.cjs' pnpm pack:check` exits 1
   with the #53 / ADR 0020 message.

## Implementation chunks

1. `docs(adr): accept 0021 pack-with-pnpmfiles-ignored`: 0021 becomes
   Accepted with the user's Gate 2 choice; ADR 0020 header gets
   `Amended by: 0021`; the `docs/conventions.md` row changes.
2. `fix(release): pack with pnpmfiles ignored`: `lib.ts` (`PACK_ARGS`,
   `packOne`, `run` env, dash normalisation), `pack-check.ts` comment,
   unit tests in `pack-check.test.ts`.
3. `test(release): cover every pnpmfile route in pack`: the integration
   test with positive controls.
4. `docs(release): document packing with pnpmfiles ignored`: `RELEASING.md`
   Known limits bullet and the marker test. This is the docs chunk.

If the user picks **B** instead: chunk 2 becomes
`fix(release): detect pnpmfile settings in config files` (root `.npmrc`
and `pnpm-workspace.yaml` line matches for `pnpmfile`,
`global-pnpmfile`/`globalPnpmfile`, `configDependencies`;
`pnpm.configDependencies` in `package.json`; dashed env), chunk 3 tests each
detection with unit fixtures, and the docs chunk lists the routes B does
not cover (user and global rc, `npm_config_userconfig`). If **A** without
the guard fix: chunk 2 drops the dash normalisation.

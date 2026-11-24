# Architecture: #67 fix(release): 12 pnpmfile tests fail in the node:24 CI container

Path: fast. Branch: `fix/67-pnpmfile-tests-container`. Part of #65.

## Repo layout
Single repo with pnpm workspaces (no submodules). Touched: the repo root only,
`scripts/release/pack-check.test.ts`. Checks: `pnpm lint`, `pnpm typecheck`,
`pnpm test`, plus the bare `node --test "scripts/release/*.test.ts"` in the
pinned `node:24` container.

## Root cause (reproduced before planning)

**Environment assumption in the test, not a bug in the guard.**

The route tests (#63, ADR 0021 R3) and the `pnpm run` export tests (#63, A1)
build a throwaway workspace under `os.tmpdir()`, outside the repo, whose root
`package.json` has **no `packageManager` field**. Both halves of every case
(the positive-control `pnpm pack` and the production `packOne`) resolve pnpm
through `pnpmCommand()`:

- launched through pnpm (`pnpm test`), `npm_execpath` points at the pinned
  `pnpm.cjs` (10.28.0), so the fixture is packed by the pinned pnpm;
- launched as a bare `node --test` on Linux, `npm_execpath` is unset and
  `pnpmCommand()` returns plain `pnpm` from `PATH`. After `corepack enable`
  that is the corepack shim, which picks the version from the nearest
  `packageManager` field **of the working directory**. The fixture has none,
  so corepack falls back to its own default: **pnpm 12.23.0** in the
  `node:24` image (corepack 0.36.0), not the pinned 10.28.0.

pnpm 12 no longer loads a pnpmfile from `.npmrc`, `npm_config_*` env, rc files
or `package.json` `pnpm.configDependencies`, rejects the fixture's
`configDependencies` spec (`ERR_PNPM_BAD_CONFIG_DEP`), and `pnpm run` no
longer exports `npm_config_pnpmfile`. So the *positive controls* fail: the
route is not live in that pnpm, and the test correctly refuses to call it
covered. The guarded half never ran for those cases; for the three routes
pnpm 12 still honours (root `.pnpmfile.cjs`, `pnpm-workspace.yaml`
`pnpmfile` / `globalPnpmfile`), `--config.ignore-pnpmfile=true` still blocked
the hook.

Production is not affected: `packAll` packs with `cwd` inside the repo, so the
shim (or `npm_execpath`) resolves the pinned pnpm; the release procedure runs
`pnpm test` / `pnpm pack:check`, never a bare `node --test`.

### Reproduction

| Where | Command | Result |
|---|---|---|
| Container, no `corepack enable` (`CI=true`) | `node --test scripts/release/*.test.ts` | 86/103, 17 fail: `pnpm` not on PATH (the R4 "fails in CI" path, expected) |
| Container, after `corepack enable` (`CI=true`), QA's setup | same | **91/103, 12 fail** (the reported failure) |
| Container, after `corepack enable` | `pnpm --version` in `/tmp/x` / in `/src` | `12.23.0` / `10.28.0` |
| Container, through `pnpm run` (`npm_execpath` = pinned 10.28.0) | same `node --test` | 103/103 |
| Host (Windows, Git Bash), bare | same | 86 run, the 2 pnpm suites skipped (R4: `pnpmCommand()` refuses a PATH lookup on win32) |
| Host, bare, `CI=true` | same | 17 fail (R4, by design) |
| Host, through `pnpm run`, with and without `CI=true` | same | 103/103 |
| Container + candidate fix (fixture pins `packageManager`), **offline** (`docker network disconnect`) | bare `node --test` | **103/103** |
| Container + candidate fix + mutation (`PACK_ARGS = ['pack']`) | same | 15 fail: all 13 routes + 2 `PACK_ARGS` tests |

Container: `node:24@sha256:9d266751…7496` (RELEASING.md), repo cloned from a
`git bundle` (with `.git`), no bind mounts, `CI=true`. All temp edits were made
in the container clone only and reverted; the container was removed.

### The 12 failing tests and first errors

Suite `packing ignores every pnpmfile route (#63, ADR 0021, R3)`
(`scripts/release/pack-check.test.ts:724`):

1. `.npmrc pnpmfile`: `AssertionError: positive control: expected npmrc in undefined`
2. `.npmrc global-pnpmfile`: `positive control: expected npmrc-global in undefined`
3. `pnpm-workspace.yaml configDependencies pnpm-plugin-*`: `Command failed: pnpm pack --pack-destination …/plain` (stderr `ERR_PNPM_BAD_CONFIG_DEP`)
4. `pnpm-workspace.yaml configDependencies @pnpm/plugin-*`: same `ERR_PNPM_BAD_CONFIG_DEP`
5. `package.json pnpm.configDependencies pnpm-plugin-*`: `positive control: expected manifest-plugin in undefined`
6. `env npm_config_pnpmfile`: `positive control: expected env-plain in undefined`
7. `env npm_config_global-pnpmfile (dashed)`: `positive control: expected env-dashed in undefined`
8. `env npm_config_userconfig`: `positive control: expected userconfig in undefined`
9. `env npm_config_globalconfig`: `positive control: expected globalconfig in undefined`
10. `env XDG_CONFIG_HOME pnpm/rc`: `positive control: expected xdg in undefined`

Suite `pnpm run exports a configured pnpmfile to the guard (#63, A1)`:

11. `.npmrc pnpmfile`: `AssertionError: pnpm run exports npm_config_pnpmfile`
12. `pnpm-workspace.yaml pnpmfile`: `AssertionError: pnpm run exports npm_config_pnpmfile`

## Decisions
Decisions: none open. ADR 0021 stands unchanged: its consequence "a pnpm
upgrade that drops or renames the setting fails this test" becomes true for
every launch mode, not only `pnpm test`.

## Approach
Make the pnpm under test explicit and equal to the repo's pin, in the test
only:

1. **Pin the fixture.** The fixture's root `package.json` gets the repo root's
   `packageManager` value (read from `readManifest('.')`, never hard-coded).
   Through the corepack shim this selects the pinned pnpm from the corepack
   cache for both halves of every case; through `npm_execpath` it is the
   same pnpm that already runs, so pnpm's own version management does
   nothing. No network: verified offline in the container. The header comment
   ("No network: no packageManager field…") is rewritten to say why the field
   is now there and that the pinned version must be in the corepack cache (it
   is after `corepack enable` + `pnpm install`, as in RELEASING.md step 2).
2. **Fail clearly when the assumption does not hold.** A new first-level
   test in the route suite, next to `finds pnpm`: it runs
   `pnpm --version` with the fixture's `cwd` and scrubbed env (the exact
   resolution both halves use) and asserts it equals the version in the
   root `packageManager`. Message names both versions and the fix, e.g.
   `pnpm 12.23.0 runs the route fixtures, but the repo pins 10.28.0
   (packageManager); run through \`pnpm test\`, or \`corepack enable\` so the
   shim honours the fixture's packageManager`. This holds in and out of CI
   (a wrong pnpm is a wrong result either way); the existing R4 skip for
   "pnpm not found outside CI" is unchanged.

The ADR 0021 guard (`PACK_ARGS`, `packOne`, `packAll`, `checkNoPnpmfile`) and
`pnpmCommand()` are not touched. No test is skipped, deleted or loosened; the
positive controls keep asserting that each route is live.

### Alternatives rejected
- **Run the fixtures through `corepack pnpm@<pin>` / a test-only pnpm path.**
  `packOne` resolves pnpm itself (production code), so the guarded half would
  still use the shim; changing that means a test hook in production code.
- **Make `pnpmCommand()` verify the pnpm version.** Not needed for the bug
  (production always packs inside the repo, where the pin applies) and it
  widens the change into the release guard. Can be a follow-up if wanted.
- **Document "use `pnpm test`, not bare `node --test`".** Leaves the bare
  command (named in the test header and in #65's QA) red in the container.
- **Accept pnpm 12 behaviour in the positive controls.** That would test the
  guard against a pnpm the repo does not use and weaken R3.

## Files to modify
- `scripts/release/pack-check.test.ts`: fixture root manifest gets the root
  `packageManager`; new "runs the pinned pnpm" test in the route suite; header
  comment of the route section and of the file explain the pin and both
  launch modes.

No other file changes.

## Contracts
None (no API, message or script interface change).

Docker impact: none.

Docs impact: none outside the test file. RELEASING.md runs the tests through
`pnpm test`, which was and stays correct; the environment assumption is
documented in the test's header comment where it is relied on, and enforced
by the new version test.

## Risks / edge cases
- Corepack cache without the pinned pnpm and no network: the shim fails to
  fetch, `pnpm --version` throws, the version test (and the cases) fail with
  the corepack error. Same as any other offline pnpm use; RELEASING.md
  installs first.
- A global (non-corepack) pnpm of another version on PATH, bare `node --test`
  on Linux: pnpm 10 may try to switch to the pinned version; either way the
  version test fails with the clear message instead of 12 confusing ones.
- Windows host, bare `node --test`: unchanged; the two pnpm suites skip
  (R4, `pnpmCommand()` refuses a PATH lookup on win32 to avoid a shell). The
  103/103 on the host is through pnpm (`pnpm test`). See Questions.
- Future pnpm upgrade (the repo's pin moves to 11/12): the route tests will
  fail on the routes that pnpm no longer honours, and the A1 test will fail
  because `pnpm run` stops exporting `npm_config_pnpmfile`. That is the
  intended tripwire (ADR 0021 needs revisiting then), now visible in every
  launch mode. Observed here with pnpm 12.23.0.

## Security-sensitive areas
Security-sensitive: yes
- Release supply-chain guard verification (#63, ADR 0021 R3/R4, A1): the
  change edits the integration tests that prove `--config.ignore-pnpmfile=true`
  blocks every pnpmfile route. A wrong fix could make them pass without
  proving anything (for example a fixture where no route is live). No
  production code, dependency, secret or config changes.
- Required evidence: positive controls still assert each route is live;
  mutation (`PACK_ARGS` without the flag) still fails every route case.

Implementer model: opus
Security-sensitive plan (rule: never Sonnet); the code change is small (one test file) and fully specified here.

## Test plan
| AC | Check |
|---|---|
| Cause identified with names and first error | This document ("Root cause", the 12 tests); copied into the PR body |
| Fixed in the test, nothing skipped or deleted | Diff touches only `pack-check.test.ts`; test count rises 103 → 104 (the new version test); no `skip`/`todo` added |
| Container 103/103 (now 104/104) | Pinned `node:24`, `git bundle` clone, no bind mounts, `CI=true`, `corepack enable`, `pnpm install --frozen-lockfile`, then bare `node --test scripts/release/*.test.ts`: all pass. Also once with the container offline (`docker network disconnect bridge`) |
| Host still passes | Windows/Git Bash: `pnpm test` green; the release tests through pnpm 104/104; bare `node --test` unchanged (86 run, pnpm suites skipped) |
| Environment difference documented, clear failure | Header comment; temporarily drop the fixture `packageManager` in the container: the new version test fails with the message naming 12.23.0 vs 10.28.0 (revert) |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | All green on host and in the container |
| Guard not weakened (mutation) | In the container, `PACK_ARGS = ['pack']`: all 13 route cases and both `PACK_ARGS` tests fail (revert). Record counts in the PR |

Note: the AC says 103 of 103; with the new version test the count is 104.
QA should read the AC as "all tests pass".

## Implementation chunks
1. `test(release): pin route fixtures to the repo packageManager`
2. `test(release): fail clearly when fixtures run another pnpm`

(Docs impact: none, so no docs chunk.)

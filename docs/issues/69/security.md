# Security review (plan): #69 fix(release): check the pnpm version before packing

Mode: plan. Reviewed: [spec.md](spec.md), [architecture.md](architecture.md),
[ADR 0021](../../decisions/0021-pack-with-pnpmfiles-ignored.md), advisory L1
of `docs/issues/67/security.md` (on `main`), and the current
`scripts/release/lib.ts` (`pnpmCommand`, `run`, `PACK_ARGS`, `packOne`,
`packAll`), `pack-check.ts` (`packAndCheck`), `smoke.ts`.

The architect marked the plan `Security-sensitive: no`; the orchestrator
asked for this review because it closes advisory L1 and touches the
ADR 0021 packing path.

**Verdict: PASS.** No critical, high or medium findings. Two low advisories.

## Assets and trust boundaries
- **Asset:** the bytes of the three published tarballs (in particular the
  packed `package.json`, which a pnpmfile `beforePacking` hook could rewrite).
- **Control being hardened:** `PACK_ARGS` (`--config.ignore-pnpmfile=true`),
  whose effect ADR 0021 verified for pnpm 10.28.0 only; pnpm does not
  validate the setting, so another version could silently ignore it.
- **Trust boundary:** the release environment (repo checkout, PATH, env) is
  trusted. The threat is an *accidentally* wrong pnpm (L1: a global
  non-corepack pnpm of another version on Linux, outside `pnpm run`),
  combined with a pnpmfile route that slipped into the repo or user config.
- No network input, user data, secrets, auth or dependencies are involved.

## Threats (STRIDE, brief)
| Threat | Plan's answer |
|---|---|
| Tampering: a wrong pnpm ignores `--config.ignore-pnpmfile` and a hook rewrites the packed manifest | Exact version gate before any pack; fails closed |
| Tampering: the gate fails open (unparseable pin, empty output, reader error) | Parser throws on any non-matching pin; empty output is a mismatch; reader errors propagate |
| Tampering: the test seam is reachable in production and skips the gate | Seam is an optional function argument only; production callers pass nothing; packing itself is not injectable |
| Elevation: the new child process adds an execution path | Same `pnpmCommand()` + `run()` (argv array, no shell, inherited env) as `packOne`, `cwd = repoRoot` (trusted) |
| Spoofing: a hostile pnpm on PATH prints the pinned version | Out of scope: a hostile binary on PATH is inside the trust boundary and could do anything; the gate targets the accidental-wrong-version case (L1) |

## Analysis of the points asked
1. **Parsing / fail-open.** The regex is anchored at both ends
   (`^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.+)?$`), so ranges
   (`^10`), tags, other package managers, `pnpm@` and non-strings all throw.
   Build metadata (`+sha512...`) is stripped from the *expected* side only;
   an *actual* value carrying `+...` or any extra token does not equal
   group 1 and fails closed. Prerelease pins are accepted and must match
   exactly. `actual` is trimmed and compared with `===`; empty output, an
   update notice on stdout, or a non-zero exit (`run` throws) all stop the
   run. I found no input that makes the gate pass unless `pnpm --version`
   prints exactly the pinned version.
2. **Injection seam.** `PackAllOptions.pnpmVersion` mirrors the existing
   tests-only `env` seam of `packOne` (#63 R5). It is not wired to any env
   var, CLI flag or config; `pack-check.ts` and `smoke.ts` keep calling
   `packAll(dir)`. Only the version *reader* is injectable, so a caller
   using it still packs through `packOne` and `PACK_ARGS`. No weakening of
   production, provided control C3 holds.
3. **New execution risk.** None new. `pnpm --version` runs through the same
   resolver and `execFileSync` argv path as the pack child, keeps the
   Windows guard (`pnpmCommand()` throws on win32 outside `pnpm run`, so no
   `pnpm.cmd` and no shell), passes no `env`, and runs in `repoRoot`, the
   same trusted tree the pack already runs in. Running it in `repoRoot` is
   what makes a corepack shim (and pnpm 10's own
   `manage-package-manager-versions` switch) resolve the root pin, i.e. the
   same pnpm the pack children get.
4. **ADR 0021 guard.** `PACK_ARGS`, `packOne`, `run`, `checkNoPnpmfile`
   and their tests stay unchanged; `packAndCheck` still runs
   `checkNoPnpmfile` before `packAll`. The new gate only adds a
   precondition in front of the existing loop. The guard stays intact, and
   its untested-pnpm gap (option A cons) is narrowed to the pinned version.

## Findings
| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | architecture.md, Approach step 3 (`cwd` is `repoRoot`) vs `packOne` (`cwd = pkgDir`) | The version is read in `repoRoot`, but each pack runs in `packages/<x>`. Today no published package has a `packageManager` field, so a corepack shim resolves the root pin in both places. If one is ever added, the shim could pack with a different pnpm than the one checked. | Optional: in the new tests, assert that no `PUBLISHED` manifest has a `packageManager` field, which keeps the check and the pack on the same pin. Otherwise accept. |
| L2 | Low | architecture.md, "Error message (exact)" | The message interpolates the raw trimmed `pnpm --version` output. Multi-line or control-character output (an update banner on stdout, ANSI codes) would be echoed verbatim: harmless, but it can make the mismatch hard to read. | Optional: render `<actual>` with `JSON.stringify` or cap its length (for example 200 chars). |

No critical, high or medium findings.

## Required controls (part of the plan)
- **C1. Fail closed.** `pinnedPnpmVersion` throws on any value that does not
  match the anchored regex (no fallback to "skip the check", no major-only,
  prefix or `includes` compare). `checkPnpmVersion` uses exact equality
  after `trim()` only; empty output is a problem. Errors from the reader
  (`run` throwing) propagate; they are not caught and turned into a pass.
- **C2. Before any pack.** The pin parse, the version read and the compare
  are the first statements of `packAll`, before `PUBLISHED.map` / `packOne`.
  The reader is called exactly once per `packAll` call. The mismatch test
  asserts the destination directory stays empty.
- **C3. Narrow seam.** Only the version reader is injectable. Production
  callers (`pack-check.ts`, `smoke.ts`, and `dry-run.ts` through
  `packAndCheck`) pass no options; no env var, CLI flag or config value maps
  to `pnpmVersion`; no pack function or `PACK_ARGS` override is added.
- **C4. Same execution path.** The default reader is
  `run(pnpmCommand(), ['--version'], repoRoot)`: argv array, no shell, no
  `env` argument. `pnpmCommand()` and its Windows guard are unchanged.
- **C5. ADR 0021 untouched.** No change to `PACK_ARGS`, `packOne`, `run`,
  `checkNoPnpmfile`, or the order in `packAndCheck` (guard before
  `packAll`); existing tests and helpers in `pack-check.test.ts` unchanged.
- **C6. Expected value from the repo pin.** `expected` comes from
  `readManifest('.')['packageManager']` at run time, never from a version
  string hard-coded in `lib.ts`.

## What I will check in code mode
- C1 to C6 in the diff of `scripts/release/lib.ts`: regex anchors, `===`
  after `trim`, no `try/catch` around the reader, placement before the loop.
- No production caller passes a second argument to `packAll`.
- `git diff` shows no change to `PACK_ARGS`, `packOne`, `run`,
  `checkNoPnpmfile`, `pnpmCommand`, or to existing tests.
- New tests: the pin parser rejects `undefined`, `42`, `yarn@4.0.0`,
  `pnpm@`, `pnpm@^10`; a mismatch packs nothing; the reader is called once.
- The `RELEASING.md` sentence matches the behaviour.
- Scanners: gitleaks on the PR commits, semgrep on the changed files,
  `npm audit --audit-level=high` (no dependency change expected).

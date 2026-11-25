# Architecture: #69 fix(release): check the pnpm version before packing

Path: fast. Spec: [spec.md](spec.md). Background: security advisory L1 in
`docs/issues/67/security.md` (on `main`),
[ADR 0021](../../decisions/0021-pack-with-pnpmfiles-ignored.md).

## Repo layout

- Layout: `monorepo` (pnpm workspaces, `pnpm-workspace.yaml`; no submodules).
- Touched: the root release scripts only, `scripts/release/` (not a
  workspace package). Checks: root `pnpm lint`, `pnpm typecheck`
  (`tsc -p scripts`), `pnpm test` (`node --test "scripts/release/*.test.ts"`).
- No other repo is affected.

## Decisions

Decisions: none open. ADR 0021 stays as is (this closes the "untested pnpm"
gap in its option A cons; it does not change the decision).

## Approach

Before packing anything, `packAll` asks pnpm for its version once, through the
same `pnpmCommand()` + `run()` path that `packOne` uses, in `repoRoot`, and
throws unless it equals the version in the root `package.json`
`packageManager`. The check sits in `packAll` (used by `pack:check`,
`release:dry-run` via `packAndCheck`, and `smoke`), not in `packOne`, so it
runs once per release run and the ADR 0021 route tests, which call `packOne`
on throwaway fixtures, are untouched.

### The check (all in `scripts/release/lib.ts`)

1. `export function pinnedPnpmVersion(packageManager: unknown): string`
   (pure). Accepts only a string matching
   `^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.+)?$` and returns group 1
   (`pnpm@10.28.0+sha512.05df...` gives `10.28.0`). Anything else (missing,
   not a string, another package manager, no version, a range) throws:
   `root package.json packageManager must pin pnpm (pnpm@<version>[+<hash>]), got <JSON value> (#69)`.
   Fail closed: never fall back to "no check".
2. `export function checkPnpmVersion(actual: string, expected: string): string[]`
   (pure). Trims `actual`; returns `[]` on exact string equality, otherwise
   one problem (text below). Empty `actual` is a mismatch.
3. Default reader: `() => run(pnpmCommand(), ['--version'], repoRoot)`.
   `cwd` is `repoRoot` so a corepack shim resolves the root `packageManager`.
   No `env` argument: the child inherits the environment exactly like the
   production pack (#63 R5). `pnpmCommand()` keeps its Windows guard.
4. `packAll(dir: string, options: PackAllOptions = {})` with

   ```ts
   export interface PackAllOptions {
     /** Tests only (like `env`, #63 R5): returns the `pnpm --version` output. */
     pnpmVersion?: () => string;
   }
   ```

   First statements of `packAll`, before reading any package manifest or
   packing:

   ```ts
   const expected = pinnedPnpmVersion(readManifest('.')['packageManager']);
   const actual = (options.pnpmVersion ?? defaultPnpmVersion)();
   const problems = checkPnpmVersion(actual, expected);
   if (problems.length > 0) throw new Error(problems.join('; '));
   ```

   Then the existing `PUBLISHED.map(...)` loop, unchanged. Only the version
   reader is injectable; packing itself is not, so no seam can bypass
   `PACK_ARGS`. Production callers (`pack-check.ts`, `smoke.ts`) keep calling
   `packAll(dir)` with no options and are not changed. A thrown error
   propagates like the existing `pnpm pack did not write ...` error: the
   script exits non-zero before any tarball exists.

### Error message (exact)

```text
pnpm <actual> would pack the release, but the repo pins pnpm <expected> (packageManager in package.json); run through pnpm (for example `pnpm pack:check`) with corepack enabled (#69, ADR 0021)
```

`<actual>` is the trimmed output, or `(no output)` when it is empty.

### Alternatives rejected

- Check in `packOne`: runs per package (the spec says once) and would change
  the route tests' code path (spec: guard tests unchanged).
- Compare the major only: the pin is exact, and ADR 0021's integration test
  proves `--config.ignore-pnpmfile` for that exact version only.
- Make the pack function injectable too: an easier match test, but it adds a
  seam that could skip `PACK_ARGS`; rejected to keep the guard narrow.
- Reuse the test helper `pinnedPackageManager()` from `pack-check.test.ts`:
  it lives in the test file, which keeps its existing helpers unchanged
  (AC 3); the lib gets its own parser.

## Files to change

- `scripts/release/lib.ts`: add `pinnedPnpmVersion`, `checkPnpmVersion`,
  `PackAllOptions` and the default reader; call the check at the top of
  `packAll`; extend the `packAll` doc comment (#69, L1).
- `scripts/release/pack-check.test.ts`: new `describe` blocks (below); the
  header comment gains `#69`. Existing tests and helpers unchanged.
- `RELEASING.md`: one sentence in the ADR 0021 bullet (around line 547).

Data model: none. Contracts (API/realtime): none. Docker impact: none.

## Test plan (AC mapping)

New tests in `scripts/release/pack-check.test.ts`:

- `pinnedPnpmVersion` (unit, no pnpm): `pnpm@10.28.0+sha512.abc` gives
  `10.28.0`; `pnpm@10.28.0` gives `10.28.0`; throws on `undefined`, `42`,
  `yarn@4.0.0`, `pnpm@`, `pnpm@^10`; parses the real root value
  (`readManifest('.')`).
- `checkPnpmVersion` (unit): equal gives `[]`; `'10.28.0\n'` vs `10.28.0`
  gives `[]`; `9.15.0` vs `10.28.0` gives one problem naming both versions,
  `packageManager` and `#69`; `''` gives a problem with `(no output)`.
- AC 2, mismatch: `packAll(tmp, { pnpmVersion: () => '9.15.0' })` throws an
  error whose message contains `9.15.0` and the pinned version; the reader is
  called exactly once; `readdirSync(tmp)` is empty (nothing packed). No pnpm
  needed.
- AC 1, once: a counting reader asserts one call in both the mismatch and the
  match case.
- AC 2, match: `packAll(tmp, { pnpmVersion: () => <pinned version> })`
  returns the three `tarballName(...)` files and they exist in `tmp`; reader
  called once. This test really packs, so it uses the same skip condition as
  the route tests (`skipRoutes`: skips only when pnpm is absent and
  `CI !== 'true'`). If `pnpm pack` fails without a built `dist` in the
  engineer's run, report it rather than adding a pack seam.
- AC 3: all existing tests pass unchanged, including the ADR 0021 route tests
  and the `pnpm run` export tests; `PACK_ARGS`, `packOne` and
  `checkNoPnpmfile` untouched.
- Manual: `pnpm pack:check` passes on the pinned pnpm (default reader path).

## Docs impact

- `RELEASING.md`: in the ADR 0021 bullet, add that `pack:check`,
  `release:dry-run` and `smoke` first check that `pnpm --version` equals the
  root `packageManager` version, and stop before packing otherwise (#69).
- Not touched: `docs/roadmap.md` (per instructions), ADR 0021 (accepted;
  decision unchanged), `docs/conventions.md` (already says pnpm via
  `packageManager`).

## Risks / edge cases

- Corepack shim on PATH outside `pnpm run`: `cwd = repoRoot` makes it honour
  the root pin, so the check passes and packs with the pinned pnpm.
- Global pnpm of another version on PATH (the L1 case): fails closed with the
  message above. Intended.
- Extra output from `pnpm --version` (for example an update notice) would
  fail the exact compare; that fails closed, which is safe.
- Prerelease pins (`pnpm@11.0.0-rc.1`) are accepted by the regex.

## Security

Security-sensitive: no

None of the listed areas is touched (no auth, endpoints, user input, user
data, secrets, crypto or dependencies). It hardens the release build (closes
advisory L1) by adding a fail-closed precondition only; `PACK_ARGS`,
`checkNoPnpmfile` and `packOne` do not change. The security code review in
validation still covers it.

## Implementer model

Implementer model: sonnet

One source file plus `RELEASING.md`, no dependencies, contracts or ADRs, fully
specified, and it follows existing patterns (the #67 version test and
`pinnedPackageManager()` in `scripts/release/pack-check.test.ts`, the
tests-only `env` seam of `packOne` in `scripts/release/lib.ts`).

## Implementation chunks

1. `fix(release): check the pnpm version before packing` (`lib.ts`)
2. `test(release): cover the pnpm version check in packAll`
   (`pack-check.test.ts`)
3. `docs(release): note the pnpm version check in RELEASING.md`

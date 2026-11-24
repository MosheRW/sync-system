# Security review (plan): #67 pnpmfile route tests fail in the node:24 CI container

Mode: plan. Branch: `fix/67-pnpmfile-tests-container`. PR: #68 (draft).
Reviewed: `spec.md`, `architecture.md`, ADR 0021, `docs/issues/63/security.md`
(R1-R7), `scripts/release/pack-check.test.ts` (route and A1 suites),
`scripts/release/lib.ts` (`pnpmCommand`, `packOne`, `packAll`), root
`package.json` (`packageManager`), `RELEASING.md` (container procedure).

**Verdict: PASS** (0 critical, 0 high, 0 medium, 2 low).

## Assets and trust boundaries
- **Asset:** the evidence that `--config.ignore-pnpmfile=true` (ADR 0021,
  `PACK_ARGS`) keeps every pnpmfile route from rewriting the packed
  tarballs. The tests are the tripwire for a pnpm upgrade that drops or
  renames the setting (ADR 0021, Consequences).
- **Asset:** the pnpm binary used by tests and by production packing,
  pinned by the root `packageManager` (`pnpm@10.28.0+sha512.<hash>`).
- **Boundary:** the corepack shim / `npm_execpath` resolution, which decides
  which pnpm runs; the npm registry (corepack download when not cached);
  the throwaway fixture under `os.tmpdir()`.
- Out of the boundary: no production code, dependency, secret, config,
  Docker or CI change.

## Threats
| STRIDE | Who / what | Concern | Assessment |
|---|---|---|---|
| Tampering (of evidence) | A fix that makes positive controls pass without the route being live, or the guarded half not run | Green tests that prove nothing; ADR 0021 tripwire silenced | Not the case: positive controls still require the hook marker in the plain pack, `packOne` / `PACK_ARGS` untouched, mutation verified (15 fail) |
| Tampering (supply chain) | Registry / network attacker serving a modified pnpm when corepack fetches the pin for the fixture | Malicious pnpm runs in the test process | Mitigated if the field is copied verbatim: corepack verifies the `+sha512` in `packageManager` (same control RELEASING.md relies on). See C1 |
| Repudiation / silent drift | pnpm version under test differs from the pin | Tests exercise a pnpm the release does not use (the actual bug) | Fixed by the pin plus the new version test (C2) |
| Elevation | Fixture content | Fixture hooks run in pnpm (by design, positive control) | Unchanged from #63; fixture lives in a `mkdtemp` dir and is removed in `finally` |
| Info disclosure | Version test output | Could echo env | Message names versions only (C2) |

## Independent checks of the plan's claims
1. **Root cause is environmental, not a guard bug.** Consistent with the code:
   `pnpmCommand()` returns bare `pnpm` when `npm_execpath` is unset (Linux),
   and the fixture's root manifest (`buildFixture`, `rootManifest`) has no
   `packageManager`, so the corepack shim uses its own default. All 12
   failures are positive-control or A1 export assertions (the "route is
   live" half), never the guarded half; the guarded assertion
   (`hookedBy(guarded) === undefined`) never passed vacuously because the
   control asserts first.
2. **The change does not weaken the guard.** The plan edits only the fixture
   manifest and adds a test. Positive controls keep
   `control.includes(route.label)`; `packOne`, `PACK_ARGS`, `packAll`,
   `checkNoPnpmfile`, `pnpmCommand` stay unchanged. Pinning makes the tests
   *more* faithful: they now exercise the pnpm production uses in every
   launch mode. Positive controls cannot pass vacuously: a not-live route
   fails the control, it does not skip.
3. **The mutation check still bites.** The architect's container run with
   `PACK_ARGS = ['pack']` failed all 13 route cases and both `PACK_ARGS`
   tests. Required again on the final code (C4).
4. **Network / supply chain.** The root value carries
   `+sha512.<hash>`; corepack checks the download against it (RELEASING.md
   line ~217 relies on the same property). Copying the full field into the
   fixture therefore adds no new trust: it is the same pinned, hashed
   artifact already fetched by `corepack enable` + `pnpm install` for the
   repo. Through `npm_execpath`, pnpm 10 sees its own version pinned and
   does not switch. Verified offline in the container (103/103). No new
   registry, URL or package.
5. **Production packing unaffected.** `packAll` calls `packOne` with `cwd`
   `join(repoRoot, pkg.dir)`; corepack walks up past the package manifests
   (no `packageManager`) to the repo root pin, and the architect observed
   `pnpm --version` = 10.28.0 in `/src`. `RELEASING.md` runs everything
   through `pnpm ...`, so `npm_execpath` is the pinned pnpm. Claim holds.
   Residual (pre-existing, not introduced here): production does not itself
   verify the pnpm version (L1).

## Findings
| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | `scripts/release/lib.ts:304-369` (`pnpmCommand`, `packOne`), pre-existing | Production packing trusts that the resolved pnpm is the pin. A release run on Linux with a non-corepack global pnpm of another major on PATH, outside `pnpm run`, would pack with a pnpm whose handling of `--config.ignore-pnpmfile` is untested (the setting is unvalidated, ADR 0021 option A cons). Needs a wrong build environment plus a malicious pnpmfile in the repo, both inside the release trust boundary. | Follow-up issue (architect rejected it as scope creep here, which is fine): in `packAll`, run `pnpm --version` once and fail closed unless it equals the root `packageManager` version. |
| L2 | Low | Plan, Approach 1 ("read from `readManifest('.')`") | If the implementation copies only `pnpm@10.28.0` (e.g. after parsing the version for the new test) instead of the full value, a corepack download for the fixture would run without the integrity hash check. | Covered by C1: copy the field verbatim, hash included. |

No critical, high or medium findings.

## Required controls (part of the plan)
- **C1. Verbatim pin.** The fixture root `package.json` gets the root
  `packageManager` string unchanged (including `+sha512.<hash>`), read from
  the root manifest at test time, never hard-coded. If the root field is
  missing or does not start with `pnpm@`, the suite fails (throws), it does
  not skip and does not fall back to no field.
- **C2. Version test uses the real resolution path.** The new test builds its
  fixture with the same `buildFixture` (so it cannot drift from the cases),
  runs `PNPM` (the same `pnpmCommand()` result) with `--version`, with the
  fixture's `pkgDir` as `cwd` and the same `scrubbedEnv`, and compares it
  to the version parsed from the root `packageManager` (between `pnpm@` and
  `+`). It runs under the existing `skipRoutes` only (no new skip
  condition, nothing keyed on the pnpm version) and fails under `CI=true`.
  Its message names both versions and the remedy, never env values.
- **C3. Guard and controls untouched.** No change to `PACK_ARGS`, `packOne`,
  `packAll`, `checkNoPnpmfile`, `pnpmCommand`, `scrubbedEnv`, or to the
  positive-control / guarded assertions; no `skip`/`todo`/conditional on pnpm
  version inside a route or A1 case; the route-specific `rootManifest`
  edits (`pnpm.configDependencies`) keep the pinned field.
- **C4. Evidence in the PR** (on the final code, in the pinned container,
  bare `node --test` after `corepack enable`, `CI=true`):
  all tests pass; offline run passes; mutation `PACK_ARGS = ['pack']` fails
  every route case and both `PACK_ARGS` tests (counts recorded); removing
  the fixture pin fails the version test with the clear message.
- **C5. No integrity weakening.** The tests set no `COREPACK_*` override
  (`COREPACK_INTEGRITY_KEYS`, `COREPACK_NPM_REGISTRY`, ...) and add no
  network fetch of their own.

## Checks in code mode
- Diff touches only `scripts/release/pack-check.test.ts` (plus docs/STATE).
- C1-C5 as above, line by line; header comment updated and accurate.
- gitleaks on the PR commits, semgrep on the changed file, `npm audit
  --audit-level=high` (lockfile unchanged, so high/critical only).
- QA's container evidence (or the PR body) shows C4's counts.

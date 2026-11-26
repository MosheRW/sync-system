# Architecture: #101 fix: release-files test fails on reader release section mktemp (L11)

Path: fast. Spec: [spec.md](spec.md).

## Repo layout
`single` workspace repo (no submodules). Touched package: `apps/sync-server`
(test only). Checks: `pnpm --filter ./apps/sync-server test` (vitest),
`pnpm lint`, `pnpm typecheck`.

## Cause (confirmed)
`npx vitest run test/release-files.test.ts` on this branch: 1 failed / 78
passed. The only failure is line 449,
`expect(doc).not.toContain('export IMG="$(mktemp -d)"')`, which matches the
reader setup line `export IMG="$(mktemp -d)"` (RELEASING.md ~676).

History: #81 (PR #84) moved the **package** Phase B to the fixed folder
`$HOME/sync-release-$V` and wrote that assertion over the whole doc, when
the doc had no reader section. #77 (PR #79) added the reader section with
`mktemp -d` folders and merged after #84. Each PR was green alone; the
combination is red. Neither PR was wrong at the time it was written.

## Decision: the test is too broad (Option B)
`Decisions: none open` (no ADR: test-only change, no new choice).

Why the test, not the doc:
- The L11 property in ADR 0017 is "outside the working copy, in a
  `mktemp -d` directory". #81 replaced `mktemp` with a fixed folder **only
  for the package Phase B**, and only to let a long, multi-terminal,
  token-bearing release resume (#81 AC4). #81's architecture names the
  package steps 2, 4, 6, 8 and the dry run; the reader is mentioned only as
  a future text conflict. The fixed-folder rationale was never applied to
  the reader.
- The reader section was security-reviewed (#77 `security.md`) with `mktemp`
  folders. Its safety net does not need resume: R4 requires `$IMG/checked`
  written by R3 for `RM`; a new terminal loses `IMG` and R4 refuses, so the
  failure is safe (re-run R3).
- No other test depends on the reader's REL/IMG shape. The
  `[ "$IMG" = "${REL:-}/image" ]` guard exists only in package step 6; the
  reader R3/R4 use `D="$IMG"` with no such guard, and R2 runs the step 2
  block, which only needs `REL` to be a writable folder.
- Option A (fixed `$HOME/sync-reader-release-$RV`) would need a symlink
  guard, `chmod 700`, an `IMG="$REL/image"` change, a guarded R6 cleanup, a
  resume note for `RV`/`RM`, and a new security look: a feature, not a test
  fix, and it edits the reader section that #100 is editing concurrently.
  If the user wants reader resume, it is a separate issue.

## Approach
In `apps/sync-server/test/release-files.test.ts` only:
1. L11 test (~line 449): apply the `not.toContain('export IMG="$(mktemp -d)"')`
   check to the doc **without** the `## Reader image release` section
   (slice it out: from `\n## Reader image release\n` to the next `\n## `;
   assert the heading is found so a rename can't make the check vacuous).
   Every other assertion of that test stays as is (package setup lines,
   symlink guard, `chmod 700`, dry run `REL="$(mktemp -d)"` /
   `IMG="$REL/image"`, step 8 guarded `rm -rf "$REL"`). No weakening of the
   package rules: the package section and the package dry run are still
   scanned.
2. Reader describe block: add one `it` that pins the reader's chosen shape,
   so the choice is explicit rather than an accidental exemption:
   - reader setup contains `export REL="$(mktemp -d)"` and
     `export IMG="$(mktemp -d)"` (outside the repo, spec AC4);
   - `R6. After the reader release` contains `rm -rf "$IMG" "$REL"`;
   - `Reader dry run (QA)` contains `IMG="$(mktemp -d)"` and `rm -rf "$IMG"`.
   Use the describe's existing `reader` and `sub()` helpers.

No change to `RELEASING.md`. Zero overlap with #82, #90, #100.

## Files
- `apps/sync-server/test/release-files.test.ts`: scope the L11 mktemp ban
  to the non-reader doc; add a reader REL/IMG/cleanup test.

Data model: none. Contracts: none. `Docker impact: none`.
`Docs impact: none` (test-only; RELEASING.md already describes the reader
flow correctly).

## Risks / edge cases
- Spec AC5 says the reader cleanup is "guarded". The reader cleanup is the
  existing R6 checklist `rm -rf "$IMG" "$REL"` of two `mktemp -d` folders,
  as approved in #77 security review; the package `L3` guard (#81) exists
  because the package folder is a **predictable** `$HOME` path. This plan
  reads AC5 as "cleanup removes exactly what setup creates" and does not add
  a guard (that would mean editing the reader section). Flagged for Gate 2.
- If a concurrent PR (#100) renames reader headings, the new test's
  `sub()` lookups would fail loudly, not pass silently. Acceptable.

## Security-sensitive areas
Security-sensitive: no
Test-only change; no auth, input, data, secrets, crypto or dependency
change. The release procedure text is unchanged.

## Implementer model
Implementer model: sonnet
One test file, no open decision, follows the existing assertions in the same
file (`release-files.test.ts` L11 test and reader `describe`).

## Test plan
- AC1: `npx vitest run test/release-files.test.ts` in `apps/sync-server`:
  0 failures (was 1).
- AC2: full `pnpm --filter ./apps/sync-server test`, plus `pnpm lint` and
  `pnpm typecheck`.
- AC3: `git diff main --stat` lists only the test file (and docs/issues/101).
- AC4/AC5: covered by the new reader test (mktemp setup, cleanup of both
  folders, dry run uses and removes its own `IMG`).
- AC6: the package assertions in the L11 test are unchanged; sanity check by
  temporarily adding `export IMG="$(mktemp -d)"` to package Phase B locally:
  the L11 test must fail (do not commit).

## Implementation chunks
1. `test(release): scope the L11 mktemp ban to the package release`
   (scoped assertion + new reader REL/IMG/cleanup test, one file)

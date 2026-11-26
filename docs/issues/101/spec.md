# Spec: #101 fix: release-files test fails on reader release section mktemp (L11)

Issue: https://github.com/MosheRW/sync-system/issues/101

## Problem
`apps/sync-server/test/release-files.test.ts`, test "keeps bundles and outputs outside the repo in a fixed per-version folder (L11, #81)", fails on origin/main (confirmed by QA on PR #95 / issue #92 on clean main ed8a9d7).

Its assertion `expect(doc).not.toContain('export IMG="$(mktemp -d)"')` scans the whole `RELEASING.md`. The reader release section (added by #77, PR #79) has, in its shell-setup block (~lines 675-676):
```
export REL="$(mktemp -d)"      # outside the repo: R2's bundle and outputs
export IMG="$(mktemp -d)"      # outside the repo: the fresh clone of R3 and R4
```
The package release uses a fixed per-version folder (`$HOME/sync-release-$V`); the reader section does not. Either the doc or the test is wrong.

## Acceptance criteria
- [ ] The test "keeps bundles and outputs outside the repo in a fixed per-version folder (L11, #81)" passes on the branch.
- [ ] The full sync-server test suite passes.
- [ ] The change is limited to the reader release section of `RELEASING.md` and/or `apps/sync-server/test/release-files.test.ts`. No edits to other RELEASING.md sections (other sessions: #82 step 6, #90 guards, #100 reader R2 wording).
- [ ] Whatever the reader section ends up using for its bundle/output/clone locations stays outside the repo.
- [ ] The reader section is consistent with the reader dry-run and its cleanup step (same variables/paths, cleanup removes what setup creates, guarded).
- [ ] Whichever side is changed, the test still guards the package release section's fixed-folder rules (no weakening of the package-release assertions).

## Out of scope
- Other RELEASING.md sections and other open release-doc issues (#82, #90, #100).
- Changing the package release flow.

## Open questions (for the architect)
- Which side is wrong? Option A: the doc; the reader section should use a fixed per-version folder like the package release (e.g. `$HOME/sync-reader-release-$RV`). Option B: the test; scope the `not.toContain` assertion to the package release section. Acceptance criteria are phrased so either satisfies them.

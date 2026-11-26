# Architecture: #88 fail the .npmrc _authToken guard when a tracked .npmrc is missing

Layout: monorepo (pnpm workspace: `apps/*`, `packages/*`), one branch, one PR. Only `apps/sync-server` is touched. Checks: `pnpm --filter @mosherw/sync-system-server test`, plus `lint` and `typecheck`.
Decisions: none open. Docker impact: none. Docs impact: none.
Security-sensitive: no. Reason: test-only change that strengthens a credentials guard. No runtime code, endpoint, dependency, schema or config change.
Implementer model: sonnet. Reason: one test file, test-only, follows the existing `beforeAll` pattern in the same file, no contracts or open decisions.

## Approach
In the `no credentials or old names in tracked files` describe of `apps/sync-server/test/release-files.test.ts`, the `beforeAll` calls `trackedFiles()` once, then filters with `existsSync`. Keep that single scan. In the same `beforeAll`, before the filter, derive `missingNpmrcs`: tracked paths matching `/(^|\/)\.npmrc$/` that fail `existsSync`. This reuses the one `trackedFiles()` list and adds no file reads (only `existsSync` on `.npmrc` paths).

In the L6 test, first assert `expect(missingNpmrcs, 'tracked .npmrc missing on disk ...').toEqual([])`, then run the existing `_authToken` loop unchanged. The message names the paths so the failure is clear.

Rejected: removing the `existsSync` filter for all files. This would change the other checks (they would fail on any tracked-but-missing file), so it is out of scope and risks other behaviour. Rejected: a second `git ls-files` call (duplicate work, against the #78 goal).

## Files to modify
- `apps/sync-server/test/release-files.test.ts`: add `missingNpmrcs` computed in the shared `beforeAll`; add the missing-file assertion at the top of the L6 test. Nothing else changes.

## Contracts / data model
None.

## Risks
- Currently no `.npmrc` is tracked (`git ls-files | grep npmrc` is empty), so the new assertion passes trivially today. It only matters if one is tracked later.
- A tracked file deleted in a working tree (unstaged deletion) now fails L6 only if it is a `.npmrc`. This is intended.

## Test plan (maps to acceptance criteria)
- AC1 (every tracked .npmrc checked) and AC3 (single shared scan): code review of the diff, with the `_authToken` loop and `beforeAll` scan unchanged apart from `missingNpmrcs`. Run the full sync-server suite: green.
- AC2 and AC5 (negative check, local only, not committed): no tracked `.npmrc` exists, so create one temporarily: `echo "registry=https://example.invalid" > .npmrc && git add -N .npmrc` (intent-to-add makes it tracked by `git ls-files`), then `rm .npmrc`. Run the test and confirm L6 fails with the message listing `.npmrc`. Also confirm that with the file present and containing `_authToken`, it fails as before. Then run `git rm --cached .npmrc` (or `git reset .npmrc`) to revert, confirm `git status` is clean, and rerun to see green.
- AC4: diff review, no other test or filter touched.

## Implementation chunks
1. `test(sync-server): fail npmrc guard when a tracked .npmrc is missing` (the change above). The negative check is done before committing and reverted; nothing from it is committed.

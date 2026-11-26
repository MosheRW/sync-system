# Spec: #88 test(sync-server): fail the .npmrc _authToken guard when a tracked .npmrc is missing

Issue: https://github.com/MosheRW/sync-system/issues/88
Follow-up to #78 / PR #83 (security advisory L1)

## Problem
In `apps/sync-server/test/release-files.test.ts`, the shared `beforeAll` scan (from #78) filters tracked files with `existsSync`. The `.npmrc` `_authToken` check ("has no tracked .npmrc with an auth token (L6)") inherits that filter, so a `.npmrc` that git tracks but is missing on disk is silently skipped. Before #78 it failed with ENOENT. Clean checkouts are unaffected, but the guard is weaker.

## Acceptance criteria
- [ ] Every tracked `.npmrc` is checked for `_authToken`.
- [ ] A tracked `.npmrc` that is missing on disk makes the test fail with a clear message instead of being skipped.
- [ ] The single shared scan from #78 is kept (no performance regression under load).
- [ ] No other check in `release-files.test.ts` is weakened.
- [ ] A negative check shows the new failure path works; done locally, reverted, not committed.

## Out of scope
- Changes to other tests or files (including #80's files).
- Changing how other tracked files are scanned.

## Open questions
- None.

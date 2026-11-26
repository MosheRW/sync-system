# State: #88 test(sync-server): fail the .npmrc _authToken guard when a tracked .npmrc is missing
- Path: fast
- Phase: validation
- Branch: test/88-npmrc-guard-missing-file
- PR: #89
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 2
- Last updated by: qa
## Model log
- qa review round 2: opus (rule: round 2) → PASS
- engineer fix: opus (rule: fix round) → DONE
- security code: opus (rule) → PASS (L1 closed; 1 low advisory, pre-existing: L6 regex misses legacy _auth=/_password= keys)
- qa review: sonnet (NEXT_MODEL from engineer) → PASS
- engineer implement: sonnet (architect Implementer model) → DONE
- architect plan: sonnet (NEXT_MODEL from pm) → DONE
- pm grooming: sonnet (default) → DONE
## Open questions
- none
## Deviations from plan
- User-approved scope addition (Gate 3, "fix it now"): security round 1 low
  advisory, pre-existing. The L6 guard matched only `_authToken`; it now uses
  the named constant `NPMRC_CREDENTIAL`
  (`/_authToken|(?:^|[\s:])(?:_auth|_password)\s*=/m`), which also catches the
  legacy `_auth` and `_password` keys, bare or scoped (`//host/:key=`), with
  optional whitespace before `=`. `_auth` only matches as a whole key followed
  by `=`, not through `_authToken`. Test title and messages now say
  "credential" (L6 tag kept). Shared single scan and missing-.npmrc assertion
  unchanged.
## Negative check (local only, not committed)
- Tracked-but-deleted `.npmrc` (`git add -N` then `rm`): L6 FAILED with `tracked .npmrc missing on disk, cannot check it for _authToken: .npmrc: expected [ '.npmrc' ] to deeply equal []`.
- Present `.npmrc` containing `_authToken=x`: L6 still FAILED (`.npmrc: expected '//r/:_authToken=x
' not to match /_authToken/`).
- Reverted (`git rm --cached`), `git status` showed only the test file; release-files test green (61/61).
- Full `pnpm test` from root: green (sync-server 1845 passed, 249 skipped; no flaky failures). eslint, prettier and sync-server typecheck pass.
## Negative check, fix round (local only, not committed)
- Tracked `.npmrc` (`git add -N`) with `_authToken=x`, `_auth=x`,
  `//registry.npmjs.org/:_password=x`, `_auth = x`: L6 FAILED each time
  (`.npmrc contains an npm credential key: expected ... not to match ...`).
- Benign `.npmrc` (`registry=https://example.invalid`, `always-auth=true`): L6 passed.
- Tracked-but-missing `.npmrc`: L6 FAILED (`tracked .npmrc missing on disk,
  cannot check it for credentials: .npmrc`).
- Reverted; `git status` showed only the test file. release-files test green
  (61/61); sync-server typecheck, eslint and prettier pass.
- Full `pnpm test` from root: green (exit 0; sync-server 1845 passed, 249 skipped).

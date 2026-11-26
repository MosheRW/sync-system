# State: #88 test(sync-server): fail the .npmrc _authToken guard when a tracked .npmrc is missing
- Path: fast
- Phase: validation
- Branch: test/88-npmrc-guard-missing-file
- PR: #89
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 0
- Last updated by: engineer
## Model log
- engineer implement: sonnet (architect Implementer model) → DONE
- architect plan: sonnet (NEXT_MODEL from pm) → DONE
- pm grooming: sonnet (default) → DONE
## Open questions
- none
## Deviations from plan
- none
## Negative check (local only, not committed)
- Tracked-but-deleted `.npmrc` (`git add -N` then `rm`): L6 FAILED with `tracked .npmrc missing on disk, cannot check it for _authToken: .npmrc: expected [ '.npmrc' ] to deeply equal []`.
- Present `.npmrc` containing `_authToken=x`: L6 still FAILED (`.npmrc: expected '//r/:_authToken=x
' not to match /_authToken/`).
- Reverted (`git rm --cached`), `git status` showed only the test file; release-files test green (61/61).
- Full `pnpm test` from root: green (sync-server 1845 passed, 249 skipped; no flaky failures). eslint, prettier and sync-server typecheck pass.

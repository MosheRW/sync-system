# State: #81 fix: RELEASING.md lessons from the 1.0.0 release
- Path: fast
- Phase: implementation
- Branch: fix/81-releasing-procedure-lessons
- PR: #84
- Plan approved by user: yes (Gate 2, 2026-11-25)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus → DONE
- security plan: opus (rule) → PASS (0 critical, 0 high, 4 medium, 6 low; see security.md)
- engineer implement: opus (rule: security-sensitive, Implementer model) → DONE
## Gate 2 decisions (2026-11-25)
1. Implement architecture.md chunks 1-3 and security required controls R1-R8.
2. Apply medium advisories M1-M4 and low advisories L1-L6 in this PR (M3 only if Docker's documentation confirms the `dckr_pat_` prefix).
3. F6 wording must hold whether or not Docker Desktop stayed signed in after the 1.0.0 push; revoking both registry tokens is the mandatory control (M1).
## Open questions
- none
## Deviations from plan
- M3 skipped: Docker's documentation (personal access tokens, organization access tokens, token reference, and the full docs text at docs.docker.com/llms-full.txt, checked 2026-11-25) states no `dckr_pat_` prefix, so the Docker Hub prompt has no prefix check (a guessed prefix could block a valid token). Revoking both tokens stays the control.
- Verify block placed in step 5 ("Revoke the npm token, then verify the registry"), after the revocation, instead of at the end of step 4: this is how M2 (revoke before verify) is met. The L8 test now looks for `dist.integrity` in step 5 and asserts it is gone from step 4.
- Verify compares only the stdout of `npm view` (stderr goes to `$REL/verify-stderr.txt`, read only for `E404`), so an npm notice can never look like a differing value. Verify must print three `ok` lines before step 6 (M2 said before step 7; step 6 is stricter).
- Step 8 removal is a small guarded block (`[[ "${REL:-}" == "$HOME"/sync-release-[0-9]* ]]`, L3) instead of a one-line command; the Phase B setup also unsets `M` along with `REF MODE SRC_URL` (L4), since a dry run exports `M` too.
- Step 1 prose asks to note `M` in the release notes draft, so the resume section has something to compare against.
- docs/roadmap.md: widening the item 9 cell makes prettier re-pad every row of the table (whitespace only); the text edits are only the item 9 row, the #65 line's "#67 is open" phrase and the #67 line.
- Local CI ran through the step 2 block itself with `MODE=dry-run` (bundle clone with `.git`, no bind mount, `redis:7.2.17-alpine` sidecar with `--requirepass`, `CI=true`, `SYNC_TEST_REDIS_URL`), the plan's documented alternative. As committed, `pnpm lint` runs out of heap in ESLint (V8 default ~1 GB; the Docker VM has 2 GB). It does the same on the host at 1 GB, and also with the pre-#81 test file, so it was there before this branch. The passing run added only `-e NODE_OPTIONS=--max-old-space-size=1900` to the build container (not committed): audit, lint, typecheck, test (all suites, Redis included), build and smoke green. `release:dry-run` then stops at `npm publish --dry-run` with "You cannot publish over the previously published versions: 1.0.0". That is expected: 1.0.0 is already on npm, so it is not a failure of this branch. The packed protocol tarball's integrity equals the published one. Follow-ups for the orchestrator: the ESLint heap on 2 GB engines, and `release:dry-run` on an already-published version.

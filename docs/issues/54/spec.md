# Spec: #54 fix(ci): repo-hygiene CI trigger test blocks pnpm test in the release procedure

Issue: https://github.com/MosheRW/sync-system/issues/54 (follow-up to #37, PR #50). Path: fast.

## Problem
The repo-hygiene test "CI workflow runs on push and pull_request" (`apps/sync-server/test/repo-hygiene.test.ts`) fails on main. GitHub Actions is billing-blocked, so the workflow's push and pull_request triggers are commented out (checks that fail in about 3 seconds mean the job never started). The failure stops `RELEASING.md` step 2 at `pnpm test`, so the real 1.0.0 release cannot run cleanly. This blocks the release, not the merge of PR #50 (already merged).

## Acceptance criteria
- [ ] `pnpm test` passes on main, or `RELEASING.md` step 2 handles the blocked-Actions state explicitly (documented, not silently skipped).
- [ ] If the workflow triggers are restored, the test passes against them.
- [ ] If the test is changed, it still guards the CI workflow when Actions is available.
- [ ] A dry run of `RELEASING.md` steps 1-2 completes without a manual workaround.

## Choice for the architect (decided by the user at Gate 2)
- Option A: restore the workflow triggers (needs Actions available; billing is out of scope).
- Option B: make the test and `RELEASING.md` handle the blocked-Actions state (for example, the test accepts a documented blocked marker, and step 2 documents it).

## Out of scope
- Resolving the GitHub billing issue itself.

## Open questions
- None for grooming; the A vs B choice is for Gate 2.

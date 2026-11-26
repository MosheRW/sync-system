# Spec: #92 fix(release): release:dry-run cannot run for an already-published version

Issue: https://github.com/MosheRW/sync-system/issues/92 (follow-up to #81, PR #84)

## Problem
`release:dry-run` stops at `npm publish --dry-run` with "You cannot publish over the previously published versions" once the version is on npm, so the step 2 dry-run block of RELEASING.md cannot be re-run after a release.

## Acceptance criteria
- [ ] `release:dry-run` succeeds for an already-published version whose tarball matches the registry.
- [ ] It fails if the local tarball integrity differs from the published one.
- [ ] Behaviour for an unpublished version is unchanged.
- [ ] A test covers the already-published case.

## Out of scope
- Changes to RELEASING.md beyond the step 2 dry-run text (step 6 is edited by another session).
- Changes to `docs/roadmap.md`.
- Changes to the actual publish flow.

## Relevant code
`scripts/release/dry-run.ts`, `lib.ts`, `pack-check.ts` and tests in `scripts/release/*.test.ts`.

## Open questions
- none

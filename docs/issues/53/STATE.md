# State: #53 chore(release): investigate react tarball hash differences across node:24 images
- Path: fast
- Phase: architecture (revised after QA r1 FAIL)
- Branch: chore/53-react-tarball-hash
- PR: #62
- Plan approved by user: no (revised plan: ADR 0020, recommended D1; Gate 2 pending. Earlier: Gate 2, 2026-11-23, ADR 0019 option A, now superseded)
- Security-sensitive: yes (revised plan: release tooling pack:check, lockfile, published react manifest, pin-bump procedure)
- Review rounds: 1
- Last updated by: architect
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- engineer implement: opus (rule: Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → FAIL (react tarball integrity flips between two values on repeated packs in the pinned image; pnpm pack key order of two workspace devDependencies; ADR 0019 premise false)
- architect revise: opus (rule: failed once) → DONE
## Open questions
- Gate 2: decide ADR 0020 (D1 recommended; D2, E, F). Security plan review runs first (Security-sensitive: yes).
## Deviations from plan
- Plan premise disproved in QA r1: the round 1 plan (ADR 0019, option A, implemented in c4c5fbc and 0f4a1e5) assumed react packs byte-identically in the pinned image. It does not: pnpm 10 inserts the two workspace: devDependencies of react in I/O completion order (p-map-values), so repeated pack:check runs give two values. Plan revised to ADR 0020 (supersedes 0019); fix lands as new commits on top, no rewrite.
- docs/roadmap.md not updated on this branch: the #52 branch already changes it and parallel edits would conflict. Roadmap update for #53 deferred to the next branch after #52 merges.
- docs/conventions.md: the new 0019 row widened the ADR column, so prettier reflowed the whole "Packages, license and release (#37)" table (whitespace only).

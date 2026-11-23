# State: #53 chore(release): investigate react tarball hash differences across node:24 images
- Path: fast
- Phase: validation
- Branch: chore/53-react-tarball-hash
- PR: #62
- Plan approved by user: yes (Gate 2, 2026-11-23: ADR 0019 option A)
- Security-sensitive: no (docs and a marker test only; option A chosen)
- Review rounds: 1
- Last updated by: qa
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- engineer implement: opus (rule: Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → FAIL (react tarball integrity flips between two values on repeated packs in the pinned image; pnpm pack key order of two workspace devDependencies; ADR 0019 premise false)
## Open questions
- none (ADR 0019 accepted at Gate 2: option A)
## Deviations from plan
- docs/roadmap.md not updated on this branch: the #52 branch already changes it and parallel edits would conflict. Roadmap update for #53 deferred to the next branch after #52 merges.
- docs/conventions.md: the new 0019 row widened the ADR column, so prettier reflowed the whole "Packages, license and release (#37)" table (whitespace only).

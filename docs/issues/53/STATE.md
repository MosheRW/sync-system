# State: #53 chore(release): investigate react tarball hash differences across node:24 images
- Path: fast
- Phase: architecture
- Branch: chore/53-react-tarball-hash
- PR: none
- Plan approved by user: no
- Security-sensitive: no (docs and a marker test only; re-judge if ADR 0019 option B is chosen)
- Review rounds: 0
- Last updated by: architect
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
## Open questions
- ADR 0019 (Proposed): A document the reproducibility scope (recommended), B add a compression-independent content digest, C normalize gzip. User decides at Gate 2.
## Deviations from plan
- docs/roadmap.md not updated on this branch: the #52 branch already changes it and parallel edits would conflict. Roadmap update for #53 deferred to the next branch after #52 merges.

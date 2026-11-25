# State: #77 feat(release): publish the reader as a public docker image
- Path: full
- Phase: architecture
- Branch: feat/77-reader-image-release
- PR: none
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: architect
## Model log
- pm grooming: sonnet (default) → DONE
- pm gate-1 update: sonnet (default) → DONE
- architect: opus (default) → DONE
## Open questions
- Gate 2: ADR 0023 choices A (tag name, recommended `reader-vX.Y.Z`), B (version bump, recommended hand bump to 1.0.0 in this PR), C (`/health` body, recommended JSON with `version`), D (image procedure, recommended same as ADR 0017).
## Deviations from plan
- none

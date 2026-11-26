# State: #82 fix(release): narrow the ghcr token scope and pin buildkit in the server image step
- Path: fast
- Phase: architecture
- Branch: fix/82-ghcr-scope-buildkit-pin
- PR: #96
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive) → DONE
- security plan: opus (rule) → PASS
## Open questions
- Gate 2: security C5 (M-1), pinned builder vs docs-only, see security.md
## Deviations from plan
- none

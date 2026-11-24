# State: #9 fix(client): harden forgetAllGroups cut-off against clock skew (follow-up to #7)
- Path: fast
- Phase: architecture
- Branch: fix/9-forget-cutoff-clock-skew
- PR: #72
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: architect
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
## Open questions
- D1 skew margin: architect recommends B (monotonic + 60 s); options A/B/C/D in architecture.md; user decides at Gate 2
## Deviations from plan
- none

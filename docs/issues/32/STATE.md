# State: #32 fix(server): offer take-back only after a handoff loss (follow-up to #25)
- Path: fast
- Phase: architecture
- Branch: fix/32-take-back-after-handoff-only
- PR: #45
- Plan approved by user: no
- Security-sensitive: yes (hostile member re-seizing the lead; permissions)
- Review rounds: 0
- Last updated by: architect
## Model log
- pm grooming: sonnet (default) → DONE
## Open questions
- Q-1 (architecture.md): after a take-back the interim leader is eligible again as a successor on a later handoff; recommended accept
## Deviations from plan
- none

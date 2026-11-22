# State: #32 fix(server): offer take-back only after a handoff loss (follow-up to #25)
- Path: fast
- Phase: architecture
- Branch: fix/32-take-back-after-handoff-only
- PR: #45
- Plan approved by user: no
- Security-sensitive: yes (hostile member re-seizing the lead; permissions)
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
## Open questions
- Q-1 (architecture.md): after a take-back the interim leader is eligible again as a successor on a later handoff; recommended accept
- Security plan review: PASS (0 critical, 0 high, 0 medium, 4 low), see security.md; required controls RC-1..RC-8; security recommends accepting Q-1
## Deviations from plan
- none

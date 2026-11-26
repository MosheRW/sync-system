# State: #41 fix(server): share join-attempt limits across instances through redis
- Path: fast
- Phase: architecture
- Branch: fix/41-shared-join-limits
- PR: none (draft PR opened right after this commit)
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: architect
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive) → DONE
## Open questions
- ADR 0024: fail closed (1001, recommended), fail open to the per-instance budget, or RATE_LIMITED when Redis is unavailable (decide at Gate 2).
- Operator guide: besides the multiplication note and its table row, also fix the two other stale lines (~496 and the "Known limits" bullet ~1178)? Planned yes; drop if the edit must stay at the note only.
- Follow-up issue for the per-app wrong-door budget (60/min), which stays per instance?
## Deviations from plan
- none

# State: #41 fix(server): share join-attempt limits across instances through redis
- Path: fast
- Phase: architecture
- Branch: fix/41-shared-join-limits
- PR: #97
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive) → DONE
- security plan: opus (rule) → PASS
## Open questions
- ADR 0024: fail closed (1001, recommended), fail open to the per-instance budget, or RATE_LIMITED when Redis is unavailable (decide at Gate 2).
- Operator guide: besides the multiplication note and its table row, also fix the two other stale lines (~496 and the "Known limits" bullet ~1178)? Planned yes; drop if the edit must stay at the note only.
- Follow-up issue for the per-app wrong-door budget (60/min), which stays per instance?
- Security plan review: PASS (docs/issues/41/security.md); required controls JB1-JB9; advisories S1-S6 (low); ADR 0024 option 2 would add a medium advisory.
## Deviations from plan
- none

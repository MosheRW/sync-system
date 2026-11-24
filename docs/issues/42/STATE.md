# State: #42 fix(server): treat a just-started instance as live when picking a successor (follow-up to #35)
- Path: fast
- Phase: grooming
- Branch: fix/42-successor-liveness
- PR: none
- Plan approved by user: no
- Security-sensitive: yes (touches control C12: liveness feeding leadership hints)
- Review rounds: 0
- Last updated by: pm
## Model log
- pm groom: sonnet (default) → DONE
## Open questions
- Direct Redis check on cache miss vs one-time grace re-arm (architect, with security)
## Deviations from plan
- none

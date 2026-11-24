# State: #42 fix(server): treat a just-started instance as live when picking a successor (follow-up to #35)
- Path: fast
- Phase: architecture (security plan review PASS; Gate 2 pending)
- Branch: fix/42-successor-liveness
- PR: #74
- Plan approved by user: no
- Security-sensitive: yes (touches control C12: liveness feeding leadership hints)
- Review rounds: 0
- Last updated by: security
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
## Open questions
- Resolved in architecture.md: direct Redis check on a cache miss (one MGET per grace end or take-back); re-arm rejected (does not cover handoff/S4). Security plan review (C12): PASS, see security.md (R1-R9, advisories L1-L2).
## Deviations from plan
- none

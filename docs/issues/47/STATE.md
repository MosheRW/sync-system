# State: #47 fix(storage): bound create-budget key TTL and batch expired live-group cleanup
- Path: fast
- Phase: architecture
- Branch: fix/47-live-group-limits
- PR: #75
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (default + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
## Open questions
- Gate 2: the `lb:<ns>` key expires at `ceil(u) + 1` ms, 1 ms past the AC's literal `max(u - now, L)` bound, so a fresh budget never coexists with a group at its end bound (architecture.md, AC1)
## Deviations from plan
- none

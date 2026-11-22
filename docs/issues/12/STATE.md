# State: #12 fix(server): limit group creation and live groups per app (follow-up to #10)
- Path: fast
- Phase: grooming
- Branch: fix/12-limit-group-creation
- PR: none
- Plan approved by user: no
- Security-sensitive: yes (likely; rate limits / abuse)
- Review rounds: 0
- Last updated by: pm
## Model log
- pm grooming: sonnet (default) → DONE
## Open questions
- Limit values, constants vs env ceilings vs per-app, and the live-group-cap error code name: architect proposes, user decides at Gate 2.
## Deviations from plan
- none

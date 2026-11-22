# State: #12 fix(server): limit group creation and live groups per app (follow-up to #10)
- Path: fast
- Phase: architecture
- Branch: fix/12-limit-group-creation
- PR: #46
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (default) → DONE
- security plan: opus (rule) → FAIL (H1: one instance can fill the live-group cap via leader-return keep-alive; see security.md)
## Open questions
- Gate 2 decisions Q-1 to Q-5 in architecture.md section 2 (limit values, constants vs env vs per-app, cap error code, recreations, refusal logging).
- Security plan review round 1 FAIL: architect to revise Q-1/section 8 per H1 and add R1-R11 (docs/issues/12/security.md).
## Deviations from plan
- none

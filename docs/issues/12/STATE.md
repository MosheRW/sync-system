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
- architect plan revision 1: opus (rule: revision after a failed review) → DONE (H1: global per-app token bucket with rate derived from maxSessionMinutes; M2, L1, L2, L4 folded in)
- security plan round 2: opus (rule) → PASS (H1, M3 closed; new advisories M4 app-wide flood DoS while it runs, L6-L9; required controls R1-R14 in security.md R2.4)
## Open questions
- Gate 2 decisions Q-1 to Q-5 in architecture.md section 2 (Q-1 revised: per-app budget enforcement A global derived bucket / B per-instance derived / C accept DoS; constants vs env vs per-app; cap error code; recreations; refusal logging).
- Gate 2: show security.md R2.4 controls and the corrected M4 sentence (R12): one client can block creation in an app on all instances while a flood runs.
## Deviations from plan
- none

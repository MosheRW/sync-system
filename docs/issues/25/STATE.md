# State: #25 feat: reading app leader views and lifecycle prompts (PRD item 8b)
- Path: full
- Phase: implementation
- Branch: feat/25-reading-app-leader-views
- PR: #31
- Spec approved at Gate 1: yes (2026-11-11, "Accept all", plus the two gap decisions)
- Design decisions: U5-U14 accepted (2026-11-11), U8 changed: the pasted QR link notice stays until dismissed
- Plan approved by user: yes (Gate 2, 2026-11-11, "Approve all")
- Gate 2 decisions: no ADRs. Q-A1: a leader who drops past the grace and returns as a member sees the sticky lost-lead banner (`lostDisconnect`), then the take-back card. Q-A2: the take-back card shows only after a handoff loss (`handoff_disconnect` / `handoff_inactivity`), not after a `take_back` loss; server follow-up for M1 is #32. Security R15-R24 are mandatory (L1-L6 through them; L4: the remove dialog shows the row's details line). "Bring group here" has no pending state; a failure keeps the preview and shows the error in the banner.
- Security-sensitive: yes (roles, removal, take-back client change, other participants' names; see architecture.md section 16)
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm groom: opus (orchestrator: broad lifecycle scope, same as #24) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (NEXT_MODEL: new flows, no existing pattern) → DONE
- designer update (U-decisions): opus (same run) → DONE
- pm update-spec (design decisions): sonnet (default) → DONE
- architect plan: opus (default; NEXT_MODEL opus) → DONE
- security plan: opus (rule) → PASS (0 critical, 0 high, 1 medium, 6 low; required controls R15-R24 in security.md)
- engineer implement: opus (Implementer model line; security-sensitive) → in progress
## Open questions
- Gate 2: Q-A1 and Q-A2 decided (see Gate 2 decisions).
- Resolved by the architect: D1-D9 (architecture.md section 2); server semantics for Gap 1 and keepalive.ack during the pause confirmed (section 3).
- Security M1 (Q-A2): server follow-up issue #32 opened by the pm (security.md R17).
## Deviations from plan
- None.

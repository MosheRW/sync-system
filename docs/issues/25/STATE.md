# State: #25 feat: reading app leader views and lifecycle prompts (PRD item 8b)
- Path: full
- Phase: architecture
- Branch: feat/25-reading-app-leader-views
- PR: none
- Spec approved at Gate 1: yes (2026-11-11, "Accept all", plus the two gap decisions)
- Design decisions: U5-U14 accepted (2026-11-11), U8 changed: the pasted QR link notice stays until dismissed
- Plan approved by user: no
- Security-sensitive: yes (roles, removal, take-back client change, other participants' names; see architecture.md section 16)
- Review rounds: 0
- Last updated by: architect
## Model log
- pm groom: opus (orchestrator: broad lifecycle scope, same as #24) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (NEXT_MODEL: new flows, no existing pattern) → DONE
- designer update (U-decisions): opus (same run) → DONE
- pm update-spec (design decisions): sonnet (default) → DONE
- architect plan: opus (default; NEXT_MODEL opus) → DONE
## Open questions
- Gate 2: Q-A1 (lost-lead banner when the lead was lost while away) and Q-A2 (no take-back offer after a take_back loss), architecture.md section 17.
- Resolved by the architect: D1-D9 (architecture.md section 2); server semantics for Gap 1 and keepalive.ack during the pause confirmed (section 3).
## Deviations from plan
- None.

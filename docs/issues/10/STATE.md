# State: #10 Join methods A-D (door code, approval, alphanumeric, QR)
- Path: full
- Phase: grooming
- Branch: feat/10-join-methods
- PR: none
- Plan approved by user: no
- Security-sensitive: yes (likely: door codes, approval, brute-force limits, QR ticket signing, removal of join by group ID)
- Review rounds: 0
- Last updated by: pm

## Notes
- PRD item 4 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1, #3, #5 and #7 (all merged to main).
- Spec: docs/issues/10/spec.md (45 acceptance criteria).
- UI impact: none in this issue (protocol, server, core client). Code entry, code display, QR rendering/scanning and approval UI are items 7-8; React hooks are item 6. Designer phase proposed to be skipped (Q1.4).

## Open questions
- Q1.1-Q1.4 configuration and scope (default app methods, env ceiling form, per-group choice, designer skip)
- Q2.1-Q2.3 protocol shape (remove join by group ID, single joinByCode with DOOR_CODE_REQUIRED, codes only to leader)
- Q3.1-Q3.3 QR tickets (lifetime/refresh, QR in method B groups, ticket contents)
- Q4.1-Q4.2 recovery (signed codes blob, no reservation while out of memory)
- Q5.1-Q5.6 brute force and abuse (door-code policy, join budgets, per-IP, approval spam, codes.rotate, method C odds)
- Q6.1-Q6.3 approval details (display name, leader offline, restart)
- Each has a recommended default in spec.md.

## Deviations from plan
- none

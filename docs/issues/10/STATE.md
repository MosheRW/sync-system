# State: #10 Join methods A-D (door code, approval, alphanumeric, QR)
- Path: full
- Phase: grooming
- Branch: feat/10-join-methods
- PR: none
- Plan approved by user: no
- Security-sensitive: yes (door codes, approval, brute-force limits, QR ticket signing, codes blob, removal of join by group ID)
- Review rounds: 0
- Last updated by: architect

## Notes
- PRD item 4 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1, #3, #5 and #7 (all merged to main).
- Spec: docs/issues/10/spec.md (45 acceptance criteria).
- UI impact: none in this issue (protocol, server, core client). Designer phase skipped (Q1.4, accepted by the user at Gate 1).
- GitHub #9 (client forgetAllGroups clock skew) is parked and out of scope.

## Gate 1 decisions (user)
- Every open question accepted with its recommended default as written in spec.md:
  Q1.1-Q1.4, Q2.1-Q2.3, Q3.1-Q3.3, Q4.1-Q4.2, Q5.1-Q5.6, Q6.1-Q6.3.
- Recorded in spec.md ("Gate 1 decisions (all questions closed)").

## Open questions
- none from Gate 1

## Deviations from plan
- none

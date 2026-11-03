# State: #10 Join methods A-D (door code, approval, alphanumeric, QR)
- Path: full
- Phase: architecture
- Branch: feat/10-join-methods
- PR: #11 (draft)
- Plan approved by user: yes (Gate 2, with decisions Q-A to Q-E below)
- Security-sensitive: yes (door codes, approval, brute-force limits, QR ticket signing, codes blob, removal of join by group ID)
- Review rounds: 0 (code review); security plan review rounds: 2 (round 1 FAIL, round 2 PASS)
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

## Architecture
- Plan: docs/issues/10/architecture.md (21 implementation chunks, Security-sensitive: yes).
- Next: security plan review (mode plan), then Gate 2.

## Security plan review
- Round 1: FAIL (docs/issues/10/security.md). High 1, medium 3, low 7.
- H1: door-code limits are per group only; guessing spread across groups is silent
  (10-min failure decay) and capped only by the 600/min app budget (~0.86 break-ins
  per app per day). Required: R1a (count failures since last door change),
  R1b (fixed per-app wrong-door budget, recommended 30/min), R1c (corrected odds).
- Required controls R1a-R16 mapped to planned commits (security.md section 5).
- Plan revision 1 (architect): every required control R1a-R16 added to architecture.md and
  mapped to the 21 planned commits (architecture.md section 8.4). R1a in DoorGuard, R1b as
  DOOR_FAILURES_PER_APP_PER_MINUTE (planned 30) checked before the compare, R1c corrected odds
  in section 8.1 plus spec/README corrections listed in section 8.6 (commit 21). Advisories
  M2 (follow-up issue), M3, L4, L5, L6 recorded in section 8.5.
- Round 2: PASS (security.md "Round 2"). H1 and M1 closed in plan; all R1a-R16 mapped.
  New low notes for the engineer: N1 (blob from a direct server reply is always stored;
  highest-generation rule only for merging stored copies, commit 17), N2 (R1b peek/compare/
  record synchronous, before any await such as setCodes), N3 accepted.

## Gate 2 decisions (user; plan approved)
Recorded in architecture.md section 12 (plan revision 2).
- Q-A: keep createGroup(metadata, initialPosition?, options?) with options.joinMethods (no breaking change; D10).
- Q-B (changed from the recommendation): separate QR ticket generation (D12). Bumped only by
  create, leader codes.rotate and a new full code set on recreation; automatic door-code
  rotation bumps the code generation only, so QR tickets survive it. ticketGeneration is set
  to the new code generation (R3 inherited, no revival after restart without a usable blob);
  invariants ticketGeneration <= generation, both monotonic; blob carries t (t <= n); R2
  compares the code generation only. Spec AC25/AC29/AC30/AC32/AC33 and decision 6 wording
  updated by the engineer in commit 21 (exact text in architecture.md 8.6).
- Q-C: pending joiners get GROUP_ENDED on group end or drop, no groupId, no details (D9, R13).
- Q-D: QR refresh is app-driven (issueQrTicket() + README recipe, no client timer; D7).
- Q-E: DOOR_FAILURES_PER_APP_PER_MINUTE = 60 (~0.086 expected break-ins per app per day under
  a nonstop attack; 8.1, 8.6).
- Security notes folded in: N1 (direct server blob always stored; highest generation only when
  merging stored copies; commit 17), N2 (R1b check/compare/record synchronous before any await;
  commit 9). N3 accepted.
- Next: security re-check of the Q-B change (D12, 4.7, 4.8, 7.3, 8.6) if the orchestrator
  runs it, then implementation (engineer, 21 commits).

## Open questions
- Follow-up to open after Gate 2: M2 group-creation rate and per-app live-group cap.

## Deviations from plan
- none

# State: #10 Join methods A-D (door code, approval, alphanumeric, QR)
- Path: full
- Phase: implementation
- Branch: feat/10-join-methods
- PR: #11 (draft)
- Plan approved by user: yes (Gate 2, with decisions Q-A to Q-E below)
- Security-sensitive: yes (door codes, approval, brute-force limits, QR ticket signing, codes blob, removal of join by group ID)
- Review rounds: 0 (code review); security plan review rounds: 3 (round 1 FAIL, round 2 PASS, round 3 targeted PASS)
- Last updated by: engineer

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

## Security plan review round 3 (targeted, head d5fb2e2)
- PASS (security.md "Round 3"). D12 separate ticket generation keeps R3 (no ticket
  revival after restart), key/purpose separation, and the M1/R2 residual; Q-E = 60 odds
  (~0.086/day per app, ~0.087 with C) and the reworded ACs in architecture 8.6 are consistent.
- No new required control. Low notes: N4 (AC33 "higher" ticket generation), N5 (section 10
  table rows R2+N1 / Q-B misaligned), N6 (code-mode checks on generation assignment).

## Implementation (engineer)
- All 21 planned commits are on the branch, in order, plus two small hygiene
  commits (see deviations). PR #11 marked ready for review.
- Checks: pnpm lint, typecheck, test (protocol 70, server 819, client 537),
  build and `pnpm audit --audit-level=high` all exit 0. No dependency changes.
- Required controls R1a-R16 implemented with tests; N1, N2 folded in; N4 (AC33
  "higher" ticket generation) and N5 (section 10 table rows) applied in
  commit 21. N6: only `issueCodeSet` and `rotateDoorCode` build a new
  generation (recreation with a verified blob copies the blob's values);
  every payload re-signs the blob from the record's current codes (current
  `t`); `qr.issue` reads `ticketGeneration` under the group lock.
- Advisories M3, L4, L6 documented in the README; M2 documented with a
  pointer to issue #12 (not implemented).

## Open questions
- none (M2 is tracked as issue #12).

## Deviations from plan
- Extra commits: `style(server): use a type import for the mocked crypto
  module` (1c50739) and `fix(server): type the join attempt helper in the
  brute-force tests` (c4475fc) fix lint/typecheck slips in commits 3 and 8
  (pushed commits are never amended).
- `JoinService` was created in commit 5 (with the create/release hooks)
  instead of commit 6, so codes had one owner from the start.
- `defaultAppMethods` lives in `joins/join-methods.ts` and is used by
  `config/apps-config.ts` (planned in both places).
- QR tickets: the schema caps raw `ticket` input at 512 characters
  (`MAX_QR_TICKET_INPUT_LENGTH`), so a malformed or over-256 ticket gets
  `QR_INVALID` as AC25 and the section 10 test row require, instead of
  `INVALID_MESSAGE` (architecture 4.3 step 5 wording).
- `CreatedGroup.joinMethods` / `codes` landed in commit 14 (not 16), so the
  client tests could join by code when `joinGroup` was retired; the leader
  API and `createGroup` options landed in 16 as planned.
- Server test helpers: `createGroupWithMembers` returns `codes` and `join`
  fields; new `codesOf`, `joinByCode` helpers and a `ScriptedRandom` code
  source (`codeRandom` server option) for collision tests.
- Client local guard for a pending approval: when the server's deadline plus
  `requestTimeoutMs` passes, the join rejects with REQUEST_TIMEOUT and the
  connection is dropped (as other request timeouts do), so the server
  withdraws the request.

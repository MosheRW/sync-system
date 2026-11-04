# State: #13 feat: roles, timers and group lifecycle (PRD item 5)
- Path: full
- Phase: architecture
- Branch: feat/13-roles-lifecycle
- PR: #14 (draft)
- Plan approved by user: no
- QA loops: 0
- Last updated by: security
## Gate 1 decisions
- User accepted every recommended default Q1.1-Q7 as written in `spec.md`,
  with one change: Q5.5 display names use the existing strict #10 rule
  (`normalizeDisplayName`), not a new looser rule. Recorded in `spec.md`
  ("Gate 1 decisions").
## Open questions
- Gate 2 questions Q-A to Q-E in `docs/issues/13/architecture.md` section 14.3 (each with a recommendation).
- Security plan review (`docs/issues/13/security.md`): round 1 FAIL on H1.
  Plan revision 1 done (see Deviations); needs security plan re-check
  (round 2) before Gate 2.
- Security round 2: FAIL on H2 (supersede after a drop without restart,
  and same-`rt` ordering); architect to revise 6.6.1/6.6.2 per
  `security.md` "Round 2" before Gate 2.
- Plan revision 2 done (security's H2 fix applied exactly, per user
  decision); needs security plan re-check (round 3) before Gate 2.
- Security round 3: FAIL on H3 (same-`rt` laundering of an in-line grant
  through a second recreation); fix = lineage path `lin` replacing `rt`
  (`security.md` "Round 3"). Advisories L9, L10.
## Deviations from plan
- Board: `.claude/github-project.env` had an empty `GH_PROJECT_NUMBER`; the card was added to project 8 ("sync system") with a temporary config copy. Restored to 8 on this branch in 8880f2d.
- Plan revision 1 (after security round 1): H1 closed in architecture.md 6.6
  with `processStartedAt`, `record.recoveredTerm` and a new token claim `rt`
  (recovery anchor) in token format 2; supersede only when
  `recoveredTerm < claims.rt < processStartedAt` on a group recreated in this
  process; new leader token on supersede. `rt` also closes drop-and-recreate
  in one process and a second restart (6.6.3). M1-M4, L1, L3, L4 and the Gate 2
  conditions folded in; L2 (in part) and L5 adopted; M4 optional
  `admittedSinceRecovery` marker taken. RC1-RC14 mapped to commits (14.1).
- Plan revision 2 (after security round 2, H2; user: "apply the fix"):
  `processStartedAt` removed; every recreation (restart or drop) sets
  `record.recoveredAt = now` and `record.anchor = (claims.rt, claims.term)`;
  `canSupersede` requires an anchor, a leader token of another pid,
  `claims.term < recoveredAt` and `(claims.rt, claims.term) > anchor`
  (lexicographic), plus `lat`/max-session. Supersede sets the anchor to the
  requester's pair and keeps `recoveredAt`. 6.6.3 rows 14-18 added (H2a,
  polling, H2b drop/restart, repeated drop), row 9 rewritten; truth tables in
  `resume.test.ts`. Commit 13 renamed to "supersede a stale leader by
  recovery anchor"; section 11 says "after a restart or a drop".
## Model log
- architect planning: opus (default for architect; pm NEXT_MODEL opus) → DONE; recommends opus for engineer (Implementer model: opus)
- security plan review: opus (rule: security always opus) → FAIL (H1); recommends opus for architect revision
- architect plan revision 1: opus (security NEXT_MODEL opus; revision after a failed review) -> DONE; recommends opus for security re-check and engineer
- security plan review round 2: opus → FAIL (H2: drop-without-restart and same-rt ordering defeat supersede; fix = recoveredAt + (rt, term) anchor); recommends opus for architect revision
- architect revise (round 3 input): opus (rule: fix after failed review) → DONE
- security plan (round 3): opus (rule) → FAIL

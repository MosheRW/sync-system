# State: #13 feat: roles, timers and group lifecycle (PRD item 5)
- Path: full
- Phase: implementation
- Branch: feat/13-roles-lifecycle
- PR: #14 (draft)
- Plan approved by user: yes (Gate 2, 2026-11-04)
- QA loops: 0
- Security-sensitive: yes
- Last updated by: engineer
## Gate 1 decisions
- User accepted every recommended default Q1.1-Q7 as written in `spec.md`,
  with one change: Q5.5 display names use the existing strict #10 rule
  (`normalizeDisplayName`), not a new looser rule. Recorded in `spec.md`
  ("Gate 1 decisions").
## Gate 2 decisions (user, 2026-11-04)
- Plan approved. Q-B, Q-C, Q-D, Q-E: as recommended. Q-F: no (`rcv` not
  added; R-2R accepted, README states it with the operator guidance: no two
  restarts within the inactivity limit plus the refresh slack while groups
  are live).
- Q-A changed: removal detaches the session (D6), sends
  `group.ended {reason: 'removed'}` as the last group frame, then closes the
  WebSocket with the new close code 4004 (`CloseCode.REMOVED`). The client
  treats it as terminal (no reconnect, `closed`, token and recovery deleted,
  `removed` event).
- Q-G yes: an empty group is held, paused, for `disconnectGraceSeconds`, with
  security RC21 (no admission while held, one deadline never extended, end
  at the deadline in both modes).
- Recorded in `spec.md` ("Gate 2 decisions"; AC14, AC19, AC21, AC27, AC32,
  AC45) and `architecture.md` section 16 (and D6, D15, 5.4).
## Required controls -> commits (engineer's placement)
- RC1: 2, 6, 7 (+ 14). RC2: 5-8, 12 (+ 14, 15). RC3: 6. RC4: 7 (+ Q-A close
  4004), 17. RC5: 1. RC6, RC7, RC15: 13. RC8: 12, 13. RC9: 4, 16. RC10: 4,
  12. RC11: 14. RC12: 20. RC13: 8-13, 15. RC14, RC16 docs, L13: 23 (RC16
  clock tests: 13). RC17: 2a.
- RC18 (L11): `iat` floor at process start in 2a (it needs
  `processStartedAt`); `recoveredAt = max(now, claims.term + 1)` in 2a, where
  `recoveredAt` is introduced; tests in 2a and 13.
- RC19 (L12): 2a (the re-check guards every pause and end on a socket close).
- RC20 (M5): 2a (namespace with most guarded entries; recreating-resume
  budget per connection).
- RC21 (Q-G): new chunk 10a after the handoff chunk (it needs the grace
  config of 3, `GROUP_LOCKED` of 6, the pause of 9 and the handoff of 10).
- 5.4 wording fix (refresh issues a new `iat`; only `resign` keeps it):
  architecture 5.4 corrected; the code keeps the refresher on `issue`
  (`sendRefreshedToken`).
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
- Plan revision 3 done (rescope per user decision): needs security plan
  re-check (round 4) before Gate 2. New Gate 2 questions in
  architecture.md 14.3: Q-F (close the two-restart residual R-2R with a
  `rcv` claim, so a group survives at most one restart; recommended: no,
  accept the residual) and Q-G (hold an empty group for the grace period
  instead of ending it at once; not planned, offered because of the
  solo-leader blip impact).
- Spec impact (architecture.md section 15): applied to `spec.md` by pm
  (AC14, AC19, AC21, AC26, AC27, AC37, AC45, decision 6); rescope decision
  recorded 2026-11-04.
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
- Plan revision 3 (user decision after 3 failed security plan rounds,
  H1/H2/H3: "simplify the scope"): rescoped recovery. Takeover/supersede by
  token only after a server restart; a group that empties in a running
  process ends (`empty`) and can't be recreated in that process (ended-groups
  entry with TTL = max-session deadline and a `guardUntil` for groups
  recreated in this process, a stateless `iat >= processStartedAt` fence,
  fail-closed cap with per-namespace recovery closure; `tokens.check` and
  resume share one classification order). Supersede rule:
  `recoveredAt` defined, leader token of another pid,
  `anchorTerm < term < recoveredAt`, `lat`/max session; `nextTerm` floored at
  `recoveredAt`. `rt` claim, `(rt, term)` anchor and the lineage proposal
  dropped. L9 (exists fallback re-classifies, RC15) and L10 (clock residual
  stated plainly, NTP + restart assumptions in README, RC16) fixed. New RC17
  and commit 2a (`feat(server)!: end a group that empties instead of
  dropping it`). Two-restart residual R-2R documented (6.6.3 row 19).
## Model log
- architect planning: opus (default for architect; pm NEXT_MODEL opus) → DONE; recommends opus for engineer (Implementer model: opus)
- security plan review: opus (rule: security always opus) → FAIL (H1); recommends opus for architect revision
- architect plan revision 1: opus (security NEXT_MODEL opus; revision after a failed review) -> DONE; recommends opus for security re-check and engineer
- security plan review round 2: opus → FAIL (H2: drop-without-restart and same-rt ordering defeat supersede; fix = recoveredAt + (rt, term) anchor); recommends opus for architect revision
- architect revise (round 3 input): opus (rule: fix after failed review) → DONE
- security plan (round 3): opus (rule) → FAIL
- architect revise (round 4 input): opus (rule: fix after failed review) → DONE
- pm spec update (rescope): sonnet (default) → DONE
- security plan (round 4): opus (rule) → PASS
- engineer implement: opus (Implementer model: opus; security-sensitive)

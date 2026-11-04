# Security review (plan): #13 Roles, timers and group lifecycle

Mode: plan, round 1. Reviewed: `docs/issues/13/spec.md` (AC1-AC46, Gate 1
decisions incl. Q5.5) and `docs/issues/13/architecture.md` (head 7bf31f4),
against the code they touch on `main`:
`apps/sync-server/src/{groups/resume.ts, groups/group-service.ts, joins/join-service.ts, tokens/token-service.ts, logging/logger.ts, limits/constants.ts}`,
`packages/protocol/src/tokens.ts`.
Prior reviews: `docs/issues/{5,7,10}/security.md`.

**Verdict: FAIL.** One high finding (H1): the leadership-term rule lets a
stale (possibly removed) displaced leader that recreates the group first after
a restart mint a *newer* term inside the new process through an ordinary
handoff, so the real leader's token no longer supersedes it, and the displaced
leader can then take the lead back for good. The fix is small and local to
section 6.6 (stated below). The rest of the design is sound: deleting
`Membership.role` so the compiler finds every cached-role check, one
`authorizeLeader` under the group lock, `position.update` under the lock, lazy
timers that re-check `term`/`pause`, an append-only block list, and the
supersede rule that ignores a stale block list.

## 1. Assets and trust boundaries

- **Control of a group**: the leader slot (`record.leaderId`), the leader
  token (now with `term`), the take-back slot (`displacedLeaderId`), and what
  a leader receives: codes, codes blob, QR issuing, block list, roster,
  pending approvals.
- **Membership**: member tokens, the block list (held by the leader client,
  server copy while live), the lock flag.
- **PII**: display names (possibly minors) and group-scoped participant IDs,
  now in the roster; vice-leader identity (secret from members, Q3.3).
- **Server memory and timers**: roster (2 x `maxGroupSize`), 3 new timer kinds
  per group, 5 new per-group limiters.
- Untrusted input: every frame. The app key is public, so any internet client
  can connect; per-connection budgets reset on reconnect (#10 section 1).
  Only the leader client is trusted with the recovery state, and only as far
  as the leader's own group (it is the leader).
- New trust boundary: **across a server restart** nothing is stored, so
  which leader is legitimate is decided only from what clients present
  (tokens with `term`, recovery state). This is where H1 sits.

## 2. Threats (STRIDE, brief)

| | Threat | Plan answer |
|---|---|---|
| S | Displaced leader uses its old leader token to regain control (live group) | D4: role from the record; lower-term leader token resumes as member. Sound. |
| S | Displaced/removed leader regains control after a restart | Supersede by higher term (6.6). **Defeated by an in-process handoff (H1).** |
| S | Member, vice, parked, pending or former leader performs a leader action | D1/D2 + matrix (section 7). Sound (RC1). |
| T | Stale recreator blocks the real leader with a forged list | Superseding token skips the stale list. Sound. |
| T | Removed member comes back (token, code, QR, approval, recreate) | Block list (append-only), rotation of codes and ticket generation. Sound; gaps after supersede (M1) and roster eviction (M3). |
| R | Leader can't see who joined during a stale-leader window | Roster after supersede; no marker (M4). |
| I | Roster, names, vice identity, IDs reach members or logs | Leader-only frames; redaction keys. Redaction gaps for new ID keys (M2). |
| I | Lock as a code oracle | No new oracle beyond the accepted #10 Q2.2 group-code oracle (Q-D). |
| D | Event flooding by a leader client; budget draining by members; timer churn | Per-group limits (8.2), lazy timers. Sound if limits are charged after authorization (RC2). |
| E | Double leader in a handoff race | All leader actions, handoff, take-back, removal, supersede and end under one per-group lock; timers re-check. Sound (RC1, RC13). |

## 3. Findings

### Critical
None.

### High (blocking)

**H1. A stale displaced leader can out-term the real leader after a restart by handing off inside the new process.**
Location: architecture.md D3, 6.5, 6.6 ("Supersede ... `term > record.term`";
"`term = claims.term`"), section 11 first bullet.

Scenario: A leads, is displaced to B (B gets term T1, A keeps its leader
token T0 because it was offline at handoff, or a modified client keeps a
copy). B removes A. The server restarts. A's token is still inside its `lat`
window and A reconnects first: it recreates the group at term T0 with its own
stale block list (the known residual in section 11). Before B reconnects, A
designates any connected member M as vice and disconnects; after the 30 s
grace the group hands off to M with `nextTerm = max(T0 + 1, now)` = `now`,
which is **greater than T1** (T1 was granted before the restart). When B
arrives, `T1 < record.term`, so B resumes as a plain member (D4) and can't take
back (the slot holds A). A, being `displacedLeaderId`, reconnects and sends
`leader.takeBack`: A leads again with a fresh leader token, permanently. With
an accomplice the vice step is not even needed. Preconditions: a restart
(deploys), A inside ~25 min of its last leader activity, and B away for at
least the grace period after the restart. That is a realistic combination,
and it defeats exactly the control AC26 exists for, so I rate it high.

The same rule also lets an in-process leader token re-supersede: after B
supersedes at "`term = claims.term`" (T1), M's offline leader token (term
`now` > T1) would supersede B on M's next resume.

Fix (all in 6.6 / `resume.ts`, commit 13):
1. Record `processStartedAt` (from the injected clock at service start) and,
   on recreation, `record.recoveredTerm = claims.term` (the highest
   *pre-restart* term presented so far). Groups created in this process have
   no `recoveredTerm`, and **supersede is never possible for them** (explicit
   guard, not an emergent property of term order).
2. A leader token supersedes iff the record was recreated in this process,
   `claims.pid !== record.leaderId`, `record.recoveredTerm < claims.term <
   processStartedAt`, and the token passes signature, `lat` and max-session
   checks. In-process grants always have `term >= processStartedAt`, so they
   can neither block nor perform a supersede.
3. On supersede set `record.recoveredTerm = claims.term` and
   `record.term = nextTerm(max(record.term, claims.term), now)`, and issue the
   requester a **new** leader token with that term (in `group.resumed`). That
   puts every in-process leader token (M's) below the record, so it resumes
   as a member.
4. Tests (`restart-handoff.int`): the H1 sequence (recreate by A, vice +
   handoff to M, B arrives -> B supersedes, A and M demoted, take-back slot
   empty, A blocked by B's list); M's in-process leader token after the
   supersede -> member; a group created in this process never supersedes
   even with a forged-looking high term (minted by the test keyring).

### Medium (advisory; M1-M3 are made required controls)

**M1. Supersede keeps the stale leader's codes when the requester's codes can't be adopted.**
Location: 6.6 "Codes: ... otherwise the current codes stay."
The current codes after a stale recreation are the ones from the stale
leader's blob, i.e. possibly the codes that B's removal rotation was meant to
kill (a removed person still knows them). Fix: if the requester's blob is not
adopted (invalid, same generation, or codes taken), **rotate** codes and the
QR ticket generation (`codes.updated`, reason e.g. `superseded`). Test it.

**M2. Redaction keys do not cover the new ID-bearing field names.**
Location: 3.2 `logger.ts` row. The plan adds `viceid`, `roster`,
`participants`, `guestnumber`. Group-scoped IDs also travel as `pid`
(`RosterEntry.pid`, token claims), `leaderId`, `displacedLeaderId`,
`successor`, `target`/`targetId`, and inside `LeaderState` (`state`). The
`participantid` fragment matches none of them. A future
`logger.debug({ entry })` or `{ record }` would write IDs. Fix: add exact keys
`pid`, `pids`, `successor`, `target`, `targetid`, and fragments `leaderid`
(covers `leaderId`, `displacedLeaderId`) and `viceid`; `roster`,
`participants`, `guestnumber`, `names`. Extend the existing any-depth
redaction test with a `GroupRecord`-shaped object (roster entries, pause,
viceId, displacedLeaderId) and assert no ID or name survives. `term` and
`handoffReason` are not sensitive.

**M3. Roster eviction can drop the take-back slot holder or the vice, and the leader can't remove an evicted participant.**
Location: D10, 6.7 `member.remove` ("ID not in this group's roster ->
`PARTICIPANT_NOT_FOUND`"), section 11 "Displaced leader evicted".
Anyone with a current code can churn identities until the displaced leader's
disconnected entry is evicted. B then can't remove A (not in roster), but A
can still resume by token and send `leader.takeBack` in the same burst, before
B can react. Fix: never evict the entry of `displacedLeaderId` or `viceId`
(evict the next-oldest instead); if eviction of the vice ever happens anyway,
clear `viceId`. Also confirm `member.remove` works on an **offline** roster
member (test).

**M4. Restart residual (section 11): accepted, but wider than stated.**
Location: section 11 first bullet. Besides "a removed person can join through
stale codes", during the window the stale leader can also `group.end` the
group (irreversible: it lands in ended-groups and B then gets `GROUP_ENDED`),
remove honest members (their clients delete their tokens), rotate codes, and
see the roster names of members who resume. Without server persistence this
can't be fully closed, and the window is bounded by the stale token's `lat`
(~25 min) and by the real leader reconnecting. I accept it as a residual
provided H1 is fixed (so it is temporary). Required: README "Security notes"
states the residual in one paragraph. Optional mitigation the architect may
take: on supersede, mark roster entries admitted by code/QR/approval since the
recreation (`admittedSinceRecovery: true` in `RosterEntryWire`) so the real
leader can review them; and/or treat a resuming member token whose `term` is
`> record.recoveredTerm` and `< processStartedAt` as evidence of a stale
recreator (e.g. pause privileged destructive actions). Not required.

### Low (hygiene; L1, L3 and L4 are required controls)

**L1. Supersede ordering for a blocked stale leader.** 6.6 demotes the stale
leader (member token via `leader.lost`) and then applies the requester's block
list. If the stale leader is on that list it must end up **removed**, not
holding a fresh member token. Apply the list first; a listed stale leader gets
`group.ended {reason: 'removed'}` and no token. Test.

**L2. Leader return with a member token skips the `lat` bound.** D4 makes
`pid === record.leaderId` a leader return even with a member token, and the
`lat` check only applies to leader tokens. A copied member token of the
current leader then gives leader return (codes, block list) without the 25
min inactivity bound that #5 put on leader tokens. Impact is small (same
identity, live group only, bounded by the group's own timers). Advisory:
accept, but log nothing extra and add a test; or require the record to be
paused (leader offline) for this path.

**L3. Clear the take-back slot when the displaced leader leaves.** A
`group.leave` by `displacedLeaderId` should clear the slot, like removal and
end do, so a participant who left can't come back by token and take back. Also
move the `LEADER_CANNOT_LEAVE` check (today `membership.role`, before the
lock, `group-service.ts:693`) inside the lock against `record.leaderId`.

**L4. Client keeps leader-only data after demotion.** On `leader.lost`,
demotion by `group.joined`, `superseded` and removal, the client must drop
the roster, `LeaderState`, codes and pending approvals from memory and storage
(names of possibly minors on a device that no longer leads). Test in
`client.lifecycle.test.ts`.

**L5. `keepalive.ack` shares the `leader.activity` budget.** A preview
helper bug (or a modified client) that spends the 12/min budget makes the
real ack `RATE_LIMITED` and not counted, so the group pauses. Self-inflicted
only, but cheap to avoid: a `keepalive.ack` while `keepAlivePending` is
always accepted (at most once per prompt), or give it its own budget.

**L6. Roster delta volume from reconnect churn.** A member reconnecting in a
loop makes `roster.updated` frames to the leader (bounded only by inbound and
join limits). Advisory: coalesce per participant (e.g. one delta per 1 s) or
accept and note it.

**L7. Auto handoff gives full control to the earliest connected member.** By
design (Gate 1 Q2.1, Q2.2): the successor gets codes, block list and can
remove the original leader (clearing the take-back slot). README should say
so and recommend a vice-leader or `frozen` mode for sensitive sessions.

**L8. Chosen names that look generated.** A chosen `Guest 3` looks like a
generated name; `generated: true` is the only distinction. README (AC38) tells
apps to render the flag (or the ID) so the leader can tell them apart.

## 4. Gate 2 questions: security view

- **Q-A Removal: keep the socket open (recommended) vs close it.** Agree with
  keeping it. Closing adds nothing: the client would reconnect, and the
  removed person can open new sockets anyway. What matters is that the
  session is fully detached (RC4): notifier unregistered, no parked or
  pending-approval entry left for that session, `group.ended removed` is the
  last group frame it receives (queued after its pending replies), and no
  later broadcast reaches it. The socket then behaves like any fresh,
  groupless connection under the existing join budgets.
- **Q-B Escalation flag cleared by the first counted activity (recommended)
  vs whole term.** Agree. The flag is a liveness heuristic, not a security
  control: only the leader can clear it, and only by being active. Make sure
  take-back and supersede set `escalated = false` (RC13).
- **Q-C Block list append-only, drop `removeFromBlockList` (recommended).**
  Agree strongly; it is what makes removal stick across handoff. Condition:
  the union in `blocklist.set` and leader return must fail with
  `BLOCK_LIST_FULL` past 256 entries, never truncate (truncation is an
  unblock). Recreation still takes the client's list as given; that is the
  leader's own choice and the restart residual (M4).
- **Q-D Locked group with a valid code: `GROUP_LOCKED` (recommended) vs
  `CODE_NOT_FOUND`.** `GROUP_LOCKED` is fine. Group-code existence is
  already an accepted oracle (#10 Q2.2), and an unlocked group reveals any
  valid code by admitting, queueing or asking for the door code, so the lock
  adds no new information. Conditions (RC3): the join-attempt budget is
  charged before the lock check; QR tickets are fully verified (signature,
  expiry, generation) before the lock check, so an invalid ticket never
  learns the lock state; the lock is checked before the door compare (no
  door failure counted, no door oracle); one byte-identical text and no
  `details` for every method.
- **Q-E Per-group limits (remove 10, lock 10, vice 10, take-back 3,
  activity + ack 12 per minute; client throttle 10 s).** Values are fine:
  each action fans out to at most the group, and the take-back budget caps a
  two-party take-back ping-pong at 3 `leader.changed` broadcasts per minute.
  Conditions: limits are charged only **after** authorization and input
  validation (a member or the displaced leader must not be able to drain the
  leader's budget, especially the activity budget that keeps the group from
  pausing), keyed by `(namespace, groupId)`, forgotten on group end/drop, and
  cleared in `close()` (RC2). Plus L5 for the ack.

## 5. Required controls (part of the plan), mapped to commits

| # | Control | Commit(s) |
|---|---|---|
| RC1 | Every leader-only action (section 7 list, plus `group.leave`'s `LEADER_CANNOT_LEAVE`) calls `authorizeLeader` inside the group lock, with no `await` that releases the lock between check and effect; `JoinService` host `ownedLeader` and the "check again after await" pattern replaced by it. No code path reads a role from the token or the session for authorization. | 2, 6, 7 |
| RC2 | Per-group limiters charged after authorization and validation; keyed by namespace + group; forgotten in `forgetGroup`, cleared in `close()`. Matrix test: non-leader attempts leave the budget untouched. | 5-8, 12, 14 |
| RC3 | Lock check under the group lock in `joinByCode`, `joinByQr`, `decide('approve')`, **and** again in the shared admit step (no TOCTOU between the check and admission); after budget charge and full code/ticket resolution, before the door compare; identical `GROUP_LOCKED` for every method. | 6 |
| RC4 | Removal: target detached (notifier, parked/pending entries), `group.ended removed` last, block-list append with `BLOCK_LIST_FULL` (no eviction or truncation, also for `blocklist.set` union), vice and take-back slot cleared, codes **and** ticket generation rotated, works on offline roster members. | 7, 17 |
| RC5 | Token format 2: `term` added to the fixed-order `payloadJson` (L3 of #5) so `resign` keeps it; schema `term >= gct`; plausibility `term <= now + skew`; a v1 token gets the same `TOKEN_INVALID` as any bad token. | 1 |
| RC6 | H1 fix: `processStartedAt`, `recoveredTerm`, the supersede condition, `term = nextTerm(...)` and a fresh token on supersede; no supersede for groups created in this process. | 13 |
| RC7 | Supersede: requester's block list applied before the stale leader is demoted (L1); codes adopted or rotated (M1); `displacedLeaderId = undefined`; recovered `viceId` validated against the roster and block list. | 13 |
| RC8 | `classifyToken`: block list applies to every role (only a valid supersede is exempt); `lat` checked whenever the token would act as leader; a `lat`-expired leader token never recreates or supersedes (it resumes or parks as a member, or `TOKEN_EXPIRED`; pick one and test it). | 12, 13 |
| RC9 | Redaction keys per M2 and an any-depth test with a record-shaped object. | 4 (keys), 16 (test) |
| RC10 | Roster eviction never drops `displacedLeaderId` or `viceId` (M3). | 4, 12 |
| RC11 | Members' frames never carry another participant's ID or name, or the vice identity: a frame-capture test over handoff, take-back, vice changes, lock, removal and supersede asserts member and vice frames contain only their own pid. | 14 |
| RC12 | Client drops leader-only data on demotion and removal (L4). | 20 |
| RC13 | Timer callbacks re-check `term` and `pause` under the lock; handoff, take-back and supersede clear stale timers and set `escalated` (true only for an inactivity handoff). | 8-13, 15 |
| RC14 | README security notes: restart residual (M4), auto-handoff power (L7), name rendering (L8). | 23 |

## 6. What I will check in code mode

- Every former `membership.role` call site and every new handler: the check
  is `authorizeLeader` inside the lock, before any effect, budget or activity.
- `resume.ts` / supersede: the H1 sequence and both arrival orders in tests;
  `processStartedAt` from the injected clock; blocked stale leader removed.
- Lock on all four methods plus approval and the admit step; one text.
- Removal bypass on every path, including after supersede (M1) and after
  roster churn (M3).
- `logger.ts` keys and the any-depth test; no `logger.*` call logs a record,
  roster, `LeaderState` or name; new log events carry only allowed fields.
- Member-frame capture test (RC11); `leader.changed` has no IDs.
- Limiter ordering and keys; `close()` leaves no timers or limiters.
- Token: `term` in `payloadJson` and plausibility; v1 rejection.
- Client: leader-only state cleared on demotion; preview never sends a
  position; nothing new in tokens.
- Scanners: gitleaks, semgrep, `pnpm audit` (no new dependency expected).

## Round 2 (plan revision 1, head b12b372)

Reviewed: `git diff 19b8695..b12b372` of `architecture.md` (6.6.1-6.6.4,
6.7, 6.8, D3-D6, D10, D14, 8.2, 9.3, 11-14) and `STATE.md`.

**Verdict: FAIL.** The round-1 items are closed (table below), and the `rt`
claim is a good idea: it correctly carries the "which pre-recovery grant does
this line descend from" fact across a second restart. But the two guards that
use `processStartedAt` treat "before this process started" as "before the
recovery". A recovery also happens **without a restart**: a group that is
dropped from memory (#5 AC22, the leader disconnects with nobody else
connected) is recreated by the next leader token that arrives. In that case
the revised rule never lets the real leader supersede, and it is worse than
round 0, which would have. That is H2 below. I missed this case in my own
H1 fix in round 1 (I proposed `processStartedAt`); the corrected rule is
stated below, and it keeps every row of 6.6.3.

### Round-1 findings: status

| Finding | Status |
|---|---|
| H1 restart | Closed for restarts (6.6.3 rows 1-8, 10-13 hold). Re-opened in a different form for drops (H2). |
| M1 codes after supersede | Closed (6.6.2 step 5, `rotateAll` codes and ticket generation). |
| M2 redaction keys | Closed (`logger.ts` row; any-depth test with a record-shaped object). |
| M3 eviction | Closed (D10 protected entries, removal of offline entries). |
| M4 residual | Accepted and documented; `admittedSinceRecovery` marker taken (6.6.4). Fine. |
| L1 supersede order | Closed (6.6.2 step 1). |
| L2 member-token leader return | Adopted in part (bound by that token's `lat`). Fine. |
| L3 leave clears slot, leave check in lock | Closed (6.6, 6.7). |
| L4 client drops leader data | Closed (9.3, RC12 test). |
| L5 first ack uncharged | Adopted (8.2). |
| L6-L8 | Addressed in tests / README (L6 test, L7/L8 docs). |
| Gate 2 conditions Q-A to Q-E | Folded into D5, D6, D9, D14 and 6.8 as stated. |
| RC1-RC14 | Mapped to commits (14.1). |

### High (blocking)

**H2. After a drop (no restart), a stale displaced leader who recreates first keeps the lead for good. Also, within one recovered line, a stale leader beats a later leader of the same line.**
Location: 6.6.1 guards 2 and 4 (`recoveredTerm < processStartedAt`,
`claims.rt < processStartedAt`), 6.6.3 row 9 ("never supersedes"), and guard 3
(`recoveredTerm < claims.rt`, strict on `rt` only).

(a) Drop. Everything happens in one process P1 (`processStartedAt = S1`). A
creates at T0 >= S1 and is displaced to B at T1. B removes A. Later, B
disconnects while no one else is connected, so the group is dropped (not
ended; #5 AC22). A's leader token `(T0, rt T0)` is still inside its `lat`
window, so A recreates: `recoveredTerm = T0`. B arrives with `(T1, rt T1)`.
Guard 2 fails (`T0 >= S1`), so B resumes as a plain member. B is not on A's
stale list, A is the leader, A is not blocked, and A can now remove B. A
malicious A doesn't even have to guess the moment: `tokens.check` on its
leader token turns from `live` to `recoverable` when the group is dropped (10
checks a minute). An honest A whose phone was locked at handoff time gets the
same result by accident. Preconditions: a drop within about 25 min of A's
last leader activity. That is common in small groups, and no restart is
needed. Same impact as H1.

(b) Same `rt`. Inside a recovered line every grant has the same `rt = R`. B
leads with `(X, rt R)` and hands off to C `(Y, rt R)`, `Y > X`. Then a drop or
a restart, and B recreates first: `recoveredTerm = R`. C has `rt = R`, which is
not `> R`, so C can't supersede, and the stale B keeps the lead. Fewer
preconditions line up here than in (a) (a recovered line, then a handoff,
then a drop or restart), but it's the same class.

**Fix** (6.6.1 and 6.6.2, `resume.ts`, commit 13). Two changes: replace
"before this process started" with "granted before *this recreation*", and
order grants by the pair `(rt, term)`:
- On every recreation: `record.recoveredAt = now` (the clock at the
  recreation) and `record.anchor = (claims.rt, claims.term)` of the
  recreating token. A created group has no anchor.
- `canSupersede` = anchor defined (guard 1, unchanged)
  && `claims.role === 'leader'` && `claims.pid !== record.leaderId`
  && `claims.term < record.recoveredAt` (the grant predates this recreation,
  so no grant made in the recreated line qualifies, whether it was made
  before or after a restart)
  && `(claims.rt, claims.term) > record.anchor`, compared lexicographically
  (newer pre-recovery line first, then later grant within the same line)
  && `lat` and max-session checks. `processStartedAt` is no longer needed in
  the rule. Keep it only if you want it for logs or tests.
- On supersede: `record.anchor = (claims.rt, claims.term)`, `recoveredAt`
  unchanged, `term = nextTerm(max(record.term, claims.term), now)` (already
  planned; this is what keeps a superseded line's later tokens above the
  stale line's tokens on a later drop), and new tokens carry `rt = claims.rt`.
  `rt` issuance is unchanged: `recoveredTerm ?? term`, where `recoveredTerm`
  is `anchor.rt`.

Checked against 6.6.3 (`rA` = `recoveredAt`). Row 1: anchor `(T0,T0)`, B
`(T1,T1)`, `T1 < rA` and `(T1,T1) > (T0,T0)` -> supersedes. Row 2: M's
`m >= rA` -> member. Rows 3, 4, 7: A/M have a lower pair -> member/blocked.
Row 5: M recreates, anchor `(T0, m)`, B `(T1,T1)` is greater and `T1 < rA2`
-> supersedes. Row 6: both orders hold. Row 8: no anchor -> never. Row 9
**changes**, correctly: if the recreator is the latest leader, every other
token has a lower pair. If it is a stale leader, the later leader supersedes
(this is H2a). Row 10: C's `(T2,T2) > (T1,T1)` -> supersedes. Rows 11-13
unchanged. H2b: anchor `(R, X)`, C's `(R, Y)` is greater and `Y < rA` ->
supersedes.

Clock behaviour: `nextTerm` can run slightly ahead of `now` (same-ms grants),
and the clock can step back. In both cases a genuine token can have
`term >= recoveredAt`. That fails **closed** (no supersede, the residual M4
window), the same as the revision's clock-behind note. Document it with that
note.

Tests to add to `restart-handoff.int` / `resume.test.ts`:
- H2a without a restart: drop, then the stale A recreates, B supersedes and A
  is removed by B's list.
- H2a with A polling `tokens.check` until `recoverable`.
- H2b in both a drop and a restart variant.
- Row 9 rewritten (stale in-process recreator, then the later leader
  supersedes).
- A `canSupersede` truth table over the pair comparison, including equal
  `rt` with a lower, equal and higher `term`.

### No new medium or low findings

The rest of the diff is sound: the 6.8 check order, D14, D6 detaching, D10
protected entries, the L5 carve-out and the client clean-up. 11 still says
"after a restart" for the residual. It should say "after a restart or a
drop", because a drop opens the same stale-leader window (bounded by the
stale token's `lat`).

## Round 3 (plan revision 2, head ba8f60f)

Reviewed: `git show ba8f60f` (architecture.md D3, 4, 5.4, 6.5, 6.6,
6.6.1-6.6.3, 11, 12 AC26, 13.2, 14.1; `STATE.md`), and the resume path on
`main` (`group-service.ts` `resume` / `recreate`: classification and
recreation run inside `locks.run(groupKey)`).

**Verdict: FAIL.** The H2 fix is applied exactly and completely, and nothing
closed earlier regressed. But trying to break the revised rule turned up one
more high finding, H3. The `(rt, term)` pair keeps only the first and the
last step of a token's history, so the H1 trick (a handoff inside a
recreated line mints a term above every earlier grant) still works when it
is **laundered through a second recreation** inside one `rt`. My round 2
check (rows 5, 6, 18) only covered lines with a *different* `rt`, so I
missed it. Same root cause as H1, but not fixed by anything so far. A
pair or triple can't fix it (reason below). The fix is a lineage path in
the token.

### H2 fix: verification

| Item (round 2 fix) | Where in ba8f60f | Status |
|---|---|---|
| `recoveredAt = now` and `anchor = (claims.rt, claims.term)` on **every** recreation (restart or drop) | 4, 6.6 "Recreation", 6.6.1 | Done |
| `processStartedAt` removed from the rule | 4, 6.6.1 | Done |
| `canSupersede`: anchor defined, leader role, `pid !== leaderId`, `term < recoveredAt`, lexicographic `pairGreater`, `lat` + max session | 6.6.1 | Done, word for word |
| Supersede: anchor := requester pair, `recoveredAt` kept, `term = nextTerm(max(...))`, new token with `rt = claims.rt` | 6.6.2 steps 2, 6 | Done |
| `rt` issuance `anchor?.rt ?? term`; handoff and take-back inherit it | D3, 5.4, 6.5, 6.6 | Done |
| H2a drop without a restart (row 14) | 6.6.3, 12 AC26 | Done |
| H2a with `tokens.check` polling (row 15) | 6.6.3, 12 AC26 | Done |
| H2b drop and restart variants, both arrival orders (rows 16, 17) | 6.6.3, 12 AC26 | Done |
| Row 9 rewritten | 6.6.3 | Done, correct |
| `canSupersede` and `pairGreater` truth tables (equal `rt` with lower / equal / higher term) | 12 AC26 | Done |
| Clock note (fails toward "no supersede") and 11 wording "restart or drop" | 6.6.1, 11 | Done (wording nit L10) |
| Row 18 (architect's addition: repeated drop after a supersede) | 6.6.3 | Correct for its case (different `rt`) |

### Regression check (earlier findings and controls)

H1 (rows 1-8, 10-13 still hold), M1 (6.6.2 step 5), M2 (3.2 keys; the 12
AC43 test now also asserts `term`/`rt` survive), M3 (D10), M4 (11, 6.6.4,
RC14), L1 (6.6.2 step 1), L2 (D4), L3 (6.7), L4 (9.3), L5 (8.2), L6-L8,
Q-A to Q-E conditions (D5, D6, D9, D14, 6.8, 8.2), RC1-RC14 (14.1 table):
**all unchanged, no regression.**

### Attempts to break the revised rule

| Attempt | Result |
|---|---|
| Repeated drops, different `rt` (stale line `rt` T0, real line T1) | Holds: the stale line can never raise its `rt` (rows 5, 6, 18). |
| Repeated drops, **same `rt`** (inside a recovered line, or after a supersede) | **Broken: H3.** |
| Interleaved supersedes by two pre-recreation tokens (B then C, C later) | Holds: C's pair is greater and pre-recreation, so C supersedes B; B's new token has `term >= recoveredAt`. |
| Supersede, then the superseder's **new** token recreates after a drop | **Broken in the same-`rt` case: H3 path 2.** |
| Same-ms terms (`nextTerm` ahead of `now`, grant in the ms of the recreation) | Fails toward "no supersede". Accepted residual (see L10). |
| Clock forward step | Holds: `lat` and guard 3 use the same `now`, so a forward jump can't revive an expired token. |
| Clock backward step | Real leader can't supersede. Accepted residual (NTP, #10 D4); wording L10. |
| Token replay / refresh of an old leader token | Holds: `resign` keeps `term`/`rt` (RC5, row 13). A replay is the same grant. |
| Removed / blocked stale leader | Holds: requester's list first, stale list skipped (6.6.2 step 1, rows 1, 3, 4). |
| Vice-leader and grace handoff to an accomplice or second identity | Holds on its own (row 1). It is the minting step of H3. |
| Take-back inside a recreated line | Same minting as handoff (H3 path 3). |
| Two recreations racing for one dropped group | Holds: classification and `recreate` run under `locks.run(groupKey)` (`group-service.ts:735`); the second request is classified against the new record. One nit: L9. |
| Group created in this process, forged-looking token | Holds (guard 1, row 8). |

### High (blocking)

**H3. Inside one `rt`, a stale leader can launder a fresh in-line grant through a second recreation and keep the lead for good.**
Location: architecture.md D3, 5.4 (`rt = anchor?.rt ?? term`), 6.5 /
6.6 ("successor inherits `rt`"), 6.6.1 guard 4 (`pairGreater`), 6.6.2 step 6
(new token `(claims.rt, nextTerm)`), 6.6.3 rows 16-18.

Precondition: the group is in a **recovered line** (it was recreated once
after any restart or drop, e.g. a routine deploy), so its grants share
`rt = R`. Scenario (path 1, handoff):
1. B leads with `(R, X)` and hands off to C `(R, Y)`, `Y > X`. C removes B.
   B keeps its old leader token.
2. C disconnects alone, so the group is dropped. B polls `tokens.check` and
   recreates at once: anchor `(R, X)`, `recoveredAt = rA1`.
3. B joins a second identity M through its codes (or uses any connected
   member), makes M vice, disconnects. After the 30 s grace M leads with
   `(R, m)`, `m >= rA1 > Y`.
4. M disconnects alone, so the group drops again. M recreates: anchor
   `(R, m)`, `rA2`.
5. C arrives with `(R, Y)`: `Y < rA2`, but `(R, Y) < (R, m)`, so C gets a
   plain member resume. C is not on B's stale list. M (and B through M)
   leads for good and can remove C.

Arrival order doesn't save C. If C recreates first after step 4 (anchor
`(R, Y)`), M then **supersedes C**: `m < rA_C` and `(R, m) > (R, Y)`. The
whole thing takes about a minute after C's drop, and an honest removed B
whose client auto-recovers can trigger it by accident with any connected
member. Impact is the same as H1 and H2: AC26 is defeated permanently. The
preconditions are comparable to H2b. Rated **high**.

Path 2 (supersede token): in the same line, B supersedes an even staler
recreator A `(R, a)` and gets a new token `(R, z)` with `z = nextTerm(...) >
Y`. Then a drop, B recreates with `(R, z)`, and C `(R, Y)` loses. Path 3:
the same with a take-back grant.

Why the guards miss it: guard 3 stops an in-line grant from *superseding*,
but nothing stops it from *recreating*. A recreation turns its high term
into the anchor. `(rt, term)` keeps the first step (`rt`) and the last
(`term`) of the history, and loses the middle step (`X`) where C's history
and the fork split. **A fixed-size encoding can't fix this.** I worked
through `(rt, at, term)`, "anchor := the token's line anchor", and "grants
in an unconfirmed line can't recreate / supersede". Each one either fails
one nesting level deeper (one more recreate-and-handoff cycle, ~35 s each)
or breaks H2a/H2b for honest users. So don't try those.

**Fix (6.6.1, 6.6.2, D3, 5.4, `resume.ts`, `tokens.ts`; commits 1, 10, 12,
13): replace `rt` by a lineage path.**
- Token claim `lin: [r, t][]` (1..`MAX_LINEAGE` steps, `MAX_LINEAGE = 8`)
  replaces `rt`. The token's last step's `t` is its `term`. It goes in the
  fixed-order `payloadJson`, so `resign` keeps it (RC5). Schema: integer
  pairs, `t >= r`, every `t <= now + skew`, first step `t >= gct`.
- Record: `anchor: lin | undefined` and `lineAt: number | undefined`
  replace the pair anchor and `recoveredAt`. `lineAt` is unique and
  increasing per process: `max(now, lastLineAt + 1)`.
- Grants (create, handoff, take-back): with no anchor, `lin = [[0, term]]`.
  With an anchor, `lin = anchor ++ [[lineAt, term]]`.
- Recreation by `L`: `anchor = L`, `lineAt = new`, `term = last(L).t`. The
  recreator's refreshed token keeps `L`.
- Supersede by `L`: `anchor = L`, `lineAt = new`,
  `term = nextTerm(max(record.term, last(L).t), now)`. The requester's new
  token is `L ++ [[lineAt, term]]`.
- Order `cmp(a, b)`: step by step, and the first unequal step decides. For
  two steps, the **smaller `r` is greater** (of two recreations of the
  same parent, the earlier line is the real one: a later recreation by the
  bare parent token is by a stale copy). For an equal `r`, the larger `t`
  is greater. If one path is a prefix of the other, the longer one is
  greater.
- `canSupersede(record, L)` = anchor defined && leader role &&
  `pid !== leaderId` && `cmp(L, anchor) > 0` && **not in the current
  line** (`!(startsWith(L, anchor) && L[anchor.length].r === lineAt)`) &&
  `lat` && max session && `L.length <= MAX_LINEAGE`. Guard 3
  (`last(L).t < lineAt`) may stay as a redundant check.
- A grant whose `lin` would exceed `MAX_LINEAGE` is still made (the group
  goes on), but the token is marked so that it can neither recreate nor
  supersede (fail closed: the group ends on its next drop instead of being
  recovered). Re-check the 5.5 frame budget (`RECOVERY_EXTRA_BYTES`, token
  size; ~8 x 2 x 13 digits).

Checked: rows 1-18 keep their results, using `[[0, t]]` for created-group
grants (e.g. row 1: B `[[0,T1]]` > anchor `[[0,T0]]`, M
`[[0,T0],[rA,m]]` < B). H3 path 1: M is `K0 ++ [[r0,X],[rA1,m]]` and C is
`K0 ++ [[r0,Y]]`, so C > M at the step where they split. This holds at any
depth and in both arrival orders. "C descends from B's earlier honest line
and B recreates again with its bare token": C is `B ++ [[r1,c]]` and the
fork is `B ++ [[r2,m]]` with `r1 < r2`, so C wins. A displaced in-line
leader in a live group is in the current line, so it can't supersede (D4
unchanged). Paths 2 and 3 have the same shape.

Tests (`restart-handoff.int`, `resume.test.ts`): H3 path 1 with a drop and
with a restart at step 4, both arrival orders; path 2 (supersede token);
path 3 (take-back); three nested recreate-and-handoff cycles; "C extends
the stale anchor" (B recreates honestly, B -> C, C removes B, drop, B
recreates with its bare token, B -> M, drop, M recreates, C arrives -> C
supersedes); `MAX_LINEAGE` overflow -> no recreate and no supersede; a
`cmp` truth table (earlier `r` beats later `r` for the same parent, larger
`t` for an equal `r`, prefix < extension) and the current-line exclusion.
All of rows 1-18 again, with expected `lin` values.

### Low (advisory)

**L9. `recreate`'s `createIfAbsent === 'exists'` fallback calls
`leaderReturn` for any claims** (`group-service.ts` around line 870). It
can't be reached under the in-process lock, but after this change it would
grant leadership to a pid that isn't `record.leaderId`. Fix: re-run the
classification (supersede / member resume / blocked) instead of
`leaderReturn`. That is one line in commit 13.

**L10. Clock wording (6.6.1, 11).** "Fails closed ... until its own window
ends" overstates it. When the real leader can't supersede, the stale
recreator keeps the lead (it refreshes its own token), not only until a
window ends. State it as an NTP-dependent residual (#10 D4): a backward step
larger than the time between the real leader's grant and the recreation
lets the stale line win. With the lineage fix the same assumption also
orders two recreations of one parent across a restart (`r`).

### Accepted residuals (not findings)

- The M4 recreation window (the stale recreator leads until the real leader
  arrives inside its own `lat` window). Inherent without persistence.
- A real leader that doesn't return within its `lat` window (~25 min) never
  supersedes. Intended bound.
- Clock steps back by more than the gaps above (L10). NTP assumption.
- A stolen current token is equivalent to its holder (out of scope, #5).

### Required controls: changes from round 3

| # | Control | Commit(s) |
|---|---|---|
| RC5 (amended) | Token format 2 carries `term` and `lin` (not `rt`) in the fixed-order `payloadJson`; schema per the H3 fix; v1 -> `TOKEN_INVALID`. | 1 |
| RC6 (amended) | H1/H2/H3: lineage `lin`, record `anchor` (path) + `lineAt`, `cmp`, current-line exclusion, new token on supersede, `MAX_LINEAGE` fail-closed; rows 1-18 plus the H3 tests. | 10, 12, 13 |
| RC15 | The recreation fallback re-classifies; never `leaderReturn` for a pid other than `record.leaderId` (L9). | 13 |
| RC16 | 6.6.1 / 11 wording per L10; the README residual paragraph mentions the NTP assumption. | 23 |

Everything else in section 5 stands as written.

## Round 4 (plan revision 3, restart-only rescope, heads f40b673 + 550d181)

Reviewed: `git diff ed3257d..550d181` (architecture.md D3, D4, D15, 4, 5.4,
6.4-6.6.4, 6.9, 10, 11, 12, 12.1, 13.3, 14, 15; spec.md AC14, AC19, AC21,
AC26, AC27, AC37, AC45, rescope note; `STATE.md`), and on `main`:
`token-service.ts` (`issue` sets `iat` from `now`; `resign` keeps every
claim, used only for key rotation in `tokens.check`), the token refresher
(issues a fresh token through `issueToken`, so a refresh gets a new `iat` and
the record's `lat`), `ended-groups.ts` (one global map for all namespaces),
`resume.ts`, and `group-service.ts` `resume` (classification and recreation
under `locks.run`), `disconnect` / `leaderOffline` / `leave` (the three
`dropGroup` sites) and `endGroup`.

**Verdict: PASS.** No critical or high finding. The rescope removes the
whole H1-H3 class inside a running process: a group is recreated at most
once per process, and only from tokens of an earlier process. What is left
needs two operator restarts (R-2R) and is acceptable as a residual. Trying
to break the new mechanisms found one medium (M5, cross-app availability)
and three lows (L11-L13). I make M5's fix, L11 and L12 required controls
because each is a few lines and the plan is not built yet.

### Round 1-3 findings: status

| Finding | Status in revision 3 |
|---|---|
| **H1** (stale recreator hands off in-process, new term beats pre-restart terms) | **Closed** for one restart: guard 3 (`term < recoveredAt`) plus the `nextTerm` floor (D3) make "no grant made in this process supersedes" structural, also with a clock step back during the process. Two-restart form = R-2R, accepted residual. |
| **H2a** (drop without restart, stale recreates first) | **Closed.** An emptied group ends (D15). Its tokens get `ended` from the entry, and from the `iat` fence if the entry is gone. `tokens.check` never turns `recoverable` in the same process (rows 11, 12). |
| **H2b** (same `rt` inside a recovered line) | **Closed.** `rt` is gone. Inside one restart, pre-restart grants of one group are compared by term, which is the order the previous process made them in (strictly increasing per group, also when that process was itself a recovered one). Row 14. |
| **H3** (launder an in-line grant through a second recreation) | **Reduced to R-2R.** Every path needs a second recreation. In one process that is impossible (6.9 layers 1-3); across processes it needs a second restart. |
| M1-M4 | Unchanged (6.6.2 step 5; 3.2 logger keys; D10; 6.6.4 + section 11, now also lists "end by emptying", row 13). No regression. |
| L1-L8 | Unchanged (6.6.2 step 1, D4, 6.7, 9.3, 8.2, 11, 10). No regression. |
| L9 / RC15 | Closed: the `exists` fallback re-classifies (6.6 "Recreation"), store-stub test in 12. |
| L10 / RC16 | Closed: 6.6.1 "Clock" and section 11 state the residual plainly ("keeps the lead for good"), README notes in 10. |
| Q-A to Q-E conditions | Unchanged (D6, D9, D5, D14, 6.8/8.2; 14.3). |
| RC1-RC16 | Mapped in 14.1; RC6 reworded for the restart-only rule; RC17 (new) in commit 2a. |

### Attempts to break the new mechanisms

| Attempt | Result |
|---|---|
| **`iat` fence: does a refresh keep `iat`?** | No. The refresher issues a new token through `issueToken` (`iat = floor(now/1000)`, `lat = record.lastActivityAt`). Only `resign` keeps `iat`, and it is used only to re-sign a pre-existing token for key rotation. A refreshed token is always "issued here", which is the safe direction. The plan's 5.4 wording ("a refresh (`resign`) keeps it") conflates the two; the engineer must not route the refresher through `resign` (code-mode check). |
| Token minted by the old process in the start second | Counts as issued here, so the group is `ended` instead of recovered. Fail closed, documented, tested (12 AC26). |
| Token minted by the new process in its first second | `now >= processStartedAt` gives `iat >= floor(processStartedAt/1000)`. No gap, as long as `processStartedAt` is read from the same injected clock before any token is issued. |
| Clock step back **across** a restart | Old tokens can look "issued here", so `ended`: fail closed for the fence. The supersede side is the L10 residual (stated). |
| Clock step back **during** the process, below `processStartedAt` | Tokens issued after the step look pre-restart to the fence. That only matters if the group's ended entry was also evicted (plain entries go first). Needs a step larger than the uptime, which is realistic only right after start (a host that boots with a fast clock and is corrected by NTP a few minutes later). **L11**. |
| Old-process token with `term >= recoveredAt` (term bumped ahead of `now` by `prev + 1`, or skew) | Would break the invariant `anchorTerm < recoveredAt`, so no supersede ever: fail closed, but untested. **L11** (one-line clamp). |
| Ended-groups eviction of a **plain** entry | Safe: a group created in this process has only tokens issued here (fence). A guarded entry past `guardUntil` is safe too: every pre-restart leader token has `lat <= processStartedAt` (NTP), so it is `lat`-expired by `processStartedAt + limit + refresh.maxMs + skew`. Same app config in both checks. Holds. |
| Pre-restart **member** token of a group whose guarded entry passed its guard and was evicted | `waiting`, parks until the parking timeout. No leader can recreate (old leader tokens `lat`-expired, new ones fenced). Harmless; `tokens.check` says `waiting` for an ended group. Accepted. |
| **Cap rule (b), "recovery closed for the app"**: can an attacker deny service to other groups? | Yes, in a narrow window, and **across apps**: `EndedGroups` is one map for every namespace, and rule (b) evicts the **oldest** guarded entry, which closes recovery for **that entry's** namespace, not the flooder's. **M5**. |
| Order of `tokens.check` vs resume | One `classifyToken` for both (6.9). Resume classifies and recreates under the group lock (`group-service.ts` resume, `locks.run`), so the entry, fence and closure reads and the recreation are atomic. `tokens.check` reads outside the lock but changes nothing. Holds; code-mode check that the new `ended` / `issuedHere` / `recoveryClosed` inputs are read inside the lock in resume. |
| Races at the moment a group empties (joins, resumes, approvals) | Join, resume and admit run under the same group lock as the end, and the end releases codes and fails pending approvals inside the lock. A resume after the end hits the entry or the fence. Holds. **One race does not**: a stale socket close processed after the same participant's new session resumed. **L12**. |
| New `canSupersede` | Holds. The only tokens issued in this process with `term < recoveredAt` are the recreator's refreshed / member tokens carrying the recreation term, which equals the anchor (guard 4 is strict) or is below a later anchor. Every grant has `term >= recoveredAt` (floor). Equal terms never supersede (row 7). Member tokens never supersede (role). |
| Second recreation inside one process | Impossible: entry first, then the fence for tokens issued here, the guard for pre-restart tokens, and closure if a guarded entry must go. |
| Stale recreator empties or ends the group before the real leader arrives (row 13) | It can end it for good in this process. That is the M4 residual, already listed (section 11). Availability only. |
| Two server instances running at once on one keyring (rolling or blue/green deploy) | The restart model breaks: the old process can keep minting grants with terms above the new process's `recoveredAt`, and the two can both host a group. **L13** (operating assumption, docs only). |

### Medium (advisory, fix made a required control: RC20)

**M5. A flood of guarded ended entries closes recovery for other apps after a restart.**
Location: architecture.md 6.9 layer 3 (b), `ended-groups.ts` (one global map).
Scenario: an attacker in any app keeps creating groups and ending them (there
is no `group.create` budget today) so that, whenever an operator restarts,
it holds a large stock of old-process leader tokens with fresh `lat`. In the
~25 min after the restart it recreates and ends them (resume + `group.end`)
until 100 000 guarded entries fill the map. From then on each new guarded
entry evicts the oldest guarded one, which closes recovery for **that
entry's** namespace. Honest apps whose recovered groups ended early in the
window get closed first. While closed, their not-yet-recovered groups' tokens
get `ended`, and clients delete them, so those groups are lost. No control
is gained (it fails closed), the window is bounded by `guardUntil`, and it
needs heavy volume timed around a restart the attacker can't trigger. Hence
medium, not high.
Fix (RC20, commit 2a): at rule (b), evict the oldest guarded entry of the
namespace that holds the **most** guarded entries (keep a per-namespace
count), so closure lands on the flooding app. Also add a per-connection
budget for recreating resumes (for example the join-attempt budget), which
slows the stock-up and the fill. Unit test: two namespaces, cap 3, the one
with more guarded entries is closed, the other is not.

### Low (advisory; L11 and L12 made required controls RC18, RC19)

**L11. The fence and the anchor invariant depend on the clock without a floor.**
Location: 6.9 layer 2, 6.6 "Recreation", `token-service.ts` `issue`.
(a) A clock step back during the process to before `processStartedAt` makes
new tokens look pre-restart. Combined with an evicted plain entry, such a
token could recreate the ended group in the same process (the H2 class, under
a clock fault). (b) A pre-restart token with `term >= now` at recreation
(skew, or `prev + 1` bumps) gives `anchorTerm >= recoveredAt`.
Fix (RC18): `issue` uses `iat = max(floor(now/1000),
floor(processStartedAt/1000))`. If the step is larger than the skew, such
tokens then fail plausibility, which fails closed. At recreation,
`recoveredAt = max(now, claims.term + 1)`. Tests: injected clock stepped
below the start, entry evicted, then the token gets `ended`; recreation with
`claims.term = now + 5` keeps `anchorTerm < recoveredAt`.

**L12. A late close of a participant's old socket can end a group that has a connected session.**
Location: 6.9 trigger, `group-service.ts` `disconnect` (ownership check by
`notifier.unregister` runs **before** the lock), `leaderOffline`.
Scenario: the client reconnects and sends `group.resume` on a new socket. The
old socket's close is processed while that resume waits for the lock:
`unregister` still succeeds (the old session owns the key), the resume runs
first (leader return, new session registered), then the queued disconnect
marks the leader offline and, with nobody else connected, ends the group
`empty`. The leader is attached, which the "no frame, nobody attached"
assumption excludes. Today that is a recoverable drop. With D15 it is a
permanent end. Members have the same race. Availability only, no attacker
control, rare.
Fix (RC19, commits 2/2a): inside the lock, before pausing or ending, check
that no open session is registered for that `(group, pid)`
(`isParticipantConnected`), and return if one is. `endGroup(..., 'empty')`
asserts `connectedCount === 0` and no attached session. Test with the
scheduler holding the lock across the resume and the close.

**L13. Single-instance assumption not stated.**
The restart rule and the fence assume the old process has stopped issuing
before the new one serves (no overlap on one keyring). Fix: add one sentence
to the README operating assumptions (RC14/RC16 docs chunk): stop the old
instance before starting the new one; no replicas.

### Accepted residuals (not findings)

- **R-2R** (6.6.3 row 19): see the Q-F recommendation below.
- **M4 window** after a single restart, including "stale recreator ends the
  group by emptying it" (row 13).
- **Clock step back across a restart** (L10): stated, NTP assumption.
- **Ended-groups memory lost on restart** (row 18, #5).
- **Product cost of D15**: a solo leader's blip or a shared Wi-Fi outage
  ends the group. In frozen mode, the last connected member can now end a
  group whose leader is briefly offline by leaving or disconnecting. Before,
  that was a recoverable drop. This is availability and was decided by the
  user. Q-G softens it.

### Gate 2 Q-F (close R-2R with an `rcv` claim): security recommendation **No**

R-2R needs, all at once: two operator restarts inside one leader's `lat`
window (~25 min, at most ~65); a **malicious** former leader who kept its old
leader token (an honest client replaces it with a member token on
`leader.lost` / member resume, and deletes it on removal); that party online
right after restart 1 and before the real leader; a P2 grant (accomplice or
second identity plus the 30 s grace); and the real leader absent for **all**
of P2 (if it connects during P2 it supersedes, row 1). The impact is one
group taken over for good. Restarts are operator actions, so it is
acceptable as a documented residual, with operator guidance: avoid a second
restart within inactivity limit + refresh slack of the first while groups
are live (a deploy followed by a quick rollback is the realistic case).

Q-F as written is **worse**, not just costlier. With `rcv`, after a second
restart only tokens from the first process can recreate. Example: P1 A -> B,
B removes A. P2: B recreates honestly and its tokens get `rcv`. P3: B can't
recover, and A's kept P1 token (still inside its `lat` window) **recreates
and leads, and nothing can supersede it**. That is the H1 impact with fewer
preconditions than R-2R: no accomplice, and no need for the real leader to
stay away. The architect's "recovers it to that older leader" is this case.
Under the plan as written, the same P3 sequence is correct (B's or its
successor's P2 term is above A's and below `recoveredAt`, so it supersedes A).
Closing R-2R properly needs server persistence or the lineage path, both
out of scope by user decision. **Recommend: do not take Q-F; accept R-2R
with the README note** (already in 10) plus the operator guidance above.

### Gate 2 Q-G (hold an empty group for the grace period): **safe to choose, with controls RC21**

The record stays in memory during the hold and leaves only through
`endGroup('empty')`, with the same entry, guard and fence. So nothing is
dropped and nothing can be recreated in the process, and H1-H3 do not come
back. Supersede during the hold follows 6.6.1 as for any live record. Two
real risks need controls:

1. **Ownerless-group capture.** During the hold nobody is connected. A
   stranger who joins by code or QR becomes the only connected member and,
   in `auto` mode, the successor when the grace ends. They get the codes,
   the block list and removal power. Today there is no such window (it ends),
   and with members connected the stranger is last in admission order.
2. **Lingering records.** Grace end with no candidate today means "act like
   frozen: stay paused until the frozen bound" (~25 min). Applied to an empty
   group, that would keep ownerless records (and their join codes) for 25 min
   instead of 30 s.

Required controls if Q-G is chosen (**RC21**, commit 2a, `empty-end.int`):
- (a) While held (leader offline and `connectedCount === 0`), every new
  admission is refused: code, QR, `join.approve`, the admit-step re-check.
  Use exactly the locked-group path (D14 order, byte-identical
  `GROUP_LOCKED`) so the hold is no new oracle. Only token resumes (D4,
  block list applies) may re-attach.
- (b) One deadline: the hold uses the existing `pause.graceEndsAt`. A resume
  during the hold never extends it ("keeps its earlier `graceEndsAt`", 6.4).
  The hold length is the app's `disconnectGraceSeconds` (ceiling-bounded).
- (c) At that deadline, under the lock, re-read the record. If still nobody
  is connected, `endGroup('empty')` at once, in **both** `auto` and `frozen`
  mode. Never fall back to the frozen bound for an empty group. If someone is
  connected, the normal 6.4 path (handoff or frozen) applies.
- (d) Handoff candidates stay as in 6.5 (the displaced leader is never one).
  A member resuming during the hold may become the successor at the deadline,
  which is today's `auto` behavior for a connected member.
- (e) Max session, frozen-end and limiter cleanup unchanged; the L12 re-check
  (RC19) applies to the hold trigger too; stale-timer check by
  `term` / `pause`.
- (f) Tests: a code/QR/approval during the hold gets `GROUP_LOCKED` and no
  admission; the leader returns inside the hold and keeps the lead with no
  role change; a member resumes inside the hold and the handoff happens at
  the original deadline (not later); a frozen-mode empty group ends at the
  hold deadline; held then ended, then resume and `tokens.check` give
  `ended`; a recreated group (after a simulated restart) held, then B
  supersedes inside the hold.

Memory: held records are bounded by connection churn x 30 s. That is less
than an attacker holding connections open today. #12 remains the general
cap. No extra control needed beyond (c).

### Required controls: changes in round 4

| # | Control | Commit(s) |
|---|---|---|
| RC17 (confirmed) | As in 6.9; plus: the resume path reads the entry, `issuedHere` and `recoveryClosed` inside the group lock; the refresher keeps using `issue` (new `iat`), never `resign`. | 2a |
| RC18 (L11) | `iat` floored at `floor(processStartedAt/1000)` in `issue`; `recoveredAt = max(now, claims.term + 1)`; the two tests in L11. | 1/2a, 13 |
| RC19 (L12) | Under the lock, the empty trigger (and any pause on disconnect) returns if an open session is registered for that pid; `endGroup('empty')` asserts nobody is attached; race test. | 2, 2a |
| RC20 (M5) | Cap rule (b) evicts from the namespace with the most guarded entries; per-connection budget on recreating resumes; two-namespace unit test. | 2a |
| RC21 (Q-G, only if chosen) | Hold controls (a)-(f) above. | 2a |
| RC14/RC16 (docs) | README adds: single instance, stop the old one before starting the new one (L13); operator guidance for R-2R (no second restart within inactivity limit + refresh slack while groups are live). | 23 |

### What I will check in code mode (additions)

- The 6.9 classification order, identical for `tokens.check` and resume, and
  resume's inputs read under the lock.
- No `dropGroup` left; every former site calls `endGroup(..., 'empty')`
  behind the RC19 re-check; no `group.ended` frame for `empty`.
- `EndedGroups`: two maps, `remember` deletes the ref from both before
  re-inserting, the eviction order, per-namespace closure (RC20), warning
  rate, sweep.
- `canSupersede` matches 6.6.1 and the 12.1 table, `nextTerm` floor, RC18
  clamps, the invariant `anchorTerm < recoveredAt`.
- The R-2R test exists and asserts today's outcome; the Q-G tests if chosen.

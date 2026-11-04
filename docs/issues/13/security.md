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

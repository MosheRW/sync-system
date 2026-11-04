# Spec: #13 Roles, timers and group lifecycle (PRD item 5)

Issue: https://github.com/MosheRW/sync-system/issues/13
Source PRD: `docs/PRD Group Reading Sync.md` (sections: Roles, Leader view, Timers, Group lifecycle, Limits, Tokens, Removed members)
Path: full | Type: feat | PRD item 5 of 9
Numbering: GitHub issue numbers are not PRD item numbers. "Item N" means PRD item N of 9. Item 1 = GitHub #1 (server core), item 2 = #3 (core client), item 3 = #5 (tokens and recovery) plus hardening #7, item 4 = #10 (join methods A-D). All are merged to `main`.
UI impact: **none.** This item is server and core-client behavior only. All screens (keep-alive prompt, "you're now leading", take-back prompt, roster, preview banner, lock/remove controls) are items 7-8.

## Problem / motivation

The server today knows two roles (leader, member) and a leader disconnect only freezes the group (#5). Earlier specs deferred everything else to "item 5":

- #1: vice-leader, remove member, lock group, preview mode, timers, group lifecycle, leadership handoff, keep-alive, display and generated names. The timer values were recorded there and accepted at Gate 1.
- #5: the grace period, automatic handoff, keep-alive prompt, live inactivity enforcement while the leader is online, "you're now leading" moments, the member roster, the "remove member" action (only the block list was delivered), and a rule for role changes and token re-issue.
- #10: lock group, remove member plus the roster, automatic code rotation on removal, generated names and names for the roster, whether the vice-leader sees codes.
- #3: client state for "leader offline, grace period".

This item delivers those: the vice-leader role, the leader's lock / remove / preview tools, live timers (disconnection grace, inactivity with keep-alive, max session), automatic handoff with take-back, and display / generated names. It is the most security-sensitive item since #5: it changes who can control a group.

## Decisions carried in (already settled)

- Timer defaults and env ceilings recorded in #1 (accepted at Gate 1 there): grace 30 s / 120 s, inactivity 20 min / 60 min, keep-alive countdown 60 s / 120 s, max session 3 h / 8 h. Inactivity and max session already exist as app config with env ceilings (#5 AC4); this item adds grace and keep-alive countdown in the same pattern (app value, env ceiling, value above ceiling is a startup error, not clamped; #1 AC5).
- Lock tolerance: 30 s (#1). The grace default equals it.
- The server never reads the position or group metadata. Preview positions are never sent to the server.
- Tokens hold no personal data and no names (PRD). The block list lives in the leader's client (PRD; #5).
- Nothing is persisted on the server. Names, participant IDs and tokens are never logged.

## User stories

- As a **leader whose phone locked**, I want a grace period before anything changes, so that a brief lock does not hand my group away.
- As a **leader who steps away**, I want the group to pass to my vice-leader or the longest-connected member after the grace period (if I chose automatic handoff), so that the session continues.
- As a **leader who chose "frozen"**, I want the group to wait for me instead of handing over, so that nobody else can take control.
- As a **leader**, I want to designate a vice-leader after people join, so that I decide who takes over first.
- As a **leader**, I want a keep-alive prompt before the inactivity limit, so that an idle but present group is not closed on me.
- As a **leader**, I want to remove a member so that they stay out, even if they know the codes, so that I can protect a session.
- As a **leader**, I want to lock the group, so that nobody else joins once everyone is in.
- As a **leader**, I want to browse ahead privately without moving the group, so that I can prepare (the UI is items 7-8).
- As a **member who becomes leader unexpectedly**, I want a clear "you're now leading" signal, so that I know people are following me.
- As a **returning original leader**, I want to rejoin the live group and choose whether to take the lead back, so that I am not silently demoted or silently overriding my replacement.
- As a **member, vice-leader or leader**, I want a name I chose or a generated one, so that the leader can recognize people without accounts.
- As a **user who may be a minor / operator**, I want names and IDs kept out of logs and not stored after the session, so that nothing personal outlives it.
- As a **client app developer**, I want typed events and methods in the core client for all of this, so that item 6 and item 8 can build UI on them.

## Proposed design decisions (confirm at Gate 1; each also appears under Open questions)

1. **The server record is the only authority for roles.** Every privileged action checks the participant's *current* role in the live group record (and the connection's identity), never the token's role claim or a cached session role (same discipline as #10 R12/M4). The token role is only a hint for recovery.
2. **Handoff changes the token.** The new leader gets a new leader token; the displaced leader's old leader token must not let it silently regain control. Proposed: a leadership term number in the token (see Q2.6).
3. **Recovery state travels with the leader's client**, like the block list (#5): block list, lock flag, vice-leader's participant ID and the handoff mode. On handoff the server hands this state to the new leader's client so it survives a later restart.
4. **Preview is client-side.** The server only learns "the leader is active" through a lightweight activity signal; it never sees the previewed position.
5. **Durations on the wire, not clock times.** Countdowns and grace periods are sent as remaining milliseconds, so client clock skew (parked follow-up #9) cannot affect them.
6. **Timers are server-driven and per group**, all cancelled when a group ends for any reason, including when it empties (extends #5 R7: `server.close()` leaves zero pending timers).

## Acceptance criteria

### Configuration and defaults
- [ ] AC1. Apps config gains `disconnectGraceSeconds` (default 30) and `keepAliveCountdownSeconds` (default 60), each with an env ceiling (defaults 120 and 120; proposed `DISCONNECT_GRACE_SECONDS_CEILING`, `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING`). A value above its ceiling is a startup error (not clamped), consistent with #1 AC5. Existing `inactivityLimitMinutes` (20, ceiling 60) and `maxSessionMinutes` (180, ceiling 480) are unchanged.
- [ ] AC2. Startup validation rejects `keepAliveCountdownSeconds` greater than or equal to the app's `inactivityLimitMinutes` in seconds, and non-positive or non-integer values, with a `Config error:` naming the field.
- [ ] AC3. Apps config gains a default handoff mode (`auto` or `frozen`; proposed default `auto`, Q2.1). `group.create` accepts an optional `handoff` choice; when absent the app default applies. Unknown values are rejected as invalid input.
- [ ] AC4. The README documents all timers, defaults, ceilings and the handoff mode in one table.

### Roles and permission checks (security-sensitive)
- [ ] AC5. Roles are `leader`, `vice-leader` (one at most) and `member`. The role of each participant is part of the roster the leader sees (AC31).
- [ ] AC6. Every leader-only action (`group.update`, `group.end`, `codes.rotate`, approve / deny, remove member, lock / unlock, set / clear vice-leader, leader activity, keep-alive answer, and all other existing leader actions) is checked against the participant's current role in the live group record at the moment it is processed. A former leader, a member, a vice-leader, a parked participant and a pending joiner all get `NOT_LEADER` and no state change. Test matrix: every leader-only action x every non-leader role x stale-role cases (action sent right after a handoff or demotion, with the old connection still open).
- [ ] AC7. The vice-leader gets no leader powers before becoming leader (it cannot update the position, remove, lock, rotate, approve, end the group, or see codes; Q3.2).
- [ ] AC8. Leader-only actions are serialized per group with handoff, take-back, removal and end, so there is never a moment with two leaders. Test: a leader action racing a handoff gets either full effect (before) or `NOT_LEADER` (after), never both.
- [ ] AC9. Privileged actions have per-group rate limits (remove, lock / unlock, vice changes, take-back, leader activity) returning `RATE_LIMITED` with `retryAfterMs`, so a compromised or buggy client cannot flood the group with events.

### Vice-leader
- [ ] AC10. `vice.set { participantId }` (leader only) designates an admitted, currently present member as vice-leader. Designating a pending joiner, a parked participant, the leader, a removed member or an unknown ID is rejected without revealing whether the ID exists in another group. At most one vice-leader: setting a new one replaces the old one. `vice.clear` removes it.
- [ ] AC11. The designated vice-leader is told (event), as is the previous one when replaced or cleared. Other members are not told who the vice-leader is (Q3.3).
- [ ] AC12. If the vice-leader leaves, is removed or becomes leader, the designation is cleared. A temporary disconnect does not clear it, but handoff only picks a *connected* vice-leader (AC20).
- [ ] AC13. The vice-leader designation is part of the recovery state the leader's client holds (decision 3), so it survives a server restart. A recovered designation is validated against the rejoining participants; a stale or unknown ID is ignored.

### Timers: disconnection grace, inactivity, keep-alive, max session
- [ ] AC14. **Disconnection timeout.** When the leader's last connection drops **and at least one other participant is connected**, the group freezes (existing #5 behavior, members told) and a grace timer of the app's `disconnectGraceSeconds` starts. **If nobody else is connected, the group ends at once (AC27).** If the leader resumes within the grace period, the group unfreezes, the leader is still leading, and no role changes. The frozen event carries the remaining grace as a duration.
- [ ] AC15. **Inactivity limit.** The server tracks the leader's last activity in memory while the leader is online. Counted: accepted position updates, preview activity (AC30), keep-alive answers, and accepted leader actions (lock, remove, rotate, vice changes, approve / deny). Not counted: rejected, rate-limited or non-leader actions, member actions, transport heartbeats, and the leader merely being connected. The existing token last-activity refresh (#5) keeps working from the same signal.
- [ ] AC16. **Keep-alive.** At `inactivityLimit - keepAliveCountdown` of leader inactivity the server sends the leader a keep-alive prompt carrying the remaining countdown (a duration). Any counted leader activity, or an explicit `keepalive.ack`, cancels the countdown and restarts the inactivity timer. Members are not sent the prompt.
- [ ] AC17. **Missed keep-alive (first leader).** When the countdown ends unanswered, the group freezes for the grace period exactly as in AC14, then follows the handoff mode (AC20, AC21). Q1.2 records the alternative.
- [ ] AC18. **Max session time.** Enforced for every group, whoever leads and in every state (live, frozen, handoff pending), measured from group creation; at expiry the group ends for everyone with reason `max_session`. A handoff does not extend it, and the new leader's token keeps the original creation time. (Already enforced in #5; add tests for the live states introduced here.)
- [ ] AC19. Timer tests use the injected `ManualScheduler` (no real sleeps) and prove: no timer fires after a group ends (for any reason, including when it empties), and `server.close()` leaves no pending timer.

### Group lifecycle: handoff, take-back, end
- [ ] AC20. **Automatic handoff** (mode `auto`). When a grace period (AC14 or AC17) lapses with the leader still away, leadership passes to the connected vice-leader, or, if none, to the longest-connected member (Q2.2 defines "longest-connected"). Pending joiners and parked participants are never candidates. The new leader's inactivity timer starts fresh and the old leader becomes a member (role change in the record).
- [ ] AC21. **Frozen mode.** The group never hands off. It stays frozen until the leader returns, bounded as today (inactivity limit plus refresh slack, #5 AC18-AC21) and by max session; after a missed keep-alive the group ends at that bound (Q1.3). If there is no eligible candidate in `auto` mode (the leader is still connected but inactive and no other participant is connected), the group behaves like frozen mode. A leader who disconnects with nobody else connected ends the group (AC27).
- [ ] AC22. **One-step escalation.** If a leader who gained the lead through a handoff caused by a *missed keep-alive* also misses the keep-alive, the group ends with reason `inactivity` when that countdown ends. There is no second handoff in that chain. (Q2.3 covers a new leader that merely disconnects.)
- [ ] AC23. **"You're now leading".** The new leader receives a distinct event (reason: `handoff_disconnect`, `handoff_inactivity` or `take_back`), a new leader token, and the recovery state (block list, lock flag, vice-leader, handoff mode, current codes, pending approvals). Other participants receive a leader-changed event with no participant IDs beyond what each role may see. The displaced leader's client is told it is no longer leading if it is connected.
- [ ] AC24. **Original leader returns.** The displaced leader presenting its old token to the live group rejoins as a member with a "take-back offered" notice. It does *not* regain control by presenting its old leader token (decision 2, Q2.6). A `leader.takeBack` request from the *most recent displaced leader* (Q2.4) swaps roles: it becomes leader, the current leader becomes a member and is told. Any other participant requesting it gets `NOT_ALLOWED` and no state change.
- [ ] AC25. After a take-back, the displaced-leader slot holds the leader who was displaced by it, and inactivity timers restart for the leader who now leads. The take-back offer expires if the group ends.
- [ ] AC26. **Server restart after handoff.** Takeover by presenting a token happens only after a server restart. After a restart, of the leader tokens granted before the restart (and still inside their `lat` and max-session bounds), the one with the latest leadership term wins: a stale older leader token presented first recreates the group and is then superseded and demoted when the later token arrives (Q2.6); no grant made after the restart can supersede. Tests cover both arrival orders. Residuals (documented in the README): two restarts within one leader's inactivity window, and a server clock that steps back across a restart.
- [ ] AC27. A group ends (all members told where anyone is attached, tokens deleted by clients, group removed from memory and recorded in ended-groups memory per #5) when: the leader ends it (`ended_by_leader`), max session expires (`max_session`), inactivity goes unanswered by both the leader and the next in line (`inactivity`, AC22), the frozen bound passes (`leader_timeout`), or nobody is connected any more (`empty`: logged only, since nobody is attached to be told; later resumes get `GROUP_ENDED` and `tokens.check` reports `ended`). Each ends with a distinct reason. **An ended group can't be recreated in the same server process by any token.**
- [ ] AC28. Members get status events for every lifecycle state: live, frozen with remaining grace (leader offline or leader inactive), leader changed, ended with reason. The core client maps these onto its connection / leader state for the item 8 indicator, extending #3 AC25 with "leader offline, grace period".

### Lock, remove, roster, preview
- [ ] AC29. **Lock group.** `group.lock` and `group.unlock` (leader only, idempotent) pause *all new joining* by every method (A-D and approvals completing). Rejected with a distinguishable `GROUP_LOCKED` error, the same for every method so the lock is not an oracle for codes. Existing members (including vice-leader and leader) rejoin by token as usual while locked. Pending approval requests (method B) are not admitted while locked (Q4.2). The lock is visible to the leader and to members in group state. The lock is distinct from #10's automatic door-code pause; both can exist, and unlocking never lifts a door-code pause and vice versa.
- [ ] AC30. **Preview mode (server side).** `leader.activity` (leader only, rate-limited, no payload) counts as leader activity (AC15). The previewed position is never sent to, stored by, or logged by the server. No new protocol field carries a preview position.
- [ ] AC31. **Roster.** The leader gets, and keeps in sync with events, a roster: participant ID, display name, role, connected flag, join time, for every admitted participant, plus a count. Members never receive other participants' IDs or names (Q4.4). A pending joiner, a parked participant and a removed member are not on the roster.
- [ ] AC32. **Remove member.** `member.remove { participantId }` (leader only): the participant's live connections are closed after a distinct `removed` event (no other detail), the participant is added to the block list, the block list is returned to the leader's client for persistence (#5), and group codes are rotated (Q4.1) so that a removed person who knows the codes cannot rejoin with a new identity. Removing the leader, oneself or an unknown ID is rejected. Removing the vice-leader clears the designation.
- [ ] AC33. A removed member cannot get back by any path: token resume, a join code, a QR ticket or approval with the old identity (block list), and the rotation invalidates all outstanding codes and QR tickets (#10). A test attempts every path.
- [ ] AC34. The block list has a size cap (reuse the #5 limit) and `member.remove` on a full block list fails with a distinguishable error rather than evicting entries.

### Display names and generated names
- [ ] AC35. `group.create`, join requests (`group.joinByCode`, `group.joinByQr`) and token resume accept an optional display name, 1-32 characters after trimming, no control characters, and (Q5.5) no bidi override or isolate characters. Invalid names are rejected as invalid input; the same rule applies to the creator, to joiners and to the name shown in `join.requested` (#10 AC20).
- [ ] AC36. A participant with no name, or a blank one, gets a generated name (Q5.1) that is unique in the group and carries a `generated: true` flag so apps can localize it. The name is held in memory only for the life of the participant in the group and is not part of the token.
- [ ] AC37. A returning member (token resume, after a reconnect or a server restart) may send its name again; with no name it is generated again. Names are never put in tokens, logs, error messages or metrics.
- [ ] AC38. Names are plain text. The server never interprets them. (The reading app escapes them in items 7-8; the README states the rule for app developers.)

### Core client and protocol
- [ ] AC39. `@sync-system/protocol` gets typed, validated messages for every new request / event above, with maximum field lengths. Protocol version stays 1 (nothing released; same reasoning as #5 Q13 and #10 Q2.1; Q7).
- [ ] AC40. The core client gets methods and typed events: set / clear vice-leader, lock / unlock, remove member, answer keep-alive, `leader.activity`, take back, read the roster and lifecycle state, handoff mode at creation, display name option, "now leading" and "removed" events. It persists and re-sends the recovery state (decision 3) alongside the block list, and replaces its leader token on handoff. It stores nothing new in tokens.
- [ ] AC41. Core client **preview helper** (framework-free): `startPreview()`, `endPreview()`, a `preview` state with `groupPosition` and `previewPosition` (client-held, opaque), `bringGroupHere()` (sends a normal position update) and `returnToGroup()`. While previewing, the leader's local navigation does not call the position update. Preview start / moves send `leader.activity` (throttled). The UI that shows both positions is item 8.
- [ ] AC42. The client uses durations received from the server for countdowns and grace periods, not absolute server timestamps (decision 5).

### Privacy, logging and security tests
- [ ] AC43. A log-capture test over every new flow (grace, handoff, take-back, keep-alive, lock, remove, vice, names, roster, restart-after-handoff) asserts no display name, participant ID (other than existing hashed refs), token, code, position or metadata appears at any level. Names and IDs are also absent from error messages.
- [ ] AC44. Cross-app isolation: all new actions and events stay inside the app namespace and group; a participant ID or token from another group or app is treated like garbage (same response as an unknown ID).
- [ ] AC45. Security test suite (listed for the review): role matrix (AC6), stale leader after handoff (AC24), double-leader race (AC8), restart supersession (AC26), an emptied group can't be recreated in the same process (resume and `tokens.check`, also with ended-groups memory full), removal bypass on every path (AC33), lock on every join path (AC29), name injection / bidi / control characters (AC35), rate limits (AC9), block list transferred to the new leader and enforced after a later restart.
- [ ] AC46. Existing suites stay green; `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass; no new dependencies unless the architect justifies one.

## Security-sensitive areas (for architect and security review)

- **Role and permission checks.** Authority comes from the live record, not the token or session cache; every leader-only action is checked at processing time (AC6-AC8). Highest-risk area: a missed check means anyone can control the group.
- **Handoff.** Moves control without the leader's consent. Risks: stale leader tokens regaining control (AC24, AC26), a double leader (AC8), the block list lost on handoff (AC23, AC45), the new leader inheriting the codes, pending approvals and lock state, and the new leader's token carrying the original creation time (AC18).
- **Removal.** Must stick: block list, kick of all connections, code rotation, QR invalidation (AC32-AC34). A removed participant must learn nothing beyond "removed".
- **Lock.** Must apply uniformly to all join paths; the error must not reveal whether a code was valid.
- **Names and roster.** Free text from possible minors, shown to the leader: control and bidi characters, length, never logged. Participant IDs are only exposed to the leader.
- **Flooding.** Every new leader action emits events to many members, so each needs a rate limit (AC9).

## Out of scope

- All UI: keep-alive prompt, "you're now leading", take-back prompt, roster, counter / list views, preview banner, lock / remove controls -> **PRD item 8** (hooks and components -> **item 6**; reading app content -> **item 7**).
- React/Next package -> **item 6**. Reading app (content, RTL, fingerprint) -> **item 7**. Reading app sync UX (prompts, connection indicator, leader views) -> **item 8**.
- Redis storage, multi-instance, server-side block list, public docs site, changelog, release notes -> **item 9**.
- Native push notifications. The PRD says all prompts are in-app.
- Voluntary leader-to-someone handover, renaming after join, multiple leaders, chat (Q2.5, Q5.3, PRD future work).
- Parked follow-ups: **#12** (group-creation rate limits and live-group cap) is not needed by this item. Overlap noted: this item makes groups live longer (frozen, handoff), so a live-group cap would apply to them too; no change here. **#9** (client `forgetAllGroups` clock skew) is unrelated, but decision 5 and AC42 keep the new timers free of client clock dependence so this item does not widen it. #10's advisory M3 (pause abuse) is not part of lock group; lock is leader-controlled and separate.

## Gate 1 decisions (user)

All questions below are **closed**. The user accepted every recommended
default as written, with one change (Q5.5):

- **Group 1 (timers):** Q1.1 defaults and ceilings as in #1 (grace 30 s / 120 s,
  inactivity 20 min / 60 min, countdown 60 s / 120 s, max session 3 h / 8 h).
  Q1.2 a missed keep-alive gets the full grace period before any handoff.
  Q1.3 frozen mode after a missed keep-alive ends at the existing recovery
  bound. Q1.4 any counted leader activity, or an explicit ack, answers the
  keep-alive. Q1.5 a new leader gets a fresh, full inactivity period.
- **Group 2 (handoff):** Q2.1 handoff mode `auto` or `frozen` chosen at
  creation; app default `auto`. Q2.2 longest-connected = earliest admission
  among connected members (ties by participant creation order). Q2.3 a new
  leader that disconnects gets a second grace period and a further handoff.
  Q2.4 only the most recent displaced leader can take back. Q2.5 no voluntary
  handover. Q2.6 a leadership-term claim in the token (token format bump).
- **Group 3 (vice-leader):** Q3.1 the designation lives in the leader
  client's recovery state. Q3.2 the vice-leader does not see codes. Q3.3 only
  the leader and the vice-leader know who the vice-leader is. Q3.4 the vice
  must be present when designated.
- **Group 4 (lock, remove, roster):** Q4.1 codes always rotate on removal.
  Q4.2 while locked, pending approvals stay pending but cannot be approved;
  admitted members still rejoin by token. Q4.3 the lock flag is restored from
  the leader client after a restart. Q4.4 only the leader sees the roster.
  Q4.5 removal is permanent for the session.
- **Group 5 (names):** Q5.1 server-generated `Guest N` names with
  `generated: true`. Q5.2 duplicate chosen names allowed. Q5.3 no renaming.
  Q5.4 the client re-sends the name on token resume, else it is generated
  again. **Q5.5 changed:** display names use the existing strict #10 rule,
  `normalizeDisplayName` in `packages/protocol/src/join.ts` (Unicode-property
  based; ZWNJ/ZWJ between letters rejected; at most 4 combining marks in a
  row; tag characters only inside the 3 RGI subdivision flags). No new or
  looser rule. AC35 is read with this rule.
- **Group 6 (preview):** Q6.1 client-side preview plus a throttled
  `leader.activity` signal. Q6.2 the core client ships the preview helper.
- **Q7:** protocol version stays 1.

## Rescope decision (user, 2026-11-04, after 3 failed security plan rounds)

The user chose **"Simplify the scope"**: automatic leader takeover by token
happens only after a **server restart**. A group that empties completely
while the server is running **ends** (reason `empty`) and cannot be recovered
later in that server process; the leader starts a new group. This supersedes
#5 AC22 for this case. Affected wording: AC14, AC19, AC21, AC26, AC27, AC37,
AC45 and decision 6 (applied above, per `architecture.md` section 15). The
architect's Gate 2 questions Q-F and Q-G (see `architecture.md` 14.3) remain
open for Gate 2.

## Open questions for Gate 1 (closed; see Gate 1 decisions above)

**Group 1: timers and keep-alive**
- **Q1.1 Defaults and ceilings.** Recommended: as recorded in #1 (grace 30 s / 120 s, inactivity 20 min / 60 min, countdown 60 s / 120 s, max session 3 h / 8 h), per-app values with env ceilings, startup error above ceiling. Alternative: different numbers.
- **Q1.2 Missed keep-alive timing.** The PRD says the group freezes for the grace period, then hands off. Recommended: follow it literally (a missed keep-alive is treated like a disconnect, with the full grace period). Alternative: hand off immediately, since the leader is connected but unresponsive.
- **Q1.3 Frozen mode and a missed keep-alive.** Recommended: no handoff in frozen mode, so the group stays frozen until the existing recovery bound (inactivity limit plus refresh slack, at most about 5 min later) then ends, or the leader returns first. Alternative: end it at once when the countdown ends.
- **Q1.4 What answers a keep-alive.** Recommended: an explicit ack or any counted leader activity (a position update counts). Alternative: explicit ack only.
- **Q1.5 When the new leader's keep-alive runs.** The PRD says the new leader's inactivity timer starts fresh. Recommended: a full inactivity period, then the prompt. Alternative: prompt the new leader immediately after a handoff caused by a missed keep-alive, so a dead group closes in about one countdown instead of about 20 minutes.

**Group 2: handoff and leadership**
- **Q2.1 Handoff mode.** Recommended: the leader chooses at creation (`auto` or `frozen`); the app config sets the default, proposed `auto`. Alternative: app-level only, or default `frozen` (safer for control, worse for unattended groups).
- **Q2.2 "Longest-connected".** Recommended: earliest admission time among members connected at that moment (join order; ties broken by participant creation order). Alternative: the earliest start of the current connection (resets on every reconnect, so a flaky member loses seniority).
- **Q2.3 New leader disconnects after a handoff.** The PRD limits one-step escalation to a missed keep-alive. Recommended: a second grace period and a further handoff to the next eligible participant (the leader who just lost the lead is excluded), bounded by max session. Alternative: one handoff only; the group freezes and then ends.
- **Q2.4 Take-back slot.** Recommended: only the most recent displaced leader may take back. Alternative: any former leader still in the group.
- **Q2.5 Voluntary handover.** Recommended: out of scope (not in the PRD). Alternative: add a leader-initiated "make X leader".
- **Q2.6 Preventing stale-token takeover.** Recommended: add a leadership **term** claim to the token (incremented on every handoff or take-back; absent = 0), higher term wins on restart recovery; the server record is authoritative while the group is live. Requires a token format bump (acceptable since nothing is released). Alternative: no claim; whoever presents a leader token first after a restart wins (weaker: a stale leader can reclaim control).

**Group 3: vice-leader**
- **Q3.1 Where the designation lives.** Recommended: in the recovery state held by the leader's client (with block list and lock flag), not in member tokens. Alternative: a `vice` role claim in the member's token (re-issued on designation; stale after demotion).
- **Q3.2 Does the vice-leader see codes?** (deferred from #10 Q2.3) Recommended: no; codes stay leader-only, and the vice gets them when it becomes leader. Alternative: show codes to the vice-leader.
- **Q3.3 Who knows the vice-leader?** Recommended: the leader and the vice-leader only. Alternative: everyone.
- **Q3.4 May the leader designate a vice who is currently offline?** Recommended: no, must be present at designation time (but the designation survives a later drop).

**Group 4: lock, remove, roster**
- **Q4.1 Code rotation on removal.** Recommended: always rotate (deferred from #10) so removal sticks against someone who knows the codes; the leader is shown the new codes. Alternative: leader chooses.
- **Q4.2 Lock vs pending approvals and resumes.** Recommended: pending requests stay pending but cannot be approved while locked (approve returns `GROUP_LOCKED`); members already admitted always rejoin by token. Alternative: lock denies all pending requests.
- **Q4.3 Lock persistence.** Recommended: the lock flag is held by the leader's client in the recovery state and restored after a restart (the PRD stores nothing server-side). Alternative: lock resets on restart.
- **Q4.4 Who sees the roster?** Recommended: the leader only; members and vice-leader see a count at most. Alternative: members see names.
- **Q4.5 Is removal permanent for the session?** Recommended: yes, no un-remove in this item (the block list is append-only for the group's life).

**Group 5: names**
- **Q5.1 Generated name format.** Recommended: server-generated neutral `Guest 12`-style (sequential per group, locale-neutral) plus `generated: true` so apps can localize. Alternative: word-pair names ("Blue Fox"), or client-generated names.
- **Q5.2 Duplicate chosen names.** Recommended: allowed (identity is the participant ID); the roster carries the ID so apps can disambiguate. Alternative: reject or suffix duplicates.
- **Q5.3 Renaming after join.** Recommended: out of scope.
- **Q5.4 Name after a restart.** Recommended: the client re-sends the name on token resume; otherwise it is regenerated.
- **Q5.5 Bidi and control characters.** Recommended: reject control characters and bidi override / isolate characters (relevant for Hebrew and mixed-direction UIs); allow ordinary RTL letters. Alternative: strip instead of reject.

**Group 6: preview and protocol**
- **Q6.1 Preview on the server.** Recommended: client-side only plus a throttled `leader.activity` signal (AC30). Alternative: the server stores the previewed position (not recommended: breaks "server never reads the position" and privacy).
- **Q6.2 Core client preview helper.** Recommended: include (AC41). Alternative: leave the helper to item 6 and ship only `leader.activity`.
- **Q7 Protocol version.** Recommended: stay at 1 (nothing released; releases start in item 9).

# Architecture: #13 Roles, timers and group lifecycle (PRD item 5)

Issue: https://github.com/MosheRW/sync-system/issues/13
Spec: [`spec.md`](./spec.md) (46 ACs; Gate 1 accepted every recommended
default Q1.1-Q7, with Q5.5 changed to the strict #10 name rule)
Path: full | Branch: `feat/13-roles-lifecycle` | Designer: skipped (no UI;
screens are PRD items 7-8, React hooks item 6)
Builds on: #1, #3, #5, #7, #10 (`docs/issues/{1,3,5,7,10}/*`). Every hardening
control from those issues stays in place; where this plan changes an existing
rule (block list becomes append-only, a displaced leader token resumes as a
member, token format 2) it says so explicitly. "Item N" means PRD item N of 9.
Parked #9 and #12 are out of scope (section 11 notes the overlap).

## 0. Summary

- **One authority for roles: the live `GroupRecord`.** `Membership.role` is
  deleted, so code can't authorize from a cached role. Every leader-only action
  takes the group lock, re-reads the record and checks
  `record.leaderId === membership.participantId`. `position.update` moves under
  the lock too. With that, handoff, take-back, removal and end serialize with
  every leader action, so there are never two leaders (AC6-AC8).
- **One lifecycle state machine per group** (section 6): `live` -> `paused`
  (leader offline or inactive, with a grace deadline in `auto` mode) ->
  handoff, end, or back to `live`. All timers are lazy: a timer re-reads the
  record under the lock and re-arms itself if activity moved its deadline. So a
  position update never touches a timer.
- **Leadership term** (`term` claim, token format 2) is a millisecond value
  that only increases: `max(previous + 1, nowMs)`, the same rule as #10's code
  generation (D4). The higher term wins on recovery after a restart, and that
  also means "the leadership granted most recently wins".
- **Roster** with names, admission order and connected flags lives in the
  record. It is sent only to the leader, as a snapshot plus deltas. Names
  follow the strict #10 rule; blank or missing names get `Guest N`.
- **Leader recovery state** = block list, lock flag, vice-leader ID and handoff
  mode. The server sends it to every leader (create, resume, handoff,
  take-back), and the leader client keeps it with the token and sends it back
  when it recreates the group.
- Client: new leader API, lifecycle and keep-alive state, events for role
  changes, and a framework-free preview helper.

Decisions: none open (no ADR). Everything here builds on the existing stack
and adds no dependency. The technical choices the user may want to weigh are
listed as **Gate 2 questions** (section 14).

## 1. Approach

`GroupService` is ~1200 lines and `JoinService` ~930. The new behavior goes
into a new `apps/sync-server/src/lifecycle/` module, using the same host-interface
pattern #10 used for `JoinService`. `GroupService` stays the `GroupActions`
facade and owns the lock, store, notifier, timers and `endGroup`/`dropGroup`.

```
Connection ──> GroupService (facade, GroupActions, per-group KeyedLock)
                 ├─ (existing) TokenService, TokenRefresher, EndedGroups, ParkingLot, JoinService
                 ├─ GroupTimers         + kinds: grace, keepAlivePrompt, keepAliveDeadline
                 └─ lifecycle/
                      ├─ leader-guard.ts     authorizeLeader(session, action, record): the only leader check
                      ├─ roster.ts           pure: admit / reconnect / disconnect / evict entries, Guest N names
                      ├─ succession.ts       pure: pickSuccessor(record, isConnected), nextTerm(prev, now)
                      ├─ LifecycleService    activity, keep-alive, pause/grace, handoff, take-back, supersede
                      └─ LeaderControls      vice.set/clear, group.lock/unlock, member.remove, leader.activity, keepalive.ack
```

`LifecycleService` and `LeaderControls` get a narrow host (`runLocked`,
`deliverLater`, `sessionOf(record, pid)`, `issueToken`, `endGroup`,
`joins` hooks). They never import the transport.

### 1.1 Key decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Delete `Membership.role`.** A session's membership is `{groupId, participantId}` only. Who leads is `record.leaderId`, read under the group lock. `authorizeLeader()` in `leader-guard.ts` is the one function every leader-only action calls *inside* the lock. Order: parked or pending joiner -> `NOT_LEADER`; no owned membership -> `NOT_IN_GROUP`; record missing -> `NOT_IN_GROUP`; `record.leaderId !== participantId` -> `NOT_LEADER`. | AC6, AC8, spec decision 1. The type checker then finds every call site that used the cached role (`update`, `end`, `setBlockList`, `ownedLeader`, `disconnect`), so none can be missed. |
| D2 | **`position.update` runs under the group lock** (size check before the lock, rate limit last, as today). | Without the lock an update racing a handoff could be relayed after the handoff (AC8). The lock is in-process and uncontended at <= 10 updates/s per group. |
| D3 | **Leadership term** `term`: integer ms, set at create to `createdAt`, and on every handoff, take-back or supersede to `nextTerm = max(record.term + 1, nowMs)`. A recreation keeps the token's term. Token format version **2** with `term` required. v1 tokens are rejected as `TOKEN_INVALID` (an unknown format, same as #5 AC8). | Q2.6. A plain counter breaks after a restart: a stale leader recreates at term 0, hands off to C (term 1), and then the real pre-restart leader B (also term 1) loses. The clock rule makes "higher term" mean "granted more recently", so it orders correctly across restarts. Nothing is released, so the bump costs nothing (spec AC39, #5 Q13). |
| D4 | **Role on resume comes from the record, not the token** (live group): `pid === record.leaderId` -> leader return (even with a member token). A leader token with `term > record.term` -> **supersede** (section 6.6). Any other token -> **member resume**, including a displaced leader's leader token (AC24). The leader-token `lat` expiry (#5 check 3) applies only when the token would act as leader (recreate, leader return, supersede), not to a demoted leader token used to come back as a member. | AC24, AC26. A displaced leader holds only its old leader token; it must still be able to rejoin as a member after the 25 min `lat` window. |
| D5 | **Block list is append-only while the group is live** (Q4.5). `blocklist.set` and a leader return with `blockList` **merge** (union, cap 256) and never remove entries. A recreation takes the client's list as given (the server has none). A **supersede** replaces the stale list with the superseding leader's list (section 6.6). | Q4.5 "removal is permanent for the session". The #5 test "unblocks when the list no longer holds the ID" changes on purpose. |
| D6 | **Removal reuses the #5 path**: the target's session loses its membership and gets `group.ended {reason: 'removed'}`. The WebSocket stays open, as for a #5 block. Then block-list append, roster removal, vice cleared, take-back slot cleared, and a full code rotation (`codes.updated` reason `member_removed`). | AC32-AC33. "Connections closed" in AC32 is read as "group membership closed". Closing the socket would only start a reconnect loop that rejoin rules reject anyway. Gate 2 Q-A. |
| D7 | **Lazy timers.** One timer per kind per group (`GroupTimers`). The callback takes the lock, re-reads the record, and if the deadline moved (activity), re-arms instead of acting. `recordActivity()` only cancels a timer when it must send something (`keepalive.cleared`, unpause). | Position updates at 10/s must not cancel and re-arm timers. Same pattern as the max-session and frozen-end timers (#5 R3). |
| D8 | **Pause state** `record.pause = {cause: 'offline' \| 'inactive', graceEndsAt?: number}`. `leaderOnline` keeps its meaning (the connection). Members see a pause as `leader.offline {cause, graceMs?}` and the end of a pause as `leader.online`. `graceMs` is present only when a handoff can follow (`auto` mode). | AC14, AC17, AC28. Reuses the #5 messages, with two optional fields added. |
| D9 | **Escalation flag** `record.escalated`: true when the current leader got the lead through a *missed keep-alive* handoff. It is cleared by that leader's first counted activity. While it is true, a missed keep-alive ends the group with reason `inactivity` when the countdown ends (AC22). | PRD: "escalation goes one step only". Clearing on activity means a new leader who answered once is treated like any other leader later. Gate 2 Q-B. |
| D10 | **Roster in the record**: `roster: RosterEntry[]` in admission order, `{pid, name, generated, admittedSeq, admittedAt, connected}`. Entries survive a disconnect (`connected: false`), so admission order (Q2.2), the vice and names survive reconnects. Leave, removal and group end delete entries. At most `maxGroupSize` disconnected entries are kept; past that, the oldest-disconnected entry is evicted (`roster.removed`). | AC31, Q2.2, AC12. Bounds memory under join churn. An evicted member who returns gets a new admission time and a regenerated name (it is still admitted by token). |
| D11 | **Names**: one `resolveDisplayName(raw?)` in `@sync-system/protocol`. Missing, or blank after `trim()` -> generate. Otherwise `normalizeDisplayName` (the strict #10 rule, unchanged) or `INVALID_MESSAGE`. Generated: `Guest N`, N per group from 1, skipping any N whose text equals a chosen name in the roster; `generated: true` plus `guestNumber` so apps can localize. | AC35-AC37 with the Q5.5 change. This also changes #10's behavior for a blank join name from `INVALID_MESSAGE` to a generated name (AC36). |
| D12 | **Relative times only**: `graceMs`, `countdownMs`, `joinedAgoMs`. The client derives local deadlines. | Spec decision 5, AC42, same reason as #10 D6 (#9 clock skew). |
| D13 | **Recovery state** `LeaderState = {blockList, locked, viceId?, handoff}` goes to the leader in `group.created` (trivial), `group.resumed` and `leader.granted`, and the client stores it in `Recovery`. On recreation the client sends `blockList`, `locked`, `viceId`, `handoff` in `group.resume`. On a live leader return those fields are ignored (server wins), except the block-list union (D5). | Spec decision 3, AC13, AC23, Q4.3. |
| D14 | **Lock check placement**: after the code or ticket resolves to a group, before any door-code comparison, approval queueing or admission. `GROUP_LOCKED` is the same text for every method. The join-attempt budget is already spent by then, as for every attempt. | AC29. Checking before the door compare means the lock never helps a door-code guesser. A valid code on a locked group answers `GROUP_LOCKED`, not `CODE_NOT_FOUND`: the code is live, but nobody can join through it (Gate 2 Q-D). |

### 1.2 Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Keep `Membership.role` and update it on handoff | One missed update means a stale leader with powers. Deleting the field lets the compiler enforce AC6. |
| Integer term counter | Wrong order across restarts (D3). |
| Vice in the member's token (Q3.1 alternative) | Rejected at Gate 1. It would also need a re-issue on every designation and go stale on demotion. |
| Server-side preview position (Q6.1 alternative) | Rejected at Gate 1. It would break "the server never reads the position". |
| One timer reset per activity | Timer churn at 10 updates/s per group (D7). |
| Full roster snapshot on every change | Up to ~50 KB per change at the ceiling. Deltas are ~250 bytes. |
| New `group.frozen` message type | `leader.offline` / `leader.online` already mean "frozen / live". Adding `cause` and `graceMs` keeps clients simple (D8). |
| Close the removed member's socket | See D6. |

## 2. Repo layout

Layout: **monorepo** (pnpm workspaces; no submodules, `git submodule status` is
empty). One issue, one branch, one PR.

| Package | Path | Touched | Checks |
| --- | --- | --- | --- |
| protocol | `packages/protocol` | messages, schemas, errors, tokens (format 2), names helper, limits | `pnpm --filter @sync-system/protocol test typecheck build` |
| sync-server | `apps/sync-server` | lifecycle module, group service, join service, store, config, timers, tokens | `pnpm --filter @sync-system/sync-server test typecheck build` |
| client | `packages/client` | leader API, lifecycle state, recovery storage, preview helper | `pnpm --filter @sync-system/client test typecheck build` |
| root | `/` | README, compose env, apps example | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit --audit-level=high` |

No other repo is affected.

## 3. Files

### 3.1 Create

| Path | What |
| --- | --- |
| `apps/sync-server/src/lifecycle/leader-guard.ts` | `authorizeLeader(session, action, record)` (D1). `isParticipantConnected` helper (notifier session present and `isOpen()`). |
| `apps/sync-server/src/lifecycle/roster.ts` | Pure functions on `RosterEntry[]`: `admit`, `reconnect`, `disconnect`, `remove`, `evictOverflow`, `generateGuestName`, `toWire(entry, record, now)`. |
| `apps/sync-server/src/lifecycle/succession.ts` | Pure: `pickSuccessor(record, isConnected)` (the connected vice, else the lowest `admittedSeq` among connected attached members; never the current leader, a pending joiner or a parked participant); `nextTerm(prev, now)`. |
| `apps/sync-server/src/lifecycle/lifecycle-service.ts` | `recordActivity`, keep-alive prompt and deadline, `pause` / `unpause`, grace end, `handoff`, `takeBack`, `supersede`, `leaderStateOf(record)`. Every entry point runs under the group lock. |
| `apps/sync-server/src/lifecycle/leader-controls.ts` | Handlers for `vice.set`, `vice.clear`, `group.lock`, `group.unlock`, `member.remove`, `leader.activity`, `keepalive.ack`, `leader.takeBack` (calls LifecycleService). Per-group rate limiters. |
| `apps/sync-server/test/roster.test.ts`, `succession.test.ts`, `leader-guard.test.ts` | Unit tests (section 12). |
| `apps/sync-server/test/helpers/lifecycle.ts` | Helpers: `advanceToPrompt`, `advanceThroughGrace`, `expectLeader(ts, group, pid)`, an app config with short timers for readability (values within ceilings). |
| `apps/sync-server/test/*.int.test.ts` (new) | `roles-matrix`, `leader-race`, `leader-rate-limits`, `vice`, `grace`, `keepalive`, `handoff`, `escalation`, `take-back`, `restart-handoff`, `lifecycle-states`, `lock`, `leader-activity`, `roster`, `remove-member`, `names`, `roles-privacy`, `roles-isolation`, `timers-cleanup` (section 12). |
| `packages/client/src/preview.ts` | `LeaderPreview` helper (AC41). |
| `packages/client/src/leader-state.ts` | Client-side roster, vice, lock, keep-alive and take-back state, applied from server events (keeps `client.ts` from growing further). |
| `packages/client/test/preview.test.ts`, `client.roles.test.ts`, `client.lifecycle.test.ts`, `integration/roles.int.test.ts`, `integration/handoff.int.test.ts` | Client tests. |
| `packages/protocol/test/roles.test.ts` | Schemas of every new message, max lengths, `resolveDisplayName`. |

### 3.2 Modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/tokens.ts` | `TOKEN_FORMAT_VERSION = 2`; claim `term` (int, 0..MAX_SAFE_INTEGER, `term >= gct`); `TokenRole = 'leader' \| 'member'` for `role`. |
| `packages/protocol/src/messages.ts` | `Role` adds `'vice-leader'`; `TokenRole`; new client and server messages (section 5); `GroupEndedReason` adds `'inactivity'`; `CodesUpdatedReason` adds `'member_removed'`; `AppLimits` adds 3 timers; `HelloOkMessage.defaultHandoff`. |
| `packages/protocol/src/schemas.ts` | Schemas for all of the above (strict lengths, ID patterns). |
| `packages/protocol/src/errors.ts` | `GROUP_LOCKED`, `NOT_ALLOWED`, `PARTICIPANT_NOT_FOUND`, `BLOCK_LIST_FULL`. |
| `packages/protocol/src/join.ts` | `resolveDisplayName(raw?)`; `GUEST_NAME_PREFIX` not exported (server only). `normalizeDisplayName` unchanged. |
| `packages/protocol/src/limits.ts`, `index.ts` | `HANDOFF_MODES`, `MAX_ROSTER_ENTRIES_FACTOR` (2), exports. |
| `apps/sync-server/src/groups/session.ts` | `Membership` loses `role` (D1). `GroupActions` gains the 8 new actions. |
| `apps/sync-server/src/groups/group-store.ts`, `in-memory-group-store.ts` | New `GroupRecord` fields (section 4); `addParticipant` takes the roster entry to admit or reconnect; `removeParticipant` takes `mode: 'disconnect' \| 'leave'`; new atomic `patch(ns, id, patch: GroupPatch)` for leadership, pause, lock, vice and activity fields; `setBlockList` keeps the removed-IDs return. `copy()` deep-copies `roster` and `pause`. |
| `apps/sync-server/src/groups/group-service.ts` | Uses `authorizeLeader`; `update` under the lock; `create`/`resume` take names, handoff and recovery state; `leaderOffline` pauses with grace; `disconnect` branches on `record.leaderId`; `classify` and resume follow D4; `applyBlockList` becomes a union (D5); roster deltas on join, leave and disconnect; delegates new actions to `LeaderControls`. |
| `apps/sync-server/src/groups/group-timers.ts` | Kinds `grace`, `keepAlivePrompt`, `keepAliveDeadline`; `clear(key, kind)`. `clear(key)` and `clearAll()` still cancel everything. |
| `apps/sync-server/src/groups/resume.ts` | `classifyToken` follows D4: blocked for any role (a superseding token excepted, 6.6); `lat` check only when acting as leader; a leader token not matching the live leader is `live` (member). |
| `apps/sync-server/src/joins/join-service.ts` | Host `ownedLeader` replaced by `authorizeLeader` inside the lock; `GROUP_LOCKED` checks (D14) in `joinByCode`, `joinByQr`, `decide('approve')`; `admit` gets the resolved name; internal `rotateForRemoval(record)` (no `codes.rotate` budget, `member_removed` reason); `onLeaderReturn` also used after handoff, take-back and supersede. |
| `apps/sync-server/src/tokens/token-service.ts` | `IssueInput.term`; `term` in the payload; plausibility `term >= gct` and `term <= latest`. |
| `apps/sync-server/src/config/env.ts`, `apps-config.ts`, `apps/app-registry.ts` | `DISCONNECT_GRACE_SECONDS_CEILING` (default 120, bounds 1-3600), `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING` (120, 1-3600); app fields `disconnectGraceSeconds` (30), `keepAliveCountdownSeconds` (60), `defaultHandoff` (`auto`); AC2 cross-check. |
| `apps/sync-server/src/limits/constants.ts` | Rate limits (section 8.2). |
| `apps/sync-server/src/ws/connection.ts` | Dispatch of the 8 new types; `hello.ok` limits and `defaultHandoff`; `canCarryReqId` for new replies. |
| `apps/sync-server/src/ws/error-messages.ts` | Texts for the new codes; `NOT_LEADER` / `RATE_LIMITED` / `NOT_ALLOWED` texts per new action. |
| `apps/sync-server/src/logging/logger.ts` | Sensitive keys: `viceid`, `roster`, `participants`, `guestnumber` (names and IDs are already covered by the `displayname` and `participantid` fragments). |
| `apps/sync-server/test/helpers/*.ts` | `test-server` app with new config; `groups.ts` reads `roster.snapshot`; `tokens.ts` mints v2. |
| Existing server tests | Tests that run past 19 min with an idle leader now see keep-alive and handoff. They are fixed with explicit `keepalive.ack` / activity, never by weakening a timer. Expected: `max-session`, `frozen`, `lifecycle`, `refresh`, `restart*`, `parking`, `blocklist` (D5), `tokens*` (v2), `join-*` (blank name, lock). |
| `packages/client/src/client.ts` | New methods and events (section 9); routing of new server messages to `leader-state.ts`; token replacement on `leader.granted` / `leader.lost` / supersede. |
| `packages/client/src/state.ts` | `GroupState.active` gains `role: Role` (incl. `vice-leader`), `leader` lifecycle, `locked`, `displayName`, `generated`, `takeBackAvailable`; `SyncIndicator` gains `leader_grace`; `indicatorOf` updated; snapshot `preview`. |
| `packages/client/src/token-store.ts` | `Recovery` adds `locked`, `viceId`, `handoff`; `StoredEntry.displayName` (the user's own name, local only, deleted with the entry); member token replaces a leader entry and drops its recovery (already the case; tested). |
| `packages/client/src/errors.ts`, `options.ts`, `requests.ts`, `index.ts` | New error codes, request kinds, reply types, exports. |
| `README.md`, `packages/client/README.md`, `config/apps.example.json`, `compose.yaml` | Docs chunk (section 10). |
| `docs/issues/13/spec.md` | Wording corrections listed in 14.2 (docs chunk). |

## 4. Data model (server memory only; no database)

`GroupRecord` additions:

```ts
term: number;                         // D3
handoff: 'auto' | 'frozen';           // Q2.1, from create or recovery
locked: boolean;                      // AC29
viceId: string | undefined;           // AC10, a roster pid
displacedLeaderId: string | undefined;// take-back slot (Q2.4)
escalated: boolean;                   // D9
pause: { cause: 'offline' | 'inactive'; graceEndsAt?: number } | undefined; // D8
keepAlivePending: boolean;            // a prompt is outstanding
roster: RosterEntry[];                // D10, admission order
nextAdmissionSeq: number;
nextGuestNumber: number;

interface RosterEntry {
  pid: string; name: string; generated: boolean; guestNumber?: number;
  admittedSeq: number; admittedAt: number; connected: boolean;
}
```

Invariants (asserted in unit tests):
- The leader always has a roster entry. `participantIds` is still "attached
  members plus the leader slot" and is used for capacity and broadcast. Every
  `participantIds` entry has a roster entry, `connected` matches attachment,
  and the leader's entry is `connected === leaderOnline`.
- `viceId` is undefined or a roster pid that is not the leader and not
  blocked. `displacedLeaderId` is never the leader.
- `pause` is set iff the leader is offline or the group is in an inactive
  pause. `pause.cause === 'offline'` iff `!leaderOnline`.
- `term` only increases, and `term >= createdAt`.
- After a handoff where the old leader was offline, the old leader's pid
  leaves `participantIds` (it is no longer the reserved leader slot) and its
  roster entry stays `connected: false`.

Memory per group: roster <= 2 x `maxGroupSize` entries of ~200 bytes (<= 40 KB
at the ceiling of 100). No persistence and no migration. Data-model
checklist: n/a (no database).

## 5. Wire protocol (still version 1; token format 2)

All IDs on the wire are group-scoped participant IDs. They go **only** to the
leader (roster, `member.removed`, `vice.updated`). Members never receive
another participant's ID or name (AC31, Q3.3, Q4.4).

### 5.1 Client -> server (new or changed)

| Message | Fields | Who | Reply |
| --- | --- | --- | --- |
| `group.create` (changed) | `+ handoff?: 'auto'\|'frozen'`, `+ displayName?: string (<=128 raw)` | anyone | `group.created` |
| `group.joinByCode` / `group.joinByQr` (changed) | `displayName` now used for every method (roster); blank -> generated | anyone | as #10 |
| `group.resume` (changed) | `+ displayName?`, leader recovery `+ locked?: boolean`, `+ viceId?: pid`, `+ handoff?` | token holder | `group.resumed` / `group.joined` / `group.waiting` |
| `vice.set` | `participantId: pid` | leader | `vice.updated` |
| `vice.clear` | - | leader | `vice.updated` |
| `group.lock` / `group.unlock` | - | leader | `lock.changed` |
| `member.remove` | `participantId: pid` | leader | `member.removed` |
| `leader.activity` | - (no payload, AC30) | leader | `activity.ack` |
| `keepalive.ack` | - | leader | `activity.ack` |
| `leader.takeBack` | - | most recent displaced leader | `leader.granted` (reason `take_back`) |

### 5.2 Server -> client (new or changed)

| Message | Fields | To |
| --- | --- | --- |
| `hello.ok` (changed) | `limits + {inactivityLimitMinutes, disconnectGraceSeconds, keepAliveCountdownSeconds}`, `+ defaultHandoff` | connection |
| `group.created` (changed) | `+ handoff`, `+ displayName`, `+ generated`, `+ state: LeaderState` | creator |
| `group.joined` (changed) | `+ displayName`, `+ generated`, `+ locked`, `+ leaderPause?: {cause, graceMs?}` (`leaderOnline` is false while paused) | member |
| `group.resumed` (changed) | `+ displayName`, `+ generated`, `+ state: LeaderState`, `+ superseded: boolean` | leader |
| `roster.snapshot` | `{groupId, participants: RosterEntryWire[]}` after created, resumed or granted | leader |
| `roster.updated` | `{groupId, participant: RosterEntryWire}` (join, reconnect, disconnect, role change) | leader |
| `roster.removed` | `{groupId, participantId}` (leave, removal, eviction) | leader |
| `vice.updated` | `{groupId, viceId: pid \| null}` (reply) | leader |
| `vice.changed` | `{groupId, isVice: boolean}` (designated, replaced, cleared; re-sent on the vice's re-admission) | the vice (old and new) |
| `lock.changed` | `{groupId, locked}`: the reply to the leader; broadcast to members | leader, members |
| `member.removed` | `{groupId, participantId, blockList: pid[]}` (reply), then `codes.updated {reason: 'member_removed'}` | leader |
| `activity.ack` | `{}` (reply) | leader |
| `keepalive.prompt` | `{groupId, countdownMs}` | leader |
| `keepalive.cleared` | `{groupId}` (any counted activity answered it) | leader |
| `leader.offline` (changed) | `+ cause: 'disconnected' \| 'inactive'`, `+ graceMs?` | members |
| `leader.online` | unchanged (pause ended) | members |
| `leader.granted` | `{groupId, reason: 'handoff_disconnect' \| 'handoff_inactivity' \| 'take_back', token, state: LeaderState, joinMethods, codes}`; then `roster.snapshot`, pending `join.requested`, `join.paused` | new leader |
| `leader.lost` | `{groupId, reason: 'handoff_inactivity' \| 'take_back' \| 'superseded', token (member), takeBackAvailable: boolean}` | displaced leader, if attached |
| `leader.changed` | `{groupId, reason}` (no IDs) | other members |
| `takeback.offered` | `{groupId}` (after a displaced leader rejoins as a member) | displaced leader |
| `group.ended` (changed) | reason `+ 'inactivity'` | all |

`LeaderState = {blockList: pid[] (<=256), locked: boolean, viceId?: pid, handoff}`.
`RosterEntryWire = {participantId, displayName (<=128), generated, guestNumber?, role: Role, connected, joinedAgoMs}`.

Existing ended reasons are kept: `ended_by_leader` (the spec's `leader_ended`)
and `leader_timeout` (the frozen bound, including frozen mode after a missed
keep-alive, Q1.3). Spec wording corrections are listed in 14.2.

### 5.3 Errors (new)

| Code | When | Text |
| --- | --- | --- |
| `GROUP_LOCKED` | join by any method, or `join.approve`, while locked | `Group is locked` (one text for all) |
| `NOT_ALLOWED` | `leader.takeBack` by anyone but the displaced leader; removing or designating the leader (or oneself); designating an offline member | action text (ActionErrorCode) |
| `PARTICIPANT_NOT_FOUND` | `vice.set` / `member.remove` with an ID that is not in this group's roster (unknown, other group or app, pending joiner, parked, already removed) | `Participant not found` (identical for every cause, AC10, AC44) |
| `BLOCK_LIST_FULL` | `member.remove` with 256 entries already | `Block list is full` + `details.maxBlockList` |

`NOT_LEADER` and `RATE_LIMITED` get per-action texts for the new actions.

### 5.4 Token format 2

```
{ v: 2, aud, gid, pid, role: 'leader'|'member', gct, lat, term, iat, exp }
```
Every token carries the group's current `term`. It only matters for leader
tokens (D3, D4). There is still no name, vice, lock or code in the token
(AC37, AC40).

### 5.5 Frame sizes

`group.resume` adds < 200 bytes (inside `RECOVERY_EXTRA_BYTES` slack, but the
comment and the size test are updated). The largest new outbound frame is
`roster.snapshot` (<= 200 entries x ~250 bytes, about 50 KB). That is below the
default `MAX_BUFFERED_BYTES` 256 KB, but **above** the configurable minimum
(`4 x MAX_MESSAGE_SIZE_CEILING`, 64 KB at the default ceiling), with
`leader.granted` and codes right behind it. `env.ts` gains a startup check
`MAX_BUFFERED_BYTES >= ROSTER_SNAPSHOT_MAX_BYTES (computed from
MAX_GROUP_SIZE_CEILING) + 32 KB`. Tested.

## 6. Lifecycle (server)

### 6.1 States per group

```
           create/recreate                         leader returns / any counted activity
                 │                                ┌────────────────────────────────────┐
                 v                                │                                    │
  ┌──────────── live ───── leader disconnects ──> paused{offline, grace?} ─┐          │
  │   (keep-alive prompt at lastActivity + limit - countdown)              │          │
  │                │ countdown ends unanswered                             │ grace ends (auto)
  │                ├─ escalated? ── yes ──> END inactivity (AC22)          v          │
  │                └─ no ──> paused{inactive, grace?} ── grace ends ──> handoff ──> live (new leader)
  │                                                    (frozen mode or no candidate: stay paused
  │                                                     until lastActivity + limit + slack -> END leader_timeout)
  └── max session (any state) -> END max_session;  leader group.end -> END ended_by_leader
```

### 6.2 Activity (`recordActivity`, under the lock)

Counted (AC15): an accepted `position.update`, `leader.activity`,
`keepalive.ack`, and every **accepted** leader-only action (`vice.*`,
`group.lock/unlock`, `member.remove`, `codes.rotate`, `qr.issue`,
`join.approve/deny`, `blocklist.set`). A leader return or a take-back also
resets `lastActivityAt` (as today). Not counted: anything rejected,
rate-limited or sent by a non-leader; heartbeats; just being connected.

Effects: `lastActivityAt = at`; `refresher.activity` (#5 refresh keeps working
from the same signal); if `keepAlivePending`, clear it, cancel the deadline,
arm the prompt and deliver `keepalive.cleared` after the reply; if
`pause.cause === 'inactive'`, unpause (broadcast `leader.online`, cancel the
grace and frozen-end timers); `escalated = false`.

### 6.3 Keep-alive (AC16, AC17, AC22)

The `keepAlivePrompt` timer is armed at `lastActivityAt + limit - countdown`
whenever the leader is online and not paused (create, return, unpause,
handoff, take-back). On fire it re-reads the record: if the deadline moved, it
re-arms. Otherwise `keepAlivePending = true`, the leader gets
`keepalive.prompt {countdownMs: deadline - now}`, and `keepAliveDeadline` is
armed at `lastActivityAt + limit`. On deadline it re-checks the same way, then:
`escalated` -> `endGroup('inactivity')`; else pause `inactive` (6.4). Members
never get the prompt.

### 6.4 Pause and grace (AC14, AC17, AC21)

`pause(record, cause)`: `pause = {cause, graceEndsAt}`. `graceEndsAt = now +
grace` in `auto` mode, and is not set in `frozen` mode. A pause that is already
running keeps its earlier `graceEndsAt` when its cause changes from inactive
to offline (no extension). Members get `leader.offline {cause, graceMs?}`. Arm
`grace` (auto) and the existing `frozenEnd` bound
(`lastActivityAt + limit + refresh.maxMs`; its stale check becomes
`!current.pause`). A leader that disconnects with no other connected
participant is still dropped, as today (#5 AC22).

Grace end (auto, under the lock, stale if `term` or `pause` changed):
`pickSuccessor`. With none, it acts like frozen mode: stay paused until the
frozen bound.

### 6.5 Handoff (AC20, AC23, AC12)

Under the lock: `term = nextTerm`, `leaderId = successor`,
`displacedLeaderId = old`, `escalated = (cause === 'inactive')`,
`lastActivityAt = now`, `leaderOnline = true`, `pause = undefined`,
`keepAlivePending = false`. `viceId` is cleared if the successor was the vice.
The old leader leaves `participantIds` if it was offline. Timers: clear grace,
frozen-end and keep-alive, then arm the prompt for the new leader. Refresher
reset for the new leader. Messages: successor `leader.granted` (leader token,
term, original `gct`, AC18) then `roster.snapshot` and
`joins.onLeaderReturn(successor)`; an attached old leader gets `leader.lost`
(member token, `takeBackAvailable: true`); everyone else gets
`leader.changed`. A further disconnect-caused handoff is allowed (Q2.3). Each
needs its own grace period, the displaced leader is never a candidate, and the
take-back slot always holds the most recent displaced leader. Log
`leader_handoff {namespace, groupRef, handoffReason}`.

### 6.6 Take-back and supersede (AC24-AC26)

- **Take-back.** `leader.takeBack` from the session owning
  `displacedLeaderId` (anyone else gets `NOT_ALLOWED`, no state change).
  Rate limit, then a swap with the same steps as 6.5, reason `take_back`; the
  new `displacedLeaderId` is the leader it replaced. Reply `leader.granted` (with
  reqId).
- **Displaced leader returns** with its old leader token (lower term): member
  resume (D4), then `takeback.offered` if its pid is `displacedLeaderId`. The
  leader recovery fields it sends are ignored.
- **Supersede** (only possible after a restart): `group.resume` with a leader
  token whose `term > record.term`. The token must verify and pass the `lat`
  and max-session checks. The **stale block list is not applied to this
  token** (a malicious displaced leader could otherwise recreate first with a
  list that blocks the real leader). Effects: `term = claims.term`;
  the requester becomes leader; the stale leader gets `leader.lost {reason:
  'superseded', takeBackAvailable: false}` if attached; `displacedLeaderId =
  undefined`; the requester's recovery replaces block list (kicking listed
  members), lock, vice (validated) and handoff mode. Codes: if the requester's
  blob is valid for this group, has a different generation and its codes are
  free, those codes are adopted; otherwise the current codes stay. Members
  get `leader.changed {reason: 'superseded'}`. Reply `group.resumed {superseded:
  true}`. Arrival order "new first" is plain: the stale token's term is lower,
  so it resumes as a member (AC26, both orders tested).

### 6.7 Vice, lock, removal (summaries)

- `vice.set`: the target must be in the roster, `connected`, not the leader
  and not blocked -> set; the old vice gets `vice.changed {isVice: false}`, the
  new one `{isVice: true}`; the leader gets the reply plus `roster.updated` for
  both. On recreation, `viceId` from recovery is kept only if it is a valid pid
  format and not blocked. It takes effect when that pid is admitted (the vice
  then gets `vice.changed`). Handoff only uses it if connected (AC12, AC13).
- Lock: `locked` toggles idempotently (a no-op toggle is still a reply but is
  not broadcast again). Token resumes and parked admission ignore the lock.
  Pending approvals stay; `join.approve` -> `GROUP_LOCKED`; new B requests are
  refused with `GROUP_LOCKED` (D14). The door pause and the lock are
  independent.
- `member.remove`: validate, then check `BLOCK_LIST_FULL`, then rate limit,
  then apply D6. The reply carries the new full block list for the client to
  persist (AC32).

## 7. Authorization matrix (AC6, AC7)

Every leader-only action (`position.update`, `group.end`, `blocklist.set`,
`codes.rotate`, `qr.issue`, `join.approve`, `join.deny`, `vice.set`,
`vice.clear`, `group.lock`, `group.unlock`, `member.remove`,
`leader.activity`, `keepalive.ack`) x every non-leader (member, vice-leader,
former leader with its socket still open, parked participant, pending joiner,
groupless connection) -> `NOT_LEADER` (`NOT_IN_GROUP` for groupless), and no
state change, no event, no budget spent, no activity counted. `leader.takeBack`
-> `NOT_ALLOWED` for everyone except the displaced leader. The vice gets no
codes (codes are only in leader replies).

## 8. Configuration

### 8.1 Env and apps config

| Name | Kind | Default | Rule |
| --- | --- | --- | --- |
| `DISCONNECT_GRACE_SECONDS_CEILING` | env | 120 | integer 1-3600 |
| `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING` | env | 120 | integer 1-3600 |
| `disconnectGraceSeconds` | app | `min(30, ceiling)` | integer >= 1, <= ceiling; above -> startup error (not clamped) |
| `keepAliveCountdownSeconds` | app | `min(60, ceiling)` | integer >= 1, <= ceiling, and `< inactivityLimitMinutes * 60` (AC2) |
| `defaultHandoff` | app | `auto` | `auto` \| `frozen` |

Unchanged: `inactivityLimitMinutes` 20/60, `maxSessionMinutes` 180/480.

### 8.2 Fixed limits (`limits/constants.ts`, not configurable)

| Constant | Value | Key |
| --- | --- | --- |
| `MEMBER_REMOVALS_PER_GROUP_PER_MINUTE` | 10 | group |
| `LOCK_CHANGES_PER_GROUP_PER_MINUTE` | 10 | group |
| `VICE_CHANGES_PER_GROUP_PER_MINUTE` | 10 | group |
| `TAKE_BACKS_PER_GROUP_PER_MINUTE` | 3 | group |
| `LEADER_ACTIVITY_PER_GROUP_PER_MINUTE` | 12 | group (`leader.activity` and `keepalive.ack` share it) |
| `LEADER_CONTROL_WINDOW_MS` | 60 000 | - |
| client `LEADER_ACTIVITY_MIN_INTERVAL_MS` | 10 000 | client throttle (well under 12/min) |

Limiters are forgotten in `forgetGroup` and cleared in `close()`.

## 9. Client (`@sync-system/client`)

### 9.1 API (AC40, AC41)

- `createGroup(metadata, initialPosition?, options?)`: `options` adds
  `handoff?` and `displayName?`. `joinByCode` / `joinByQr` already take
  `displayName`. Resume re-sends the stored own name (Q5.4).
- Leader: `setViceLeader(pid)`, `clearViceLeader()`, `lockGroup()`,
  `unlockGroup()`, `removeMember(pid)` (resolves with the new block list),
  `answerKeepAlive()`, `getRoster()`, `getLeaderState()`.
- Member: `takeBackLeadership()` (only while `takeBackAvailable`).
- `removeFromBlockList` is **removed** (D5, Q4.5; breaking, nothing released).
  `addToBlockList` remains (server-side union).
- Preview: `client.preview` (`LeaderPreview`): `start()`, `move(position)`,
  `end()`, `bringGroupHere()` (one normal position update via
  `updatePosition`, then `end()`), `returnToGroup()`; `getState()` returns
  `{active, groupPosition, previewPosition}`. `start` and `move` send a
  throttled `leader.activity` (at most one per 10 s; dropped while not the
  leader). While active, the helper never calls `updatePosition`. The
  snapshot gets `preview` for item 6. Preview positions never leave the
  client.

### 9.2 Events and state (AC28, AC40, AC42)

New events: `rosterChanged`, `viceChanged {groupId, isVice}`, `lockChanged`,
`keepAlive {groupId, countdownMs, deadlineAt}` (local deadline from the
duration), `keepAliveCleared`, `nowLeading {groupId, reason}`,
`leadershipLost {groupId, reason, takeBackAvailable}`, `leaderChanged`,
`takeBackOffered`. `leaderStatus` gains `cause` and `graceEndsAt?`. Removal
stays `groupEnded {reason: 'removed'}` (the token is deleted, as today).
`GroupState.active` gains `role` (`leader` \| `vice-leader` \| `member`),
`leader: {status: 'online'} | {status: 'offline' | 'inactive', graceEndsAt?}`,
`locked`, `displayName`, `generated`, `takeBackAvailable`. `indicatorOf`: a
member with a paused leader and `graceEndsAt` -> `leader_grace`; paused
without grace -> `leader_offline`.

### 9.3 Tokens and recovery

`leader.granted` -> save the leader token with `Recovery` built from the
active group (metadata, position) plus `state` and the codes blob.
`leader.lost` and a demoting `group.joined` -> save the member token (the
leader recovery is dropped). `member.removed`, `lock.changed`,
`vice.updated` -> patch the stored recovery. Recreation sends `blockList`,
`locked`, `viceId`, `handoff`, `joinCodes`. The token store keeps
`STORAGE_DOC_VERSION = 1` (fields are additive). Stored v1 tokens no longer
decode and are dropped (Upgrading note).

## 10. Docker and docs impact

Docker impact: no Dockerfile change. `compose.yaml` lists the two new
ceilings next to the others (values = defaults). `docker compose config`
must pass.

Docs impact: the files below, in the docs chunk (last):
- `README.md`: one timers table (AC4: grace, inactivity, keep-alive
  countdown, max session; defaults, ceilings, env names, handoff mode);
  apps-config rows; env rows; "Roles and group lifecycle" section (roles,
  handoff, take-back, escalation, lock, removal, roster privacy); the name
  rule for app developers (AC38: plain text, escape when rendering; the
  strict #10 rule, blank -> `Guest N`); protocol brief (new messages, errors,
  token format 2); Upgrading (v1 tokens invalid; `blocklist.set` is now
  append-only).
- `packages/client/README.md`: leader API, member take-back, events, states,
  indicator `leader_grace`, preview helper, recovery state, the removed
  `removeFromBlockList`.
- `config/apps.example.json`: the 3 new fields on the first app.
- `docs/issues/13/spec.md`: the corrections in 14.2.

## 11. Risks and edge cases

- **Restart window with a stale leader (residual).** After a restart, a
  displaced leader whose token is still inside its `lat` window (about 25
  min) can recreate the group first. It leads, with its own stale block list
  and codes, until the real leader returns and supersedes it (6.6). A removed
  person could join under a new identity through the stale codes during that
  window and stays a member after the supersede. The new leader sees them in
  the roster and can remove them. Without server persistence this can't be
  closed (PRD: nothing stored). Documented for the security review.
- **Supersede blocked by a forged list:** closed (6.6; the superseding token
  skips the stale block list). Tested.
- **Keep-alive breaks long-running existing tests** (section 3.2). They are
  fixed with explicit activity, not by weakening timers.
- **Lock as a code oracle (D14):** a valid code on a locked group answers
  `GROUP_LOCKED`. Join budgets still apply. Gate 2 Q-D.
- **Clock steps back** (term and code generation): the same NTP assumption as
  #10 D4. `max(prev + 1, now)` keeps terms increasing within a process.
- **Approval queue across handoff:** requests stay keyed by group, so the new
  leader gets them re-sent. Decisions by the old leader get `NOT_LEADER`.
- **Vice offline at handoff:** skipped; the longest-connected member takes
  over. The designation stays (AC12) unless the vice becomes leader, leaves
  or is removed.
- **Solo leader goes inactive:** no candidate, so it stays paused until the
  frozen bound and ends with `leader_timeout`.
- **Displaced leader evicted from the roster** (join churn): it still
  resumes as a member by token; take-back depends on `displacedLeaderId`, not
  on the roster entry.
- **#12 overlap:** paused and handoff groups live longer, so a future
  live-group cap applies to them as well. No change here.
- **Test churn:** expected in about 15 server and 10 client test files (v2
  tokens, no `Membership.role`, keep-alive in long tests, block-list union,
  blank names).

## 12. Test plan (every AC)

All timer tests use `ManualScheduler` (no real sleeps). Integration tests use
the real server on a random port with raw WebSocket clients.

| AC | Test |
| --- | --- |
| AC1, AC2 | `apps-config.test.ts`, `env.test.ts`: defaults, min(default, ceiling), above ceiling = error naming the field, non-integer or <=0, countdown >= inactivity, ceiling bounds; `hello.ok` limits. |
| AC3 | `handoff.int`: create with `auto` / `frozen` / omitted (app default) / unknown -> `INVALID_MESSAGE`. |
| AC4 | `repo-hygiene`-style README check that the timers table names all 4 timers and both new env vars (docs chunk). |
| AC5, AC31 | `roster.int`: the leader's snapshot and deltas carry ID, name, role, connected, joinedAgoMs; members and the vice receive no roster frames and no IDs; pending, parked and removed participants absent; eviction past the cap. `roster.test.ts` unit. |
| AC6, AC7 | `roles-matrix.int`: the full matrix in section 7, each asserting the error, no broadcast, unchanged record (via a follow-up leader action) and no activity counted (prompt time unchanged). Includes "old connection right after handoff". |
| AC8 | `leader-race.int`: position.update / member.remove / vice.set / group.end sent in the same tick as the grace end (scheduler advance) -> exactly one outcome; never a relay after `leader.changed`. `leader-guard.test.ts` unit. |
| AC9 | `leader-rate-limits.int`: each limiter returns `RATE_LIMITED` with `retryAfterMs`; rejected requests emit nothing; windows reset. |
| AC10-AC13 | `vice.int`: set, replace, clear; target pending/parked/leader/removed/unknown/other-group/offline errors (byte-identical `PARTICIPANT_NOT_FOUND` across causes); events only to the old and new vice; cleared on leave/remove/promotion, kept on a disconnect; recovery restore with valid, blocked and unknown IDs. |
| AC14 | `grace.int`: return inside the grace period -> same leader, no role change, `leader.online`; `graceMs` value. |
| AC15, AC16, AC30 | `keepalive.int`, `leader-activity.int`: prompt timing; each counted action resets it; non-counted ones don't (rejected, rate-limited, member, heartbeat); `keepalive.cleared`; members never prompted; `leader.activity` carries no payload field (unknown keys are stripped by the schema, so nothing sent with it is read, stored or logged). |
| AC17, AC20, AC21, AC23 | `handoff.int`: missed keep-alive -> pause inactive -> grace -> vice (connected) or earliest-admitted member; frozen mode never hands off and ends at the bound; no candidate = frozen; new leader token claims (`term`, `gct` unchanged, `lat`); `leader.granted` contents (state, codes, pending requests, pause); `leader.lost`; `leader.changed` without IDs. Q2.3 second handoff. |
| AC18 | `lifecycle-states.int`: max session ends live, paused (offline and inactive), mid-grace and post-handoff groups at `createdAt + max`, never later. |
| AC19 | `timers-cleanup.int`: after end, drop, handoff and take-back, `timerCount` and `scheduler.pending` match expectations; `server.close()` leaves 0 pending. |
| AC22, AC27 | `escalation.int`: inactivity handoff, then the new leader misses -> `inactivity` end at countdown end (no grace); new leader acts once then idles -> normal handoff (D9); every end reason distinct and recorded in ended-groups. |
| AC24, AC25 | `take-back.int`: displaced leader resumes with its old leader token -> member + `takeback.offered`; even after the 25 min `lat` window; take-back swaps; anyone else `NOT_ALLOWED`; slot moves; timers restart; offer gone after end. |
| AC26 | `restart-handoff.int` (+ a `restart-process` case): both arrival orders; supersede with a stale list that blocks the real leader; codes adoption; demoted stale leader. |
| AC28 | `lifecycle-states.int` + client `client.lifecycle.test.ts`: every event mapped to state and indicator. |
| AC29 | `lock.int`: every method (A, B, C, D, approval) -> identical `GROUP_LOCKED`; checked before the door compare (no door failure counted); token resume and parked admission allowed; pending request survives and can be approved after unlock; independent of the door pause; recovery after restart. |
| AC32-AC34 | `remove-member.int`: events; block list in the reply; codes rotated (old code -> `CODE_NOT_FOUND`, old QR -> `QR_INVALID`); bypass attempts on every path (token resume, old codes, old QR ticket, approval with old identity, recreation); leader/self/unknown errors; vice cleared; full list -> `BLOCK_LIST_FULL` without eviction; `blocklist.set` cannot unblock (D5). |
| AC35-AC38 | `names.int` + `roles.test.ts`: the #10 rule on create, join (all methods), resume and `join.requested`; blank -> `Guest N`, unique, `guestNumber`; regenerated after a restart; resend on resume. |
| AC39 | `roles.test.ts`: every new schema, max lengths, unknown values rejected; `PROTOCOL_VERSION === 1`; token v2 schema and v1 rejection. |
| AC40-AC42 | `client.roles.test.ts`, `client.lifecycle.test.ts`, `preview.test.ts`, `token-store.test.ts`, `integration/roles.int`, `integration/handoff.int`: every method and event; token replaced on handoff and demotion; recovery persisted and re-sent; durations converted to local deadlines; preview never calls `updatePosition` and throttles `leader.activity`. |
| AC43 | `roles-privacy.int`: log capture at trace level over every flow; asserts no name, group-scoped ID, token, code, position or metadata; error messages contain none. |
| AC44 | `roles-isolation.int`: IDs and tokens from another group or app -> the same response as an unknown ID. |
| AC45 | The suites above, plus "block list transferred on handoff and enforced after a later restart". |
| AC46 | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit --audit-level=high`. No new dependency. |

## 13. Security-sensitive areas

Security-sensitive: yes

- **Authorization of every leader action** (D1, D2, section 7):
  `lifecycle/leader-guard.ts`, `group-service.ts`, `join-service.ts`.
- **Handoff, take-back and supersede** (control moves without consent; stale
  tokens; double leader): `lifecycle-service.ts`, `resume.ts`, the
  `group-service.ts` resume path.
- **Token format change** (`term` claim, format 2): `protocol/tokens.ts`,
  `token-service.ts`.
- **Removal and block list** (must stick; append-only; code rotation):
  `leader-controls.ts`, `join-service.ts`, store.
- **Lock** on every join path: `join-service.ts`.
- **New WebSocket handlers taking user input** (8 messages; IDs and names):
  `schemas.ts`, `connection.ts`.
- **PII** (display names of possible minors; group-scoped IDs): roster
  privacy, logging (`logger.ts` keys, AC43).
- **Flooding:** per-group limits (8.2).
- No new dependency, no secrets or config secrets, no crypto change beyond the
  new claim in the existing HMAC token.

## 14. Implementation

Implementer model: opus
Reason: security-sensitive (authorization, handoff, token format), a new
lifecycle state machine with timers and races, about 40 files across 3
packages.

### 14.1 Implementation chunks (planned commits, all in this repo)

Each chunk leaves `pnpm lint typecheck test build` green. Protocol types go in
with the server handler that uses them (the server's `handleReady` switch is
exhaustive).

1. `feat(protocol)!: add a leadership term claim and token format 2`
2. `refactor(server): authorize leader actions from the live group record`
3. `feat(config): add disconnect grace, keep-alive countdown and handoff mode`
4. `feat(server): keep a leader-only roster with display and generated names`
5. `feat(server): add the vice-leader designation`
6. `feat(server): lock groups against joining by every method`
7. `feat(server): remove members, block them and rotate the codes`
8. `feat(server): track leader activity and send keep-alive prompts`
9. `feat(server): pause groups for a grace period on disconnect or inactivity`
10. `feat(server): hand off leadership when the grace period ends`
11. `feat(server): end the group when the next leader misses the keep-alive`
12. `feat(server): let the displaced leader rejoin and take back the lead`
13. `feat(server): supersede a stale leader by leadership term after restart`
14. `test(server): cover the role matrix, leader races and rate limits`
15. `test(server): cover max session and timer cleanup in every state`
16. `test(server): keep names, ids and positions out of logs in role flows`
17. `test(server): try every removal bypass across handoff and restart`
18. `feat(client): add roster, names and handoff mode to the core client`
19. `feat(client): add vice-leader, lock and removal to the leader api`
20. `feat(client): track lifecycle, keep-alive and leadership changes`
21. `feat(client): add the leader preview helper`
22. `test(client): cover handoff, take-back and removal on a real server`
23. `docs: document roles, timers, lifecycle and the leader api`

### 14.2 Spec wording the engineer corrects (docs chunk)

- AC27: `leader_ended` -> the existing `ended_by_leader`; the frozen bound
  keeps `leader_timeout`.
- AC32: "live connections are closed" -> "the membership is closed with
  `group.ended removed`" (D6), unless the user picks otherwise (Q-A).
- AC35: names follow the strict #10 rule (Gate 1 Q5.5); blank -> generated.
- AC23: the recovery state lists `blockList, locked, viceId, handoff`;
  codes and pending approvals are sent alongside it.

### 14.3 Gate 2 questions (recommendation first)

- **Q-A Removal and the socket (D6).** Recommended: detach the membership and
  send `group.ended removed`, keeping the socket (as #5). Alternative: also
  close the WebSocket.
- **Q-B Escalation flag (D9).** Recommended: a missed-keep-alive leader
  that acts once is treated as a normal leader afterwards. Alternative: the
  flag lasts for that leader's whole term.
- **Q-C Block list append-only (D5).** Recommended: `blocklist.set` and leader
  returns merge only, and the client drops `removeFromBlockList`.
  Alternative: keep un-blocking through `blocklist.set` (contradicts Q4.5).
- **Q-D Lock answer for a valid code (D14).** Recommended: `GROUP_LOCKED`
  (distinguishable, per AC29). Alternative: answer `CODE_NOT_FOUND` while
  locked (no oracle, but confusing for real joiners).
- **Q-E Rate limit values (8.2).** Recommended as listed.

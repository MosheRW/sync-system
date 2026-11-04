# Architecture: #13 Roles, timers and group lifecycle (PRD item 5)

Issue: https://github.com/MosheRW/sync-system/issues/13
Spec: [`spec.md`](./spec.md) (46 ACs; Gate 1 accepted every recommended
default Q1.1-Q7, with Q5.5 changed to the strict #10 name rule)
Revision: 1 (after the security plan review round 1, [`security.md`](./security.md);
H1 closed in 6.6, every required control RC1-RC14 mapped in 13.1 and 14.1)
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
  generation (D4). Inside one process it orders grants and makes timers
  stale-safe.
- **Recovery anchor** (`rt` claim, revision 1 after the security plan review,
  H1): every token also carries the *pre-restart* term its leadership line was
  recovered from (`rt = term` for a line that was never recovered). After a
  restart, only a leader token whose anchor is newer than the recreated
  group's anchor *and* older than this process may supersede the recreator
  (section 6.6). Grants made inside the new process never gain supersede
  power, so a stale leader can't launder its old term through a handoff.
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
| D3 | **Leadership term and recovery anchor.** `term`: integer ms, set at create to `createdAt`, and on every handoff, take-back or supersede to `nextTerm = max(record.term + 1, nowMs)` (supersede: `nextTerm(max(record.term, claims.term), nowMs)`). A recreation keeps the token's term. **`rt`** (recovery anchor): `record.recoveredTerm` is set only by a recreation (`= claims.rt`) or a supersede (`= claims.rt`); every issued token carries `rt = record.recoveredTerm ?? record.term`. Token format version **2** with `term` and `rt` required (`gct <= rt <= term`). v1 tokens are rejected as `TOKEN_INVALID` (an unknown format, same as #5 AC8). | Q2.6. A plain counter breaks after a restart. The clock rule alone also breaks (security H1): a stale recreator hands off inside the new process and the new grant's `term` (`now`) beats every pre-restart term. So `term` only orders grants **inside** a process; across a restart, legitimacy is decided by `rt`, which in-process grants inherit unchanged and can never raise. Nothing is released, so the format bump costs nothing (spec AC39, #5 Q13). |
| D4 | **Role on resume comes from the record, not the token** (live group): `pid === record.leaderId` -> leader return (even with a member token; the `lat` bound then applies to that token too, advisory L2). A leader token that passes `canSupersede` (section 6.6) -> **supersede**. Any other token -> **member resume**, including a displaced leader's leader token (AC24) and every in-process leader token. The leader-token `lat` expiry (#5 check 3) applies whenever the token would act as leader (recreate, leader return, supersede). A `lat`-expired leader token never recreates or supersedes: for a group not in memory it gets `TOKEN_EXPIRED` (as #5 today), for a live group it resumes as a member (block list applies). | AC24, AC26, RC8. A displaced leader holds only its old leader token; it must still be able to rejoin as a member after the 25 min `lat` window. |
| D5 | **Block list is append-only while the group is live** (Q4.5). `blocklist.set` and a leader return with `blockList` **merge** (union) and never remove entries. A union past 256 entries fails with `BLOCK_LIST_FULL` and changes nothing; it never truncates or evicts (truncation would be an unblock; Q-C condition). A recreation takes the client's list as given (the server has none). A **supersede** replaces the stale list with the superseding leader's list, applied before the stale leader is demoted (section 6.6). | Q4.5 "removal is permanent for the session". The #5 test "unblocks when the list no longer holds the ID" changes on purpose. |
| D6 | **Removal reuses the #5 path**: the target's session is **fully detached** (notifier unregistered, any parked or pending-approval entry of that session dropped, no later broadcast reaches it) and gets `group.ended {reason: 'removed'}` as its **last** group frame, queued after its pending replies. The WebSocket stays open, as for a #5 block, and behaves as a fresh groupless connection under the existing join budgets. Then block-list append (`BLOCK_LIST_FULL`, never eviction), roster removal, vice cleared, take-back slot cleared, and a full rotation of codes **and** the QR ticket generation (`codes.updated` reason `member_removed`). Works on an offline roster member too (no session to detach). | AC32-AC33, RC4. "Connections closed" in AC32 is read as "group membership closed". Closing the socket would only start a reconnect loop that rejoin rules reject anyway. Gate 2 Q-A. |
| D7 | **Lazy timers.** One timer per kind per group (`GroupTimers`). The callback takes the lock, re-reads the record, and if the deadline moved (activity), re-arms instead of acting. `recordActivity()` only cancels a timer when it must send something (`keepalive.cleared`, unpause). | Position updates at 10/s must not cancel and re-arm timers. Same pattern as the max-session and frozen-end timers (#5 R3). |
| D8 | **Pause state** `record.pause = {cause: 'offline' \| 'inactive', graceEndsAt?: number}`. `leaderOnline` keeps its meaning (the connection). Members see a pause as `leader.offline {cause, graceMs?}` and the end of a pause as `leader.online`. `graceMs` is present only when a handoff can follow (`auto` mode). | AC14, AC17, AC28. Reuses the #5 messages, with two optional fields added. |
| D9 | **Escalation flag** `record.escalated`: true when the current leader got the lead through a *missed keep-alive* handoff; take-back, supersede and a disconnect handoff set it to `false` (RC13). It is cleared by that leader's first counted activity. While it is true, a missed keep-alive ends the group with reason `inactivity` when the countdown ends (AC22). | PRD: "escalation goes one step only". Clearing on activity means a new leader who answered once is treated like any other leader later. Gate 2 Q-B. |
| D10 | **Roster in the record**: `roster: RosterEntry[]` in admission order, `{pid, name, generated, admittedSeq, admittedAt, connected}`. Entries survive a disconnect (`connected: false`), so admission order (Q2.2), the vice and names survive reconnects. Leave, removal and group end delete entries. At most `maxGroupSize` disconnected entries are kept; past that, the oldest-disconnected entry is evicted (`roster.removed`). The entries of `displacedLeaderId` and `viceId` are **never** evicted (the next-oldest goes instead; so the cap can be exceeded by at most 2); if a vice entry is ever removed anyway, `viceId` is cleared (M3, RC10). `member.remove` accepts any roster entry, connected or not. | AC31, Q2.2, AC12. Bounds memory under join churn without letting churn hide the take-back holder from removal. An evicted member who returns gets a new admission time and a regenerated name (it is still admitted by token). |
| D11 | **Names**: one `resolveDisplayName(raw?)` in `@sync-system/protocol`. Missing, or blank after `trim()` -> generate. Otherwise `normalizeDisplayName` (the strict #10 rule, unchanged) or `INVALID_MESSAGE`. Generated: `Guest N`, N per group from 1, skipping any N whose text equals a chosen name in the roster; `generated: true` plus `guestNumber` so apps can localize. | AC35-AC37 with the Q5.5 change. This also changes #10's behavior for a blank join name from `INVALID_MESSAGE` to a generated name (AC36). |
| D12 | **Relative times only**: `graceMs`, `countdownMs`, `joinedAgoMs`. The client derives local deadlines. | Spec decision 5, AC42, same reason as #10 D6 (#9 clock skew). |
| D13 | **Recovery state** `LeaderState = {blockList, locked, viceId?, handoff}` goes to the leader in `group.created` (trivial), `group.resumed` and `leader.granted`, and the client stores it in `Recovery`. On recreation the client sends `blockList`, `locked`, `viceId`, `handoff` in `group.resume`. On a live leader return those fields are ignored (server wins), except the block-list union (D5). | Spec decision 3, AC13, AC23, Q4.3. |
| D14 | **Lock check placement** (Q-D conditions, RC3), in this order: (1) charge the join-attempt budget; (2) resolve the code, or fully verify the QR ticket (signature, expiry, generation); (3) under the group lock, check `locked`; (4) only then the door-code comparison, approval queueing or admission. The shared admit step checks `locked` again under the same lock (no TOCTOU), and so does `decide('approve')`. `GROUP_LOCKED` is one byte-identical text with no `details` for every method. | AC29. An invalid ticket never learns the lock state, and checking before the door compare means the lock never helps a door-code guesser (no door failure counted). A valid code on a locked group answers `GROUP_LOCKED`, not `CODE_NOT_FOUND`: the code is live, but nobody can join through it (Gate 2 Q-D). |

### 1.2 Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Keep `Membership.role` and update it on handoff | One missed update means a stale leader with powers. Deleting the field lets the compiler enforce AC6. |
| Integer term counter | Wrong order across restarts (D3). |
| Supersede by `claims.term > record.term` (plan round 0) | Security H1: an in-process handoff by a stale recreator mints `term = now`, above every pre-restart term. Replaced by the `rt` anchor rule (6.6). |
| Process-local "recovered term" map that outlives a dropped group, instead of the `rt` claim | Covers a drop and re-recreation in one process, but not a second restart: a stale line's in-process token would be a "pre-restart" token in the next process and could supersede the real leader there. The claim travels with the token, so it covers both (6.6.3). |
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
| `apps/sync-server/test/roster.test.ts`, `succession.test.ts`, `leader-guard.test.ts`, `resume.test.ts` | Unit tests (section 12). |
| `apps/sync-server/test/helpers/lifecycle.ts` | Helpers: `advanceToPrompt`, `advanceThroughGrace`, `expectLeader(ts, group, pid)`, an app config with short timers for readability (values within ceilings). |
| `apps/sync-server/test/*.int.test.ts` (new) | `roles-matrix`, `leader-race`, `leader-rate-limits`, `vice`, `grace`, `keepalive`, `handoff`, `escalation`, `take-back`, `restart-handoff`, `lifecycle-states`, `lock`, `leader-activity`, `roster`, `remove-member`, `names`, `roles-privacy`, `roles-isolation`, `timers-cleanup` (section 12). |
| `packages/client/src/preview.ts` | `LeaderPreview` helper (AC41). |
| `packages/client/src/leader-state.ts` | Client-side roster, vice, lock, keep-alive and take-back state, applied from server events (keeps `client.ts` from growing further). |
| `packages/client/test/preview.test.ts`, `client.roles.test.ts`, `client.lifecycle.test.ts`, `integration/roles.int.test.ts`, `integration/handoff.int.test.ts` | Client tests. |
| `packages/protocol/test/roles.test.ts` | Schemas of every new message, max lengths, `resolveDisplayName`. |

### 3.2 Modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/tokens.ts` | `TOKEN_FORMAT_VERSION = 2`; claims `term` and `rt` (ints, 0..MAX_SAFE_INTEGER, `gct <= rt <= term`); both in the fixed-order `payloadJson` so `resign` keeps them (RC5); `TokenRole = 'leader' \| 'member'` for `role`. |
| `packages/protocol/src/messages.ts` | `Role` adds `'vice-leader'`; `TokenRole`; new client and server messages (section 5); `GroupEndedReason` adds `'inactivity'`; `CodesUpdatedReason` adds `'member_removed'` and `'superseded'`; `AppLimits` adds 3 timers; `HelloOkMessage.defaultHandoff`. |
| `packages/protocol/src/schemas.ts` | Schemas for all of the above (strict lengths, ID patterns). |
| `packages/protocol/src/errors.ts` | `GROUP_LOCKED`, `NOT_ALLOWED`, `PARTICIPANT_NOT_FOUND`, `BLOCK_LIST_FULL`. |
| `packages/protocol/src/join.ts` | `resolveDisplayName(raw?)`; `GUEST_NAME_PREFIX` not exported (server only). `normalizeDisplayName` unchanged. |
| `packages/protocol/src/limits.ts`, `index.ts` | `HANDOFF_MODES`, `MAX_ROSTER_ENTRIES_FACTOR` (2), exports. |
| `apps/sync-server/src/groups/session.ts` | `Membership` loses `role` (D1). `GroupActions` gains the 8 new actions. |
| `apps/sync-server/src/groups/group-store.ts`, `in-memory-group-store.ts` | New `GroupRecord` fields (section 4); `addParticipant` takes the roster entry to admit or reconnect; `removeParticipant` takes `mode: 'disconnect' \| 'leave'`; new atomic `patch(ns, id, patch: GroupPatch)` for leadership, pause, lock, vice and activity fields; `setBlockList` keeps the removed-IDs return. `copy()` deep-copies `roster` and `pause`. |
| `apps/sync-server/src/groups/group-service.ts` | Reads `processStartedAt` once from the injected clock in the constructor and passes it to `classifyToken` and `LifecycleService` (RC6); uses `authorizeLeader`; `group.leave`'s `LEADER_CANNOT_LEAVE` moves inside the lock against `record.leaderId`, and a leave by `displacedLeaderId` clears the take-back slot (L3); `update` under the lock; `create`/`resume` take names, handoff and recovery state; `leaderOffline` pauses with grace; `disconnect` branches on `record.leaderId`; `classify` and resume follow D4; `applyBlockList` becomes a union (D5); roster deltas on join, leave and disconnect; delegates new actions to `LeaderControls`. |
| `apps/sync-server/src/groups/group-timers.ts` | Kinds `grace`, `keepAlivePrompt`, `keepAliveDeadline`; `clear(key, kind)`. `clear(key)` and `clearAll()` still cancel everything. |
| `apps/sync-server/src/groups/resume.ts` | `classifyToken` follows D4 and takes `processStartedAt`: new pure `canSupersede(record, claims, processStartedAt)` (6.6.1); blocked for any role (only a token passing `canSupersede` is exempt); `lat` checked whenever the token would act as leader (recreate, leader return with any token role, supersede); a `lat`-expired leader token is `expired` when the group is not in memory and `live` (member) otherwise; a leader token not matching the live leader and not superseding is `live` (member). |
| `apps/sync-server/src/joins/join-service.ts` | Host `ownedLeader` replaced by `authorizeLeader` inside the lock; `GROUP_LOCKED` checks (D14 order) in `joinByCode`, `joinByQr`, `decide('approve')` and again in the shared admit step; `admit` gets the resolved name; internal `rotateAll(record, reason)` (codes and QR ticket generation; no `codes.rotate` budget; reasons `member_removed`, `superseded`); `onLeaderReturn` also used after handoff, take-back and supersede. |
| `apps/sync-server/src/tokens/token-service.ts` | `IssueInput.term` and `IssueInput.rt` (always `record.recoveredTerm ?? record.term`, from one helper `tokenTermsOf(record)`); both in the payload; plausibility `gct <= rt <= term <= now + skew`. |
| `apps/sync-server/src/config/env.ts`, `apps-config.ts`, `apps/app-registry.ts` | `DISCONNECT_GRACE_SECONDS_CEILING` (default 120, bounds 1-3600), `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING` (120, 1-3600); app fields `disconnectGraceSeconds` (30), `keepAliveCountdownSeconds` (60), `defaultHandoff` (`auto`); AC2 cross-check. |
| `apps/sync-server/src/limits/constants.ts` | Rate limits (section 8.2). |
| `apps/sync-server/src/ws/connection.ts` | Dispatch of the 8 new types; `hello.ok` limits and `defaultHandoff`; `canCarryReqId` for new replies. |
| `apps/sync-server/src/ws/error-messages.ts` | Texts for the new codes; `NOT_LEADER` / `RATE_LIMITED` / `NOT_ALLOWED` texts per new action. |
| `apps/sync-server/src/logging/logger.ts` | Sensitive exact keys `pid`, `pids`, `successor`, `target`, `targetid`, `roster`, `participants`, `guestnumber`, `names`; fragments `leaderid` (covers `leaderId`, `displacedLeaderId`) and `viceid` (M2, RC9). `term`, `rt` and `handoffReason` stay loggable. |
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
term: number;                         // D3, orders grants inside this process
recoveredTerm: number | undefined;    // D3/6.6: anchor of a recreated line; undefined = created in this process
recoveryMarking: boolean;             // 6.6.4: true from a recreation until the first supersede
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
  admittedSinceRecovery: boolean;     // M4 marker (6.6.4)
}
```

Process state (not per group): `processStartedAt: number`, read once from the
injected clock when `GroupService` is constructed (RC6).

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
- `recoveredTerm` is undefined for a group created in this process; it is set
  only by a recreation or a supersede, and only increases. Every grant made in
  this process (create, handoff, take-back, supersede) has
  `term >= processStartedAt`.
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
| `group.resumed` (changed) | `+ displayName`, `+ generated`, `+ state: LeaderState`, `+ superseded: boolean`; on a supersede `token` is a **new** leader token (new `term`, `rt`), then `codes.updated {reason: 'superseded'}` if the codes were rotated | leader |
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
`RosterEntryWire = {participantId, displayName (<=128), generated, guestNumber?, role: Role, connected, joinedAgoMs, admittedSinceRecovery?: true}`.

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
{ v: 2, aud, gid, pid, role: 'leader'|'member', gct, lat, term, rt, iat, exp }
```
Every token carries the group's current `term` and `rt = recoveredTerm ??
term`. Both only matter for leader tokens (D3, D4, 6.6). Schema: integers,
`gct <= rt <= term`; plausibility `term <= now + skew`; both in the fixed-order
`payloadJson`, so a refresh (`resign`) keeps them unchanged (RC5). There is still no name, vice, lock or code in the token
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
`displacedLeaderId = old`, `escalated = (cause === 'inactive')` (false for a
disconnect handoff), `recoveredTerm` **unchanged** (the successor's token
inherits `rt`, 6.6.1),
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
  `displacedLeaderId` (anyone else gets `NOT_ALLOWED`, no state change, no
  budget spent). Rate limit (after the check), then a swap with the same steps
  as 6.5, reason `take_back`, `escalated = false`; the new `displacedLeaderId`
  is the leader it replaced. The new token inherits `rt` (6.6.1). Reply
  `leader.granted` (with reqId).
- **Displaced leader returns** with its old leader token: member resume (D4),
  then `takeback.offered` if its pid is `displacedLeaderId`. The leader
  recovery fields it sends are ignored.
- **Displaced leader leaves** (`group.leave` by `displacedLeaderId`): the slot
  is cleared, as on removal and end (L3).
- **Recreation** (group not in memory, leader token with valid `lat` and max
  session): `term = claims.term`, `recoveredTerm = claims.rt`,
  `displacedLeaderId = undefined`, `escalated = false`; recovery state as
  given by the client (vice validated as in 6.7).

#### 6.6.1 Supersede: who may (revision 1, closes H1)

Supersede is only for the case "a stale leader recreated the group after a
restart, then the real leader arrives". Two values decide it:

- `processStartedAt`: `clock.now()` read once when `GroupService` is
  constructed (injected clock; tests advance it across a simulated restart).
- `record.recoveredTerm`: set by a **recreation** to `claims.rt` of the
  recreating token, and by a **supersede** to `claims.rt` of the superseding
  token. A group created in this process has `recoveredTerm === undefined`.

```ts
// resume.ts, pure; claims already verified (signature, aud, plausibility, exp)
canSupersede(record, claims, processStartedAt, app, now) =
     record.recoveredTerm !== undefined          // 1. recreated (not created) in this process
  && record.recoveredTerm < processStartedAt      // 2. from a pre-restart line
  && claims.role === 'leader'
  && claims.pid !== record.leaderId
  && record.recoveredTerm < claims.rt             // 3. anchored on a newer pre-restart grant
  && claims.rt < processStartedAt                 // 4. that grant was made before this process
  && latValid(claims, app, now) && maxSessionValid(claims, app, now)
```

This is security's rule (`recoveredTerm < claims.term < processStartedAt`)
with `claims.rt` in place of `claims.term`. For a token whose line was never
recovered `rt === term`, so the two are identical; they differ only for
tokens issued under a recovered line (6.6.3 rows 5-7), which is exactly where
`term` would lie.

- Groups created in this process never supersede: explicit guard 1, not an
  emergent property of term order.
- In-process grants (handoff, take-back, supersede) carry
  `rt = record.recoveredTerm`, and a created group's tokens carry
  `rt = term >= processStartedAt`. So no in-process token can perform a
  supersede (its `rt` is not `> recoveredTerm`, or not `< processStartedAt`),
  and none can block one (supersede never compares against `record.term`).

#### 6.6.2 Supersede: what happens (under the group lock, one step)

1. **Requester's recovery first** (L1, RC7): validate the requester's
   `blockList` (schema, <= 256) and replace the stale list with it. The stale
   block list is **not** applied to the superseding token (a stale leader
   could otherwise recreate first with a list that blocks the real leader).
   Every attached member on the new list is detached as in D6
   (`group.ended removed`). If the **stale leader** is on the list it gets
   `group.ended {reason: 'removed'}` and no token, and its roster entry goes.
2. **Leadership**: `record.recoveredTerm = claims.rt`;
   `record.term = nextTerm(max(record.term, claims.term), now)`;
   `leaderId = requester`; `displacedLeaderId = undefined`;
   `escalated = false`; `pause = undefined`; `keepAlivePending = false`;
   `lastActivityAt = now`. Timers: clear grace, frozen-end and keep-alive,
   arm the prompt (RC13). Refresher reset for the requester.
3. **Stale leader** (if not removed in step 1): demoted; if attached it gets
   `leader.lost {reason: 'superseded', takeBackAvailable: false}` with a
   member token (new `term`, `rt`). Its old leader token now resumes as a
   member (`claims.rt <= recoveredTerm`, so not superseding).
4. **Rest of the recovery**: lock and handoff mode from the requester;
   `viceId` from the requester kept only if it is a roster pid, not the
   leader and not blocked (else cleared; the old vice gets
   `vice.changed {isVice: false}`).
5. **Codes** (M1): if the requester's blob is valid for this group, has a
   different generation and its codes are free, those codes **and** its QR
   ticket generation are adopted; otherwise codes **and** QR ticket generation
   are **rotated** (`rotateAll(record, 'superseded')`). Either way no code or
   ticket of the stale line survives.
6. **Replies**: requester `group.resumed {superseded: true}` with a **new**
   leader token (`term` from step 2, `rt = claims.rt`), then
   `roster.snapshot` (6.6.4 marker), `codes.updated {reason: 'superseded'}`
   if rotated, and `joins.onLeaderReturn`; members `leader.changed {reason:
   'superseded'}`. Log `leader_superseded {namespace, groupRef}` (no IDs).

Arrival order "real leader first" is plain: it recreates the group with
`recoveredTerm = T1`; the stale token (`rt = T0 < T1`) resumes as a member and
the real leader's block list applies to it (AC26, both orders tested).

#### 6.6.3 The H1 sequence and the other orderings, end to end

Notation: P1 = old process, P2 = after the restart (`processStartedAt = S2`),
P3 = after a second restart (`S3`). A leads at T0, hands off to B at T1 (both
in P1, so `T0 < T1 < S2`, `rt = term`). B removes A. A kept its leader token
`(term T0, rt T0)`.

| # | Sequence | Result with revision 1 |
| --- | --- | --- |
| 1 | **H1.** P2: A recreates (`recoveredTerm = T0`), designates M as vice, leaves; grace -> M leads with `term = m >= S2`, token `(m, rt T0)`. B arrives with `(T1, T1)`. | `canSupersede`: `T0 < S2`, `T0 < T1 < S2` -> **B supersedes**. `recoveredTerm = T1`, `term = nextTerm(max(m, T1), now)`. A is on B's list -> removed (step 1); M demoted; take-back slot empty. |
| 2 | After 1, M resumes with its offline in-process leader token `(m, rt T0)`. | `T0 < T1` fails -> member resume. M can't push B out (security's "offline post-restart token" case). |
| 3 | After 1, A retries its old token `(T0, T0)`. | Not superseding; blocked by B's list -> `blocked`. |
| 4 | P2: B arrives first, recreates (`recoveredTerm = T1`); A arrives. | A: `T0 < T1` fails -> member resume -> blocked. |
| 5 | **Drop and re-recreate in one process.** Case 1 up to M leading, then everyone disconnects -> group dropped (#5 AC22). M recreates with `(m, rt T0)`: `recoveredTerm = T0`. B arrives. | `T0 < T1 < S2` -> B supersedes. (Without `rt`, `recoveredTerm` would be `m >= S2` and B would be locked out.) |
| 6 | **Second restart.** Case 1 up to M leading, then P3 before B returns. M recreates with `(m, rt T0)` -> `recoveredTerm = T0 < S3`. B arrives with `(T1, T1)`. | `T0 < T1 < S3` -> B supersedes. Other order: B recreates (`recoveredTerm = T1`), M's `(m, rt T0)` -> member. (Without `rt`, M's `m < S3` would supersede B: the same hole one restart later.) |
| 7 | After 1 (B leads, token `(X, rt T1)`), P3: B recreates (`recoveredTerm = T1`). M or A arrive. | Both have `rt = T0` -> member / blocked. |
| 8 | Group created in P2 (`recoveredTerm` undefined); a test-keyring leader token for that gid with another pid, `rt < S2` and a high plausible `term`. | Guard 1 -> never supersedes; member resume. |
| 9 | Group created in P2, dropped, recreated in P2 from its own in-process token (`rt >= S2`). | `recoveredTerm >= S2` -> guard 2 -> never supersedes. |
| 10 | Genuine later P1 grant: B hands to C at T2 in P1. P2: B recreates (`recoveredTerm = T1`), C arrives `(T2, T2)`. | `T1 < T2 < S2` -> C supersedes (correct: C was the last real leader). Bounded by C's `lat` window, like any supersede. |
| 11 | `lat`-expired leader token of the real leader B. | Never supersedes or recreates (RC8): member resume in a live group (current list applies), `TOKEN_EXPIRED` for a group not in memory. |
| 12 | Stale recreator A sends `leader.takeBack` after B supersedes. | `displacedLeaderId` was cleared in step 2 -> `NOT_ALLOWED`. |
| 13 | Stale recreator A refreshes its token before B arrives (`resign`). | `term` and `rt` are kept by `resign` (RC5); A's line keeps `rt = T0`. |

What remains is the restart residual (section 11, M4): until B arrives, A
leads the recreated group. That is bounded by A's `lat` window (~25 min) and
by B arriving; no ordering lets A or its successors **keep** the lead once B
arrives inside B's own `lat` window.

#### 6.6.4 Members admitted since the recovery (M4 optional marker: taken)

`record.recoveryMarking` is `true` from a recreation until the first
supersede, `false` otherwise. A roster entry admitted by code, QR or approval
while it is `true` gets `admittedSinceRecovery = true`. The wire field is only
emitted once a supersede happened (`recoveryMarking === false` and the entry
flagged), so an honest recreator that is never superseded sees no marker. On
a supersede those entries go to the new leader with
`admittedSinceRecovery: true` in `RosterEntryWire`, so the real leader can
review and remove people the stale leader let in. Admissions after the
supersede, token resumes and groups created in this process never set it.
Cost: one boolean per entry. The other optional idea (pausing destructive
actions on evidence of a stale recreator) is **not** taken: the evidence is
heuristic and it would also block honest recreators.

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
- `member.remove`: authorize (6.8), validate (the target is any roster entry,
  connected or offline, not the leader, not oneself), then check
  `BLOCK_LIST_FULL`, then rate limit, then apply D6. The reply carries the new
  full block list for the client to persist (AC32).
- `group.leave`: the `LEADER_CANNOT_LEAVE` check moves inside the group lock
  and compares against `record.leaderId` (today it reads `membership.role`
  before the lock, `group-service.ts:693`). A leave by `displacedLeaderId`
  clears the take-back slot (L3).

### 6.8 Order of checks for every leader control (RC1, RC2, Q-E)

Inside one `runLocked` with no `await` that releases the lock between check and
effect: (1) `authorizeLeader` (parked/pending -> `NOT_LEADER`, groupless ->
`NOT_IN_GROUP`, not `record.leaderId` -> `NOT_LEADER`; `leader.takeBack`:
not `displacedLeaderId` -> `NOT_ALLOWED`); (2) input validation and state
checks (`PARTICIPANT_NOT_FOUND`, `NOT_ALLOWED`, `BLOCK_LIST_FULL`); (3) the
per-group limiter, keyed by `(namespace, groupId)`; (4) the effect, then
`recordActivity`. A rejected request at (1) or (2) never spends the budget, so
a member or the displaced leader can't drain the leader's budgets (above all
the activity budget that keeps the group from pausing). Limiter entries are
forgotten in `forgetGroup` (end and drop) and cleared in `close()`.

## 7. Authorization matrix (AC6, AC7)

Every leader-only action (`position.update`, `group.end`, `group.leave`'s leader
check, `blocklist.set`,
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
| `LEADER_ACTIVITY_PER_GROUP_PER_MINUTE` | 12 | group (`leader.activity` and `keepalive.ack` share it; but the **first** `keepalive.ack` while `keepAlivePending` is always accepted and not charged, so a spent budget can't make the real answer fail; advisory L5, adopted) |
| `LEADER_CONTROL_WINDOW_MS` | 60 000 | - |
| client `LEADER_ACTIVITY_MIN_INTERVAL_MS` | 10 000 | client throttle (well under 12/min) |

Every limiter is keyed by `(namespace, groupId)`, charged only after
authorization and validation (6.8), forgotten in `forgetGroup` and cleared in
`close()` (RC2).

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
leader recovery is dropped). On any demotion (`leader.lost` for every reason,
a demoting `group.joined`, `superseded`) and on removal, the client also drops
the roster, `LeaderState`, codes, QR tickets and pending approvals from memory
**and** storage (L4, RC12). On `group.resumed {superseded: true}` the client
replaces the stored leader token with the new one. `member.removed`, `lock.changed`,
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
  append-only); **Security notes** (RC14): one paragraph on the restart
  residual as widened by M4 (during the window a stale displaced leader can
  admit people through its stale codes, remove members, rotate codes, see the
  names of members who resume, and end the group for good; bounded by its
  `lat` window and by the real leader returning; newcomers of that window are
  flagged `admittedSinceRecovery`), one on auto-handoff power (L7: the
  successor gets codes, block list and can remove the original leader;
  recommend a vice-leader or `frozen` mode for sensitive sessions), and one on
  name rendering (L8: render `generated` or the ID so a chosen `Guest 3` can't
  pass as a generated name).
- `packages/client/README.md`: leader API, member take-back, events, states,
  indicator `leader_grace`, preview helper, recovery state, the removed
  `removeFromBlockList`.
- `config/apps.example.json`: the 3 new fields on the first app.
- `docs/issues/13/spec.md`: the corrections in 14.2.

## 11. Risks and edge cases

- **Restart window with a stale leader (residual, accepted by security
  provided H1 is fixed; README per RC14).** After a restart, a displaced
  leader whose token is still inside its `lat` window (about 25 min) can
  recreate the group first. It leads, with its own stale block list and
  codes, until the real leader returns and supersedes it (6.6). During that
  window it can admit people (a removed person under a new identity, through
  the stale codes), remove honest members (their clients delete their
  tokens), rotate codes, see the names of members who resume, and
  `group.end` the group (irreversible: ended-groups, the real leader then gets
  `GROUP_ENDED`). After a supersede the stale codes and tickets are gone (M1)
  and newcomers of the window are flagged `admittedSinceRecovery` (6.6.4).
  Without server persistence this can't be closed (PRD: nothing stored). H1
  (revision 1) makes it temporary: no ordering lets the stale line keep the
  lead once the real leader arrives (6.6.3).
- **Clock behind after a restart.** If the new process's clock is behind the
  old one (NTP step back), `processStartedAt` can be `<=` a genuine
  pre-restart `rt`, and that token can't supersede. This fails closed for the
  supersede (the stale recreator keeps leading until its own window ends,
  i.e. the residual above), never open. Same NTP assumption as #10 D4.
- **Late genuine supersede.** A pre-restart leader token with a newer anchor
  can supersede for as long as its own `lat` window allows, also after a
  second restart (6.6.3 row 10). That is the intended "most recent real
  grant wins", bounded by `lat` (~25 min).
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
- **Displaced leader or vice and roster churn** (M3): their entries are never
  evicted (D10), so the leader can always remove the take-back holder, even
  offline. Take-back depends on `displacedLeaderId`, which removal and leave
  clear.
- **Roster delta volume from reconnect churn** (advisory L6): accepted, not
  coalesced. Each delta is ~250 bytes to one socket and is bounded by the
  inbound and join limits a reconnecting member already hits (a loop of 20
  reconnects is tested in `roster.int`).
- **Leader return with a member token** (advisory L2): kept (a successor's
  old member token has the leader's pid), but the `lat` bound now applies to
  that token as well, so a copied old member token gives no more than the
  leader token would. Tested in `take-back.int`.
- **Auto handoff gives full control** (L7) and **chosen names that look
  generated** (L8): by design (Gate 1); README security notes.
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
| AC5, AC31 | `roster.int`: the leader's snapshot and deltas carry ID, name, role, connected, joinedAgoMs; members and the vice receive no roster frames and no IDs; pending, parked and removed participants absent; eviction past the cap never drops the displaced leader or the vice (M3); a reconnect loop stays within budgets (L6). `roster.test.ts` unit (eviction order, protected entries, vice cleared if ever evicted). |
| AC6, AC7 | `roles-matrix.int`: the full matrix in section 7, each asserting the error, no broadcast, unchanged record (via a follow-up leader action) and no activity counted (prompt time unchanged). Includes "old connection right after handoff". |
| AC8 | `leader-race.int`: position.update / member.remove / vice.set / group.end sent in the same tick as the grace end (scheduler advance) -> exactly one outcome; never a relay after `leader.changed`. `leader-guard.test.ts` unit. |
| AC9 | `leader-rate-limits.int`: each limiter returns `RATE_LIMITED` with `retryAfterMs`; rejected requests emit nothing; windows reset; non-leader and invalid requests (unknown pid, removing the leader) leave every budget untouched (RC2); budgets are per `(namespace, groupId)`; the first `keepalive.ack` of a prompt is accepted with the activity budget spent (L5); no limiter entry left after end, drop or `close()`. |
| AC10-AC13 | `vice.int`: set, replace, clear; target pending/parked/leader/removed/unknown/other-group/offline errors (byte-identical `PARTICIPANT_NOT_FOUND` across causes); events only to the old and new vice; cleared on leave/remove/promotion, kept on a disconnect; recovery restore with valid, blocked and unknown IDs. |
| AC14 | `grace.int`: return inside the grace period -> same leader, no role change, `leader.online`; `graceMs` value. |
| AC15, AC16, AC30 | `keepalive.int`, `leader-activity.int`: prompt timing; each counted action resets it; non-counted ones don't (rejected, rate-limited, member, heartbeat); `keepalive.cleared`; members never prompted; `leader.activity` carries no payload field (unknown keys are stripped by the schema, so nothing sent with it is read, stored or logged). |
| AC17, AC20, AC21, AC23 | `handoff.int`: missed keep-alive -> pause inactive -> grace -> vice (connected) or earliest-admitted member; frozen mode never hands off and ends at the bound; no candidate = frozen; new leader token claims (`term`, `gct` unchanged, `lat`); `leader.granted` contents (state, codes, pending requests, pause); `leader.lost`; `leader.changed` without IDs. Q2.3 second handoff. |
| AC18 | `lifecycle-states.int`: max session ends live, paused (offline and inactive), mid-grace and post-handoff groups at `createdAt + max`, never later. |
| AC19 | `timers-cleanup.int`: after end, drop, handoff and take-back, `timerCount` and `scheduler.pending` match expectations; `server.close()` leaves 0 pending. |
| AC22, AC27 | `escalation.int`: inactivity handoff, then the new leader misses -> `inactivity` end at countdown end (no grace); new leader acts once then idles -> normal handoff (D9); every end reason distinct and recorded in ended-groups. |
| AC24, AC25 | `take-back.int`: displaced leader resumes with its old leader token -> member + `takeback.offered`; even after the 25 min `lat` window; take-back swaps and sets `escalated = false`; anyone else `NOT_ALLOWED` with no budget spent; slot moves; timers restart; offer gone after end; a leave by the displaced leader clears the slot (L3); `LEADER_CANNOT_LEAVE` decided inside the lock right after a handoff (old leader may leave, new one may not); leader return with an old member token past its `lat` bound is refused (L2). |
| AC26 (H1, RC6-RC8) | `restart-handoff.int` (simulated restart: new server instance on the same keyring, clock advanced so `processStartedAt` > every P1 term): **every row of the 6.6.3 table** is one test, including the exact H1 sequence (A recreates, vice M, A leaves, grace handoff to M, B arrives -> B supersedes; A removed by B's list with no token; M demoted; take-back slot empty; then M's offline in-process leader token -> member; A's old token -> blocked), drop-and-re-recreate in one process, a second restart, a group created in this process never superseding with a test-keyring token, a `lat`-expired real leader token, take-back by the stale leader after supersede -> `NOT_ALLOWED`, `escalated` false after supersede. Codes: adopted from the requester's blob; requester blob invalid / same generation / taken -> rotated with `codes.updated {reason: 'superseded'}`, stale code -> `CODE_NOT_FOUND`, stale QR ticket -> `QR_INVALID` (M1). Roster after supersede flags code/QR/approval admissions of the window with `admittedSinceRecovery`, not token resumes; no flag for an honest recreator never superseded. Unit (new `resume.test.ts`): `canSupersede` truth table (each guard false on its own). |
| AC28 | `lifecycle-states.int` + client `client.lifecycle.test.ts`: every event mapped to state and indicator. |
| AC29 | `lock.int`: every method (A, B, C, D, approval) -> byte-identical `GROUP_LOCKED` with no `details`; join budget charged first; an invalid / expired / old-generation QR ticket on a locked group gets `QR_INVALID`, not `GROUP_LOCKED`; a lock set between the check and admission still refuses (admit-step re-check); checked before the door compare (no door failure counted); token resume and parked admission allowed; pending request survives and can be approved after unlock; independent of the door pause; recovery after restart. |
| AC32-AC34 | `remove-member.int`: events; block list in the reply; codes and QR ticket generation rotated (old code -> `CODE_NOT_FOUND`, old QR -> `QR_INVALID`); the removed session is fully detached (no parked or pending entry, `group.ended removed` is its last group frame, a later broadcast does not reach it, the socket can start a fresh join under the join budgets); removing an **offline** roster member works; bypass attempts on every path (token resume, old codes, old QR ticket, approval with old identity, recreation, after a supersede, after roster churn that would have evicted the displaced leader); leader/self/unknown errors; vice cleared; full list -> `BLOCK_LIST_FULL` without eviction, and a `blocklist.set` / leader-return union past 256 -> `BLOCK_LIST_FULL` with the list unchanged; `blocklist.set` cannot unblock (D5). |
| AC35-AC38 | `names.int` + `roles.test.ts`: the #10 rule on create, join (all methods), resume and `join.requested`; blank -> `Guest N`, unique, `guestNumber`; regenerated after a restart; resend on resume. |
| AC39 | `roles.test.ts`: every new schema, max lengths, unknown values rejected; `PROTOCOL_VERSION === 1`; token v2 schema and v1 rejection. |
| RC12 (L4) | `client.lifecycle.test.ts`: after `leader.lost` (each reason), a demoting `group.joined`, a supersede of this client, and removal, `getRoster()` / `getLeaderState()` are empty and the token store holds no roster, `LeaderState`, codes or pending approvals for that group. |
| AC40-AC42 | `client.roles.test.ts`, `client.lifecycle.test.ts`, `preview.test.ts`, `token-store.test.ts`, `integration/roles.int`, `integration/handoff.int`: every method and event; token replaced on handoff and demotion; recovery persisted and re-sent; durations converted to local deadlines; preview never calls `updatePosition` and throttles `leader.activity`. |
| AC43 | `roles-privacy.int`: log capture at trace level over every flow (incl. supersede); asserts no name, group-scoped ID, token, code, position or metadata; error messages contain none. `logger-redaction.test.ts` (RC9): the any-depth redaction test gets a `GroupRecord`-shaped object (roster entries with `pid`/`name`, `pause`, `viceId`, `displacedLeaderId`, `leaderId`, `successor`, `target`, a `LeaderState`) and asserts no ID or name survives while `term`, `rt` and `handoffReason` do. RC11 frame capture (`roles-privacy.int`): every frame a member and the vice receive over handoff, take-back, vice changes, lock, removal and supersede contains no pid but their own and no name. |
| AC44 | `roles-isolation.int`: IDs and tokens from another group or app -> the same response as an unknown ID. |
| AC45 | The suites above, plus "block list transferred on handoff and enforced after a later restart". |
| AC46 | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit --audit-level=high`. No new dependency. |

## 13. Security-sensitive areas

Security-sensitive: yes

- **Authorization of every leader action** (D1, D2, section 7, 6.8):
  `lifecycle/leader-guard.ts`, `group-service.ts`, `join-service.ts`.
- **Handoff, take-back and supersede** (control moves without consent; stale
  tokens; double leader; restart ordering, H1): `lifecycle-service.ts`,
  `resume.ts` (`canSupersede`), the `group-service.ts` resume path.
- **Token format change** (`term` and `rt` claims, format 2):
  `protocol/tokens.ts`, `token-service.ts`.
- **Removal and block list** (must stick; append-only; code and ticket
  rotation): `leader-controls.ts`, `join-service.ts`, store.
- **Lock** on every join path: `join-service.ts`.
- **New WebSocket handlers taking user input** (8 messages; IDs and names):
  `schemas.ts`, `connection.ts`.
- **PII** (display names of possible minors; group-scoped IDs): roster
  privacy, logging (`logger.ts` keys, AC43), client storage after demotion.
- **Flooding:** per-group limits (8.2, 6.8).
- No new dependency, no secrets or config secrets, no crypto change beyond the
  new claims in the existing HMAC token.

### 13.1 Security plan review round 1: how each finding is handled

Source: [`security.md`](./security.md) (round 1, FAIL on H1). Every required
control RC1-RC14 is part of this plan; the map to commits is in 14.1.

| Finding | Handling in this plan |
| --- | --- |
| **H1** (high) | Fixed as security proposed, generalized by one claim. `processStartedAt` from the injected clock; `record.recoveredTerm` set only by recreation and supersede; supersede only for groups recreated in this process (explicit guard) and only when `recoveredTerm < claims.rt < processStartedAt`; on supersede `recoveredTerm = claims.rt`, `term = nextTerm(max(record.term, claims.term), now)` and a **new** leader token. Token claim `rt` (= `recoveredTerm ?? term`) makes in-process grants inherit the anchor, which also closes two holes of the same kind that a process-local `recoveredTerm` leaves open: drop and re-recreation in one process, and a second restart (6.6.3 rows 5-6). For never-recovered tokens `rt === term`, so this is exactly security's condition there. The "offline post-restart leader token pushes out B" case is row 2. Tests: every 6.6.3 row (commit 13). |
| M1 | Supersede adopts the requester's codes **and** ticket generation, otherwise rotates both (`codes.updated {reason: 'superseded'}`), 6.6.2 step 5. Tested. |
| M2 | Keys and fragments as listed in 3.2 (`logger.ts`); any-depth test with a `GroupRecord`-shaped object (12, AC43). |
| M3 | D10: never evict `displacedLeaderId` or `viceId`; vice cleared if ever removed; `member.remove` on offline roster members (6.7). Tested. |
| M4 | README security note (10, RC14). Optional marker **taken**: `admittedSinceRecovery` (6.6.4). The "pause destructive actions" idea is not taken (heuristic, hurts honest recreators). |
| L1 | Requester's block list applied before the stale leader is demoted; a listed stale leader gets `group.ended removed` and no token (6.6.2 step 1). Tested. |
| L2 (advisory) | Adopted in part: leader return with a member token keeps working but is bound by that token's `lat` (D4, section 11). Tested. |
| L3 | A leave by the displaced leader clears the slot; `LEADER_CANNOT_LEAVE` inside the lock against `record.leaderId` (6.7). Tested. |
| L4 | Client drops roster, `LeaderState`, codes, tickets and pending approvals from memory and storage on every demotion and on removal (9.3). Tested. |
| L5 (advisory) | Adopted: the first `keepalive.ack` per prompt is always accepted and not charged (8.2). |
| L6 (advisory) | Accepted and noted (section 11); not coalesced. |
| L7, L8 (advisory) | README security notes (10). |

Conditions on the Gate 2 recommendations (section 4 of `security.md`) are in
the plan: Q-A in D6, Q-B in D9 / 6.5 / 6.6, Q-C in D5, Q-D in D14, Q-E in 6.8
and 8.2.

## 14. Implementation

Implementer model: opus
Reason: security-sensitive (authorization, handoff, restart ordering, token
format), a new lifecycle state machine with timers and races, about 40 files
across 3 packages.

### 14.1 Implementation chunks (planned commits, all in this repo)

Each chunk leaves `pnpm lint typecheck test build` green. Protocol types go in
with the server handler that uses them (the server's `handleReady` switch is
exhaustive). Numbers are unchanged from round 0 so `security.md`'s commit
references stay valid; the security controls each commit carries are listed
in brackets.

1. `feat(protocol)!: add leadership term claims and token format 2`
   [RC5: `term` and `rt` in the fixed-order `payloadJson`, `gct <= rt <=
   term`, plausibility, v1 -> `TOKEN_INVALID`; `record.term`; tokens issued
   with `rt = term` until commit 13]
2. `refactor(server): authorize leader actions from the live group record`
   [RC1: `authorizeLeader` inside the lock everywhere, `ownedLeader` replaced;
   `LEADER_CANNOT_LEAVE` inside the lock (L3)]
3. `feat(config): add disconnect grace, keep-alive countdown and handoff mode`
4. `feat(server): keep a leader-only roster with display and generated names`
   [RC9 keys (M2); RC10 eviction never drops displaced leader or vice (M3);
   `admittedSinceRecovery` field, default false]
5. `feat(server): add the vice-leader designation` [RC2 order 6.8]
6. `feat(server): lock groups against joining by every method`
   [RC3 / Q-D order and admit-step re-check; RC2]
7. `feat(server): remove members, block them and rotate the codes`
   [RC4 / Q-A full detach, codes and ticket generation, offline targets;
   Q-C `BLOCK_LIST_FULL` for remove, `blocklist.set` and leader-return union;
   RC2]
8. `feat(server): track leader activity and send keep-alive prompts`
   [RC2; L5 first ack per prompt uncharged; RC13]
9. `feat(server): pause groups for a grace period on disconnect or inactivity`
   [RC13]
10. `feat(server): hand off leadership when the grace period ends`
    [RC13: `escalated` per cause, `rt` inherited]
11. `feat(server): end the group when the next leader misses the keep-alive`
    [RC13]
12. `feat(server): let the displaced leader rejoin and take back the lead`
    [RC8 `classifyToken` (block list for every role, `lat` when acting as
    leader incl. leader return with a member token, L2); take-back sets
    `escalated = false` (RC13, Q-B); L3 slot cleared on leave; RC2; RC10
    tests]
13. `feat(server): supersede a stale leader after a restart by recovery term`
    [RC6 H1 fix: `processStartedAt`, `recoveredTerm`, `canSupersede`, `rt`
    issued from `recoveredTerm`, new token on supersede, every 6.6.3 row
    tested; RC7: requester block list first (L1), codes adopted or rotated
    (M1), slot cleared, vice validated; RC8 lat-expired never supersedes or
    recreates; RC13; M4 `admittedSinceRecovery` marker]
14. `test(server): cover the role matrix, leader races and rate limits`
    [RC1, RC2 matrix with untouched budgets; RC11 member/vice frame capture]
15. `test(server): cover max session and timer cleanup in every state`
    [RC13, RC2 `close()` leaves no timers or limiters]
16. `test(server): keep names, ids and positions out of logs in role flows`
    [RC9 any-depth test with a `GroupRecord`-shaped object]
17. `test(server): try every removal bypass across handoff and restart`
    [RC4 incl. after supersede (M1) and after roster churn (M3)]
18. `feat(client): add roster, names and handoff mode to the core client`
19. `feat(client): add vice-leader, lock and removal to the leader api`
20. `feat(client): track lifecycle, keep-alive and leadership changes`
    [RC12 / L4: drop leader-only data on demotion and removal; store the new
    token on supersede]
21. `feat(client): add the leader preview helper`
22. `test(client): cover handoff, take-back and removal on a real server`
23. `docs: document roles, timers, lifecycle and the leader api`
    [RC14 README security notes: restart residual (M4), auto-handoff power
    (L7), name rendering (L8)]

Required controls -> commits (from `security.md` section 5, unchanged mapping,
with the revision's additions):

| RC | Commits |
| --- | --- |
| RC1 | 2, 6, 7 (+ 14 tests) |
| RC2 | 5-8, 12, 14 (+ 15 `close()`) |
| RC3 | 6 |
| RC4 | 7, 17 |
| RC5 | 1 (now also `rt`) |
| RC6 | 13 (generalized by `rt`, 6.6.1) |
| RC7 | 13 |
| RC8 | 12, 13 |
| RC9 | 4 (keys), 16 (test) |
| RC10 | 4, 12 |
| RC11 | 14 |
| RC12 | 20 |
| RC13 | 8-13, 15 |
| RC14 | 23 |

### 14.2 Spec wording the engineer corrects (docs chunk)

- AC27: `leader_ended` -> the existing `ended_by_leader`; the frozen bound
  keeps `leader_timeout`.
- AC32: "live connections are closed" -> "the membership is closed with
  `group.ended removed`" (D6), unless the user picks otherwise (Q-A).
- AC35: names follow the strict #10 rule (Gate 1 Q5.5); blank -> generated.
- AC23: the recovery state lists `blockList, locked, viceId, handoff`;
  codes and pending approvals are sent alongside it.
- AC26: "the higher term wins" -> "the leader token anchored on the most
  recent pre-restart grant wins" (6.6.1).

### 14.3 Gate 2 questions (recommendation first, security view beside each)

- **Q-A Removal and the socket (D6).** Recommended: detach the membership and
  send `group.ended removed`, keeping the socket (as #5). Alternative: also
  close the WebSocket.
  *Security:* agrees. Condition (in the plan, D6): the session is fully
  detached (notifier, parked and pending entries), `group.ended removed` is
  its last group frame, no later broadcast reaches it.
- **Q-B Escalation flag (D9).** Recommended: a missed-keep-alive leader
  that acts once is treated as a normal leader afterwards. Alternative: the
  flag lasts for that leader's whole term.
  *Security:* agrees (liveness heuristic, not a control). Condition (in the
  plan, D9, 6.6): take-back and supersede set `escalated = false`.
- **Q-C Block list append-only (D5).** Recommended: `blocklist.set` and leader
  returns merge only, and the client drops `removeFromBlockList`.
  Alternative: keep un-blocking through `blocklist.set` (contradicts Q4.5).
  *Security:* agrees strongly. Condition (in the plan, D5): a union past 256
  fails with `BLOCK_LIST_FULL`, never truncates.
- **Q-D Lock answer for a valid code (D14).** Recommended: `GROUP_LOCKED`
  (distinguishable, per AC29). Alternative: answer `CODE_NOT_FOUND` while
  locked (no oracle, but confusing for real joiners).
  *Security:* `GROUP_LOCKED` is fine (no new oracle beyond #10 Q2.2).
  Conditions (in the plan, D14): join budget charged first; QR tickets fully
  verified before the lock check; lock before the door compare; one
  byte-identical text, no `details`.
- **Q-E Rate limit values (8.2).** Recommended as listed.
  *Security:* values fine. Conditions (in the plan, 6.8, 8.2): charged only
  after authorization and validation, keyed by namespace + group, forgotten
  on end/drop and cleared in `close()`; plus L5 for the ack (adopted).

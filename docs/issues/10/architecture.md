# Architecture: #10 Join methods A-D (door code, approval, alphanumeric, QR)

Issue: https://github.com/MosheRW/sync-system/issues/10
Spec: [`spec.md`](./spec.md) (45 ACs; Gate 1 accepted every recommended default Q1.1-Q6.3)
Path: full | Branch: `feat/10-join-methods` | Designer: skipped (no UI, Q1.4)
Builds on: #1, #3, #5, #7 (`docs/issues/{1,3,5,7}/*`). Every hardening control
from those issues stays in place; nothing here removes or weakens one. "Item N"
means PRD item N of 9. GitHub #9 (client clock skew) is out of scope, but the
new wire fields avoid absolute client-side deadlines for the same reason
(relative `...Ms` fields, section 4).

**Revision 1 (after security plan review round 1, [`security.md`](./security.md)).**
The review failed on H1 (door-code guessing spread over many groups was
uncapped and silent). This revision adds every required control R1a-R16 to the
plan. The main changes: door failures are counted since the last door-code
change, with no time decay (R1a, 5.3); a new fixed app-wide wrong-door budget
`DOOR_FAILURES_PER_APP_PER_MINUTE` (planned 30; set to 60 at Gate 2) checked
before the compare (R1b, 4.3); corrected brute-force numbers (R1c, 8.1); the
client keeps the highest-generation codes blob (R2, 7.3); generations in
milliseconds (R3, D4); stricter display names (R9, 4.5); `blob` redaction and
no `reason` log field (R10, 6.1); approval settles exactly once under the
group lock (R11, 4.6). Section 8.4 maps every control to a planned commit, and
section 8.5 records the advisories (M2, M3, L4, L5, L6).

**Revision 2 (Gate 2 decisions, section 12). Plan approved by the user.**
Q-A, Q-C and Q-D as proposed. Q-E: `DOOR_FAILURES_PER_APP_PER_MINUTE = 60`
(8.1 odds and 8.6 corrections updated). **Q-B changed from the
recommendation:** QR tickets get their own **ticket generation**
(`GroupCodes.ticketGeneration`), bumped only by leader-requested rotation
(`codes.rotate`) and by a new full code set the server issues for the leader
(recreation without a usable blob). Automatic door-code rotation after wrong
guesses still bumps the code generation (AC29) but **no longer invalidates QR
tickets** (D3, D4, D12, 4.7, 4.8). Security notes N1 (a blob from a direct
server reply is always stored) and N2 (the R1b check, compare and record run
in one synchronous step before any `await`) are folded into 7.3 and 4.3. Spec
AC wording the engineer updates is listed in 8.6.

## 1. Approach

Join codes are **group state** on the server (in the `GroupRecord`), indexed
per app for lookup, and protected by fixed brute-force limits. QR tickets and
the recovery copy of the codes are **stateless HMAC-signed strings** with keys
derived from `TOKEN_SECRET` under their own HKDF labels, the same pattern #5
used for tokens. Nothing goes to disk.

`GroupService` is already about 1060 lines, so join logic goes into a new
`apps/sync-server/src/joins/` module. `GroupService` stays the `GroupActions`
facade: it owns the per-group lock, the store, the notifier and the group
lifecycle, and calls `JoinService` through a narrow host interface.

```
Connection ──> GroupService (facade, GroupActions)
                 ├─ (existing) TokenService, GroupTimers, TokenRefresher, EndedGroups, ParkingLot
                 └─ JoinService                       new: every join and code flow
                      ├─ CodeIndex       per-app maps: 6-digit group code -> gid, 8-char code -> gid
                      ├─ codes.ts        draw a code set (CSPRNG, uniform), generation rule
                      ├─ DoorGuard       failures since the last door-code change (no decay), rotation window, method A pause timer
                      ├─ ApprovalQueue   method B pending requests (<= 10 per group), deadline timers
                      ├─ QrTicketService sign / verify QR tickets   (HKDF label "qr-ticket")
                      ├─ CodesBlobService sign / verify codes blobs (HKDF label "codes-blob")
                      └─ 5 SlidingWindowRateLimiters (join per conn, join per app, wrong door per app, qr.issue per conn, rotate per group)
```

Every state change still runs under the existing per-group `KeyedLock`
(`ns:groupId`), timer callbacks included. A code lookup happens **before** the
lock (the code tells us which group), then the flow takes that group's lock and
re-checks that the code still maps to the same group (it may have rotated or
been freed in between).

### 1.1 Key decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Codes live in `GroupRecord.codes` (+ `joinMethods`); the code -> group lookup is a separate process-local `CodeIndex`. | Codes are part of a group's state and travel with it through the store. The reverse index is a lookup structure like the notifier map; item 9 moves both to Redis. |
| D2 | One generic compact signed format (`base64url(payloadJson) "." base64url(hmac)`) for QR tickets and codes blobs, with **per-app, per-purpose** HKDF keys: `sync-system/qr-ticket/v1:<ns>` and `sync-system/codes-blob/v1:<ns>`. Token keys (`sync-system/token/v1:<ns>`) are unchanged. | Cross-app and cross-purpose isolation by construction: a ticket can't verify as a token or a blob, and the reverse, because the key differs (AC26). Two segments (a token has three, with a fixed header) also make the shapes disjoint. Same constant-time, charset-first rules as #5's `jwt.ts`. |
| D3 | QR ticket payload is minimal: `{"v":1,"g":<gid>,"n":<ticketGeneration>,"e":<exp seconds>}`. `n` is the group's **ticket generation** (D12), not the code generation. No namespace (the per-app key binds it), no server URL (Q3.3). | Keeps the worst-case ticket at about 170 characters, well under 256 (AC23). |
| D4 | Code generation rule (R3): every new code set gets `generation = max(previous + 1, nowMs)`, with `nowMs` the server clock in **milliseconds** (a safe integer, about 13 digits). A recreation with a valid blob keeps the blob's generation. | "Increases on every rotation" (AC6) holds. A full new set issued after a restart **without** a valid blob still gets a generation above every earlier one, so a ticket issued before the restart can't come back to life (AC25, AC33). With seconds, a few rotations inside one second could run the counter ahead of the clock and a quick restart could reuse a generation (security L1); with milliseconds that would take more than 1000 rotations per second, far above the limits. The ticket grows by about 3 characters and stays far below 256. A server clock stepping back stays a documented NTP assumption (section 9). |
| D5 | Wire field names are `joinCode`, `doorCode`, `displayName`, `ticket`, `joinCodes` (blob), never bare `code`. | Pino redaction is a second line of defense and can't redact `code`, which logs already use for error codes. Distinct names are redactable (section 8.3). |
| D6 | Relative times on the wire: `join.pending.timeoutMs`, `join.requested.expiresInMs`, `qr.ticket.expiresInMs`, `retryAfterMs`. The client derives local deadlines. | Server and client clocks differ (the subject of #9). A relative value is correct on any client clock. |
| D7 | QR refresh is **app-driven**: the client exposes `issueQrTicket()` and does not refresh on a timer (Q3.1, architect's choice). The README gives the recipe: re-issue at about 80 % of `expiresInMs` while the QR is on screen, and right after `codesChanged` with reason `rotated` or `resumed` (door rotations don't revoke tickets, D12). Confirmed by the user at Gate 2 (Q-D). | Only the app knows when the QR is visible. A background timer would spend the 6/min `qr.issue` budget while nothing is shown. Item 6 can wrap the recipe in a hook. |
| D8 | `joinByCode` / `joinByQr` promises resolve when the joiner is **admitted** (method B included) and reject with a typed error otherwise. While waiting for approval the group state is `awaiting_approval`. | One await per join flow for apps; the state and indicator cover the waiting UI. |
| D9 | Pending joiners whose group ends **or leaves memory** get an unsolicited `error` `GROUP_ENDED` (AC22), with no `groupId` and no `details` (R13). Confirmed by the user at Gate 2 (Q-C). | An existing, accurate code for "this group is gone for you". The joiner holds no token, so nothing else changes on the client. |
| D10 | `createGroup(metadata, initialPosition?, options?)` keeps its #3 positional `initialPosition` and adds a third `options` argument (`{ joinMethods? }`). | The spec's `createGroup(metadata, options?)` wording would break every existing caller that passes a position. Confirmed by the user at Gate 2 (Q-A); AC38's `createGroup(metadata, options?)` is implemented as this signature (no breaking change). |
| D12 | **Separate ticket generation (Gate 2 Q-B, user decision).** `GroupCodes` holds two counters. `generation` (the code generation) changes on **every** code change: create, door rotation, `codes.rotate`, new set on recreation. `ticketGeneration` changes only on a **ticket-revoking** change: create, `codes.rotate`, and a new full code set issued on recreation (no blob, invalid blob, other group or app, methods no longer allowed, or a code taken). On those changes the server first computes the new `generation` with the D4 rule and then sets `ticketGeneration = generation` (the same value). A door rotation computes a new `generation` and leaves `ticketGeneration` unchanged. QR tickets carry and are checked against `ticketGeneration` only. | The user doesn't want anyone who knows the group code to be able to cancel the leader's QR tickets with 5 wrong door codes. Taking the value from `generation` gives R3 for free: a ticket generation is always a code generation, so it is in milliseconds, never below the previous one and never below `nowMs` at the time it was set. Invariants (checked in code and tests): `ticketGeneration <= generation`; `ticketGeneration` never decreases while `generation` grows; a ticket generation only moves together with a code generation. Only the leader (by request or by recreation with the leader token) can cause a ticket-revoking change; nothing a joiner or guesser does can. |
| D11 | Test migration (AC44): server tests join through a new `joinByCode(ts, created, apiKey?)` helper and the existing `createGroupWithMembers`, which switches to codes. Client tests use `joinByCode()` with the codes from `createGroup()`. No test-only server flag. | Keeps the removed path removed (AC36) and exercises the real admission path everywhere. |

### 1.2 Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Separate `code.lookup` request for method A | Rejected at Gate 1 (Q2.2). |
| Codes inside the participant token | Codes rotate; every rotation would force a token re-issue (#5 architecture 4.1). |
| JWT format (reusing `TokenService`) for tickets and blobs | Three segments plus a header push the ticket past 256 characters, and sharing the token code path invites confusion between credential types. A tiny separate format with its own keys is simpler to reason about. |
| Server-side ticket table | Violates "persist nothing" and adds memory per ticket. Stateless tickets plus the generation check give the same revocation (rotate). |
| Client refreshes QR tickets automatically | See D7. |
| One generation for codes and tickets (the revision 1 plan and the security review's preference) | Rejected by the user at Gate 2 (Q-B): anyone who knows the group code could cancel the leader's QR tickets with 5 wrong door codes. Replaced by D12. AC29 still gets a new (code) generation on every door rotation. |
| A ticket generation with its own counter rule (independent of `generation`) | A second clock-based counter adds states (ordering against `generation`, its own R3 proof, its own R2 rule). Copying the value from `generation` keeps one rule and one ordering (D12). |
| Per-IP limits | Rejected at Gate 1 (Q5.3). |
| Putting codes into the client snapshot (`GroupState`) | Apps often log or serialize the snapshot. Codes are read through `getJoinCodes()` and the `codesChanged` event instead. |

## 2. Files

### 2.1 Create

| Path | What |
| --- | --- |
| `packages/protocol/src/join.ts` | `JoinMethod = 'A'\|'B'\|'C'\|'D'`, `JOIN_METHODS`, `ALPHA_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'`, `normalizeJoinCode(raw)` (strip spaces and hyphens, uppercase), `classifyJoinCode(normalized) -> 'group' \| 'alpha' \| undefined`, `isDoorCode(normalized)`, `normalizeDisplayName(raw) -> string \| undefined` (section 4.5, including the R9 well-formed UTF-16 and invisible-character rules), `QR_TICKET_PATTERN`, `CODES_BLOB_PATTERN`, `JOIN_REQUEST_ID_PATTERN`. Pure, no globals (SSR rule #3 AC7). Shared by server and client so both normalize identically (AC12). |
| `packages/protocol/test/join.test.ts` | Normalization, classification, alphabet (no 0/O/1/I/L), display-name rules, patterns. |
| `apps/sync-server/src/tokens/signed-blob.ts` | `signCompact(payloadJson, key)`, `verifyCompact(text, keys, maxLength) -> { payloadJson, keyIndex } \| undefined`: length first, exactly two segments, base64url charset before decoding, 43-character signature, `timingSafeEqual` against every key. |
| `apps/sync-server/src/tokens/qr-tickets.ts` | `QrTicketService.issue(ns, gid, ticketGeneration, now, seconds) -> { ticket, expiresInMs }`, `verify(ticket, ns, now) -> { ok: true, gid, ticketGeneration } \| { ok: false, expired: boolean }` (`expired` only for a well-formed, correctly signed ticket). |
| `apps/sync-server/src/tokens/codes-blob.ts` | `CodesBlobService.sign(ns, gid, methods, codes) -> string` (covers `generation` and `ticketGeneration`), `verify(blob, ns, gid) -> { methods, codes } \| undefined` (rejects a blob whose `t` is missing, not a safe non-negative integer, or greater than `n`). |
| `apps/sync-server/src/joins/join-methods.ts` | `defaultAppMethods(envAllowed)`, `resolveGroupMethods(app, requested?) -> { ok: true, methods } \| { ok: false }` (AC5 rules), `methodsKey()` canonical sort A-D. |
| `apps/sync-server/src/joins/codes.ts` | `GroupCodes` type, `drawGroupCode()`, `drawDoorCode(groupCode)`, `drawAlphaCode()` (`crypto.randomInt`, uniform), `nextGeneration(prev, nowMs)` (D4, milliseconds, R3), `issueCodeSet(index, ns, gid, methods, prevGeneration, now) -> GroupCodes \| 'exhausted'` (a full new set: `ticketGeneration = generation`, D12), `rotateDoorCode(index, ns, gid, codes, now) -> GroupCodes \| 'exhausted'` (new door code and `generation`, `ticketGeneration` copied unchanged, D12), `MAX_CODE_DRAWS = 20`. |
| `apps/sync-server/src/joins/code-index.ts` | `CodeIndex`: `lookup(ns, kind, code) -> gid \| undefined`, `claim(ns, gid, codes) -> boolean` (all or nothing), `release(ns, gid, codes)`, `size`, `clear()`. Synchronous, so a claim is atomic in-process. |
| `apps/sync-server/src/joins/door-guard.ts` | `DoorGuard` per group key: `recordFailure(key) -> 'counted' \| 'rotate'` (a plain counter since the last door-code change, no timestamps, no decay; R1a), `recordRotation(key, now) -> { paused: boolean, until? }` (resets the failure counter), `pausedFor(key, now) -> ms \| 0`, `reset(key)` (leader rotate), `clear(key)`, `clearAll()`. Pause-end timer on the injected `Scheduler`. |
| `apps/sync-server/src/joins/approval-queue.ts` | `ApprovalQueue`: `add(groupKey, session, displayName?, deadline, onTimeout) -> requestId \| 'full'`, `take(groupKey, requestId) -> entry \| undefined` and `takeBySession(session)` (both remove the entry and clear `session.pendingJoin` in one synchronous step, so the first caller wins and every later caller gets `undefined`; R11), `list(groupKey)`, `drain(groupKey)`, `clearAll()`. Request IDs from 16 CSPRNG bytes. |
| `apps/sync-server/src/joins/join-service.ts` | `JoinService`: `joinByCode`, `joinByQr`, `cancel`, `approve`, `deny`, `issueQr`, `rotate`, plus lifecycle hooks `initialCodes`, `restoreCodes`, `onLeaderReturn`, `onGroupGone`, `onDisconnect`, `close`. Talks to `GroupService` through a `JoinHost` interface (`runLocked`, `admit`, `deliverLater`, `leaderSession`, `store`, `now`). |
| `apps/sync-server/test/join-methods.test.ts`, `codes.test.ts`, `code-index.test.ts`, `door-guard.test.ts`, `approval-queue.test.ts`, `signed-blob.test.ts`, `qr-tickets.test.ts`, `codes-blob.test.ts` | Unit tests (section 10). |
| `apps/sync-server/test/join-code.int.test.ts` | A and C joins, errors, normalization, cross-app (AC12-AC18). |
| `apps/sync-server/test/join-approval.int.test.ts` | Method B (AC19-AC22). |
| `apps/sync-server/test/join-qr.int.test.ts` | Method D (AC23-AC26). |
| `apps/sync-server/test/join-bruteforce.int.test.ts` | Budgets, door rotation, pause, leader rotate (AC27-AC31). |
| `apps/sync-server/test/join-recovery.int.test.ts` | Codes across recreation and leader return (AC32-AC35). |
| `apps/sync-server/test/join-privacy.int.test.ts` | Log capture over every new path (AC10, AC20, AC31). |
| `apps/sync-server/test/join-removed.int.test.ts` | `group.join` gone; block-list re-entry only by current code (AC36, AC37). |
| `packages/client/test/client.join.test.ts`, `client.leader-codes.test.ts`, `integration/join.int.test.ts` | Client unit (fake socket) and real-server tests (section 10). |

### 2.2 Modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/limits.ts` | `MAX_JOIN_CODE_INPUT_LENGTH = 32`, `MAX_DISPLAY_NAME_INPUT_LENGTH = 128`, `MAX_DISPLAY_NAME_LENGTH = 32`, `MAX_QR_TICKET_LENGTH = 256`, `MAX_CODES_BLOB_LENGTH = 512`. |
| `packages/protocol/src/errors.ts` | New codes (section 4.4). `GROUP_NOT_FOUND` stays (internal races). |
| `packages/protocol/src/messages.ts`, `schemas.ts` | New and changed messages (section 4); `GroupJoinMessage` / `groupJoinSchema` removed (AC36). |
| `packages/protocol/src/index.ts` | Export new names; drop `GroupJoinMessage`, `groupJoinSchema`. |
| `packages/protocol/test/schemas.test.ts` | New messages and bounds; `group.join` now rejected. |
| `apps/sync-server/src/config/env.ts` | `JOIN_METHODS_ALLOWED` (list), `QR_TICKET_SECONDS_CEILING`, `APPROVAL_TIMEOUT_SECONDS_CEILING` (section 5). |
| `apps/sync-server/src/config/apps-config.ts` | `joinMethods`, `qrTicketSeconds`, `approvalTimeoutSeconds` (section 5.2). |
| `apps/sync-server/src/apps/app-registry.ts` | `AppConfig` gains `joinMethods: readonly JoinMethod[]`, `qrTicketSeconds`, `approvalTimeoutSeconds`. |
| `apps/sync-server/src/limits/constants.ts` | Fixed join constants (section 5.3), including `DOOR_FAILURES_PER_APP_PER_MINUTE` (R1b). |
| `apps/sync-server/src/limits/rate-limiter.ts` | `SlidingWindowRateLimiter` gains `check(key, limit) -> RateResult` (prunes and answers, records nothing) and `record(key)` (adds one event), for "check before, count only on failure" budgets (R1b). `tryAcquire` is unchanged. Unit tests in `rate-limiter.test.ts`. |
| `apps/sync-server/src/tokens/token-keys.ts` | `deriveAppKey(secret, ns, infoPrefix = HKDF_INFO_PREFIX)`; `TokenKeyring` takes an optional purpose prefix. Token keys byte-identical to today (pinned by test). |
| `apps/sync-server/src/server.ts` | Builds the two extra keyrings, `QrTicketService`, `CodesBlobService`, passes them to `GroupService`. |
| `apps/sync-server/src/groups/group-store.ts`, `in-memory-group-store.ts` | `GroupRecord.joinMethods`, `GroupRecord.codes`; `setCodes(ns, id, codes) -> GroupRecord \| undefined`; `copy()` copies `codes`. |
| `apps/sync-server/src/groups/session.ts` | `Session.pendingJoin?`; `GroupActions`: `join` removed; `joinByCode`, `joinByQr`, `cancelJoin`, `approveJoin`, `denyJoin`, `issueQr`, `rotateCodes` added. |
| `apps/sync-server/src/groups/group-service.ts` | Builds `JoinService`; `busy()` includes `pendingJoin`; create issues codes; `join()` and the group-ID path removed; `forgetGroup` / `endGroup` / `dropGroup` call `joins.onGroupGone`; leader return and recreation return codes; disconnect calls `joins.onDisconnect`; `close()` calls `joins.close()`. |
| `apps/sync-server/src/ws/connection.ts` | `hello.ok` gets `joinMethods` and the two new limits; dispatch for the new types; `group.join` case removed; `canCarryReqId` extended. |
| `apps/sync-server/src/ws/error-messages.ts` | Texts for the new codes; `ACTION_ERROR_TEXT` rows for the new actions (section 4.4). |
| `apps/sync-server/src/logging/logger.ts` | `REDACT_PATHS` adds `joinCode`, `doorCode`, `groupCode`, `alphaCode`, `codes`, `joinCodes`, `blob`, `ticket`, `requestId` (each also as `*.x`; R10). `displayName` is already there. `reason` is already redacted (#5), so no new log event uses a field named `reason` (6.1). |
| `apps/sync-server/test/helpers/groups.ts` | `createGroupWithMembers` joins by code; new `joinByCode(ts, created, opts)`, `codesOf(created)`. |
| `apps/sync-server/test/helpers/test-server.ts` | `TestAppInput` gains `joinMethods`, `qrTicketSeconds`, `approvalTimeoutSeconds`. |
| Server tests that send `group.join` (`end-leave`, `flood`, `frozen`, `groups`, `handshake`, `isolation`, `lifecycle`, `limits`, `opaque-payload`, `position`, `privacy`, `recreate`, `restart-process`, `restart`, `resume`, `robustness`, `slow-consumer`, `tokens`) | Join through the helpers (AC44). `groups.int` and `isolation.int` cases about group IDs become code cases; tests that loop more than 10 joins on one connection get a scheduler advance or new connections. |
| `apps/sync-server/test/env.test.ts`, `apps-config.test.ts`, `handshake.int.test.ts`, `token-keys.test.ts`, `error-messages.test.ts`, `in-memory-group-store.test.ts`, `logger.test.ts` | New config, `hello.ok` fields, key pinning, texts, store fields, redaction. |
| `config/apps.example.json`, `config/apps.dev.json` | `joinMethods` (example: `["A","D"]` and `["C","D"]`; dev: `["A","B","C","D"]` so every flow can be tried locally). |
| `compose.yaml` | `JOIN_METHODS_ALLOWED: A,B,C,D` with a comment. |
| `README.md` | Env vars, app settings, fixed join limits, brute-force reasoning with the corrected numbers, protocol summary, updated block-list note, and every R16 item (AC37, AC43; section 8.6). |
| `docs/issues/10/spec.md` | Corrections from the security review (R1c) and the Gate 2 Q-B / Q-E decisions (section 8.6): the "Defaults" table rows for door failures and the paragraph under the table, design decision 6, and the wording of AC25, AC29, AC30, AC32 and AC33 (ticket generation; intent unchanged). |
| `packages/client/src/state.ts` | `awaiting_approval` group state; `SyncIndicator` adds `'awaiting_approval'`; new event and result types (section 7). |
| `packages/client/src/errors.ts` | `RequestKind` swaps `group.join` for the new kinds; client codes `INVALID_JOIN_CODE`, `INVALID_DISPLAY_NAME`, `JOIN_METHOD_UNAVAILABLE`, `JOIN_CANCELLED`; details for `JOIN_PAUSED`, `RATE_LIMITED`, `APPROVAL_QUEUE_FULL`; `ACTION_MESSAGES` rows matching the server. |
| `packages/client/src/client.ts` | `joinGroup` removed; `joinByCode`, `joinByQr`, `cancelJoin`, leader API, new inbound messages, blob capture. |
| `packages/client/src/token-store.ts` | `Recovery.joinCodes?: string` and `Recovery.joinCodesGeneration?: number` (the **code** generation; validated on load: blob against `CODES_BLOB_PATTERN` and length, generation a safe non-negative integer; a blob without a valid generation is dropped). A blob from a direct server reply is always stored (N1); merging stored copies (cross-tab, stale writes) keeps the higher generation per group, independent of the token merge rule (R2, 7.3). The client never parses the ticket generation; it travels inside the signed blob. Document stays `v: 1` (additive). |
| `packages/client/src/limits.ts` | `CLIENT_LIMIT_BOUNDS` adds `qrTicketSeconds: 86_400`, `approvalTimeoutSeconds: 3_600`; `LIMIT_KEYS` extended. |
| `packages/client/src/transport.ts` | `KNOWN_TYPES` adds the new server types. |
| `packages/client/src/requests.ts` | No change in logic; new kinds flow through. |
| `packages/client/src/index.ts` | Export the new types; `JoinedGroup` stays. |
| `packages/client/README.md` | Join flows, leader API, errors, QR deep link in a URL fragment, updated block-list note (AC37, AC41, AC43). |
| Client tests using `joinGroup` (`client.close`, `client.groups`, `client.reconnect`, `client.rejoin`, `client.requests`, `client.resume`, `client.tokens`, `errors`, `requests`, `integration/*`) | Use `joinByCode` (AC44). `readme.test.ts` asserts the new headings. |

No database, no migrations. The client storage document stays `v: 1`: the new
`recovery.joinCodes` field is optional, and older documents load unchanged.

## 3. Data model (server memory only)

```ts
type JoinMethod = 'A' | 'B' | 'C' | 'D';

interface GroupCodes {
  generation: number;       // code generation, D4; safe integer; bumps on every code change
  ticketGeneration: number; // D12; = generation at the last ticket-revoking change; <= generation
  groupCode?: string;   // 6 digits; methods A or B
  doorCode?: string;    // 6 digits, != groupCode; method A
  alphaCode?: string;   // 8 chars from ALPHA_CODE_ALPHABET; method C
}

interface GroupRecord {              // #5 fields unchanged, plus:
  joinMethods: readonly JoinMethod[]; // canonical order, never both A and B
  codes: GroupCodes;                  // never logged
}

// GroupStore, new method (atomic, like the others):
setCodes(ns, id, codes: GroupCodes): Promise<GroupRecord | undefined>;
```

Process-local structures (all cleared on group end, drop and `server.close()`):

| Structure | Key -> value | Bound |
| --- | --- | --- |
| `CodeIndex` | `ns` -> `{ group: Map<code6, gid>, alpha: Map<code8, gid> }` | At most 2 entries per live group |
| `DoorGuard` | `ns:gid` -> `{ failures: number, rotations: number[], pausedUntil?, timer? }` | Method A groups only; `failures` is a counter since the last door-code change (0-4, R1a); at most 3 rotation timestamps (older ones pruned) |
| `ApprovalQueue` | `ns:gid` -> `Map<requestId, { session, displayName?, deadline, cancel }>`; `session.pendingJoin` back-pointer | 10 per group, 1 per connection |
| Join limiter (per connection) | `connectionId` -> timestamps | 10 per minute; forgotten on disconnect |
| Join limiter (per app) | `ns` -> timestamps | 600 per minute |
| Wrong-door limiter (per app, R1b) | `ns` -> timestamps of failed door compares | `DOOR_FAILURES_PER_APP_PER_MINUTE` (60, Gate 2 Q-E) per minute; cleared on `close()` |
| `qr.issue` limiter | `connectionId` -> timestamps | 6 per minute; forgotten on disconnect |
| Rotate limiter | `ns:gid` -> timestamps | 6 per minute; forgotten with the group |

The display name lives only inside the pending entry and the `join.requested`
frame. It is dropped when the request settles (AC20).

## 4. Wire protocol (still version 1)

New requests accept `reqId?`; direct replies echo it. Unknown fields stay
ignored. All string inputs have a schema length cap checked before any other
work (zod), so oversize input is `INVALID_MESSAGE`.

### 4.1 Client -> server

| type | Fields | Direct reply |
| --- | --- | --- |
| `group.create` (changed) | + `joinMethods?: JoinMethod[]` (1..4 items, enum) | `group.created` |
| `group.joinByCode` | `joinCode: string (<= 32)`, `doorCode?: string (<= 32)`, `displayName?: string (<= 128 raw)` | `group.joined` (A, C) or `join.pending` (B) |
| `group.joinByQr` | `ticket: string (<= 256)`, `displayName?: string (<= 128 raw)` | `group.joined`, or `join.pending` in a B group (Q3.2) |
| `join.cancel` | (none) | `join.cancelled { requestId }` |
| `join.approve` / `join.deny` | `requestId: string` (pattern) | `join.decided { requestId, outcome: 'admitted' \| 'group_full' \| 'denied' }` |
| `qr.issue` | (none) | `qr.ticket { ticket, expiresInMs }` |
| `codes.rotate` | (none) | `codes.updated { reason: 'rotated', ... }` with `reqId` |
| `group.resume` (changed) | + `joinCodes?: string (<= 512)` (the signed blob; leader recreation) | unchanged types, see 4.2 |
| ~~`group.join`~~ | **removed** (AC36): it is no longer in the union, so it gets the standard `INVALID_MESSAGE` | |

The display name is allowed on `group.joinByQr` too, because a QR joiner in a
B group goes through approval (Q3.2). For A, C and non-B QR joins it is
validated and then ignored.

### 4.2 Server -> client

| type | Fields | To / when |
| --- | --- | --- |
| `hello.ok` (changed) | + `joinMethods: JoinMethod[]`; `limits` + `qrTicketSeconds`, `approvalTimeoutSeconds` | Handshake (AC4) |
| `group.created` (changed) | + `joinMethods`, `codes: JoinCodesPayload` | Leader (AC6) |
| `group.resumed` (changed) | + `joinMethods`, `codes: JoinCodesPayload`, `codesChanged: boolean` | Leader return and recreation (AC33, AC34) |
| `codes.updated` | `groupId`, `reason: 'rotated' \| 'door_failures'`, `codes: JoinCodesPayload` | Leader: reply to `codes.rotate` (with `reqId`), or unsolicited after door failures (AC29, AC30) |
| `join.pending` | `requestId`, `timeoutMs` | Joiner, direct reply (AC19) |
| `join.requested` | `groupId`, `requestId`, `expiresInMs`, `displayName?` | Leader; re-sent on leader return (AC19, AC21, AC34) |
| `join.withdrawn` | `groupId`, `requestId`, `reason: 'cancelled' \| 'disconnected' \| 'timeout'` | Leader (AC21) |
| `join.decided` | `requestId`, `outcome` | Leader, reply to approve or deny |
| `join.cancelled` | `requestId` | Joiner, reply to `join.cancel` |
| `join.paused` | `groupId`, `retryAfterMs` | Leader, when method A pauses, and after `group.resumed` if still paused (AC29) |
| `join.resumed` | `groupId` | Leader, when the pause ends or is lifted by `codes.rotate` |
| `qr.ticket` | `ticket`, `expiresInMs` | Leader, reply to `qr.issue` |
| `group.joined` (unchanged shape) | | Also unsolicited (no `reqId`) to an approved joiner |
| `error` (unsolicited, no `reqId`) | `JOIN_DENIED`, `APPROVAL_TIMEOUT`, `GROUP_ENDED` | Pending joiner outcomes (AC21, AC22, D9) |

```ts
interface JoinCodesPayload {
  generation: number;  // the code generation; ticketGeneration is not on the wire (only inside the signed blob)
  groupCode?: string;  // present iff A or B
  doorCode?: string;   // present iff A
  alphaCode?: string;  // present iff C
  blob: string;        // signed codes blob (<= 512), for recovery (AC32)
}
```

A connection has at most one of: a membership, a parked group, a pending join
request. So unsolicited `group.joined` and pending-joiner errors are always
unambiguous on the client (state `waiting` -> parked admission, state
`awaiting_approval` -> approval outcome).

### 4.3 Request validation order

`group.joinByCode` and `group.joinByQr`, in order:

1. Schema (lengths, types) -> `INVALID_MESSAGE`.
2. Busy (membership, parked or pending) -> `ALREADY_IN_GROUP` (AC18). Spends no budget.
3. Per-connection join budget (10/min) -> `RATE_LIMITED` "Too many join attempts", `details { retryAfterMs }` (AC27).
4. Per-app join budget (600/min) -> same error; one rate-limited warning log per app per window, namespace only (as #7 L-2) (AC28).
   Per-connection first, so one socket over its own limit can't drain the app budget (#7 L2 reasoning).
5. Normalize and validate: `joinCode` (6 digits or 8 alphabet characters), `doorCode` (6 digits if present), `displayName` (4.5), ticket pattern. Failure -> `INVALID_MESSAGE` (AC12, AC20).
6. Lookup (code index, or ticket signature and expiry). Failure -> `CODE_NOT_FOUND` / `QR_INVALID` / `QR_EXPIRED` (AC13, AC25).
7. Under the group lock: re-check the code still maps to this group (else `CODE_NOT_FOUND`) and the record exists; then the method rules:
   - 6-digit code, group uses **A**, in this order:
     1. paused -> `JOIN_PAUSED { retryAfterMs }` (door code not checked, nothing compared; R6);
     2. no door code -> `DOOR_CODE_REQUIRED` (no failure counted, no app wrong-door budget used);
     3. **app wrong-door budget used up** (R1b): if the app's wrong-door limiter already holds `DOOR_FAILURES_PER_APP_PER_MINUTE` events in the last minute -> `RATE_LIMITED` with the join-attempt text "Too many join attempts" and `details { retryAfterMs }`, **without comparing** the door code; one `warn` log per app per window, namespace only (`door_failures_app_budget_exhausted`). This check only peeks; it records nothing;
     4. constant-time compare (both sides validated to `^[0-9]{6}$`, then `timingSafeEqual` on two 6-byte ASCII buffers; R6). Wrong -> record one event in the app wrong-door limiter, `DoorGuard.recordFailure` (R1a: every 5th failure since the last door-code change rotates), reply `DOOR_CODE_WRONG`. Correct -> admit; a correct door code never uses the wrong-door budget.

     The per-group door failure and the app wrong-door event are recorded together under the group lock. The app limiter is a plain synchronous structure, so the peek-then-record pair can't interleave with another group's attempt in the same app (one event-loop turn, no `await` between peek and record).

     **N2 (security round 2, binding).** Step 3 (`check`), step 4 (compare) and, on a wrong code, `wrongDoorLimiter.record` plus `DoorGuard.recordFailure` run as **one synchronous block with no `await` anywhere inside it**. Any async work they trigger (a door rotation's `store.setCodes`, notifying the leader) starts only **after** that block. The group lock does not cover this, because the lock is per group and the budget is per app. Test: on the 5th failure the rotation's `setCodes` is held pending (deferred store), and meanwhile attempts on other groups of the same app see the already-recorded event (the 61st is refused).
   - 6-digit code, group uses **B** -> approval (4.6).
   - 8-character code (C) -> admit.
   - QR ticket: group not in memory, ticket `n` != the group's current `ticketGeneration` (D12), or D not in methods -> `QR_INVALID`; B group -> approval; else admit. A door rotation does not change `ticketGeneration`, so it never affects this check.
   - Admit = `addParticipant` with a new pid (`GROUP_FULL { maxGroupSize }` if full) then `group.joined` with a member token, exactly as #5 (AC14, AC16). Works on frozen groups (AC17).

`CODE_NOT_FOUND` has one fixed text and no `details`, so "no such code", "code
of another app" and "code type the group doesn't use" are byte-identical
(AC13). Because a 6-digit code is only indexed for A or B groups and an
8-character code only for C groups, "type not used" is covered by construction.
`QR_INVALID` likewise has no `details` and never echoes the ticket (AC25).

### 4.4 New error codes and texts

| Code | Text (fixed) | `details` |
| --- | --- | --- |
| `CODE_NOT_FOUND` | `Join code not found` | - |
| `DOOR_CODE_REQUIRED` | `Door code required` | - |
| `DOOR_CODE_WRONG` | `Wrong door code` | - |
| `JOIN_PAUSED` | `Joining with the door code is paused; try again later` | `retryAfterMs` |
| `JOIN_DENIED` | `The leader denied the join request` | - |
| `APPROVAL_TIMEOUT` | `The join request was not approved in time` | - |
| `APPROVAL_QUEUE_FULL` | `Too many pending join requests for this group` | `maxPending` |
| `JOIN_METHOD_NOT_ALLOWED` | `Join method not allowed` | - (create with a bad set; `qr.issue` in a group without D) |
| `CODES_EXHAUSTED` | `No free join code; try again` | - |
| `QR_INVALID` | `Invalid QR code` | - |
| `QR_EXPIRED` | `QR code expired` | - |
| `JOIN_REQUEST_NOT_FOUND` | `Join request not found` | - (approve, deny or cancel of an unknown or settled request) |

Per-action texts (#7 A1 rule; `ACTION_ERROR_TEXT` rows, mirrored in the client's `ACTION_MESSAGES`):

| Code | Action | Text |
| --- | --- | --- |
| `RATE_LIMITED` | `group.joinByCode`, `group.joinByQr` | `Too many join attempts` |
| `RATE_LIMITED` | `qr.issue` | `Too many QR code requests` |
| `RATE_LIMITED` | `codes.rotate` | `Too many code rotations` |
| `NOT_LEADER` | `qr.issue` | `Only the leader can issue QR codes` |
| `NOT_LEADER` | `codes.rotate` | `Only the leader can rotate the codes` |
| `NOT_LEADER` | `join.approve` | `Only the leader can approve join requests` |
| `NOT_LEADER` | `join.deny` | `Only the leader can deny join requests` |

`NOT_IN_GROUP` for these leader actions when the session has no membership,
as today.

### 4.5 Normalization rules (shared in `@sync-system/protocol`)

- Codes: remove every `' '` and `'-'`, uppercase ASCII letters. Result must be
  `^[0-9]{6}$` (group or door code) or `^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$`
  (alphanumeric code). Anything else is invalid (AC8, AC12).
- Display name: first rejected if the raw string is not well-formed UTF-16
  (a lone surrogate such as `\ud800`, checked with a surrogate-pair regex so it
  doesn't depend on `String.prototype.isWellFormed` being available in every
  client runtime; R9). Then `trim()`; length 1..32 counted in code points;
  rejected if it contains `\p{Cc}` (control characters), U+2028/U+2029, bidi
  overrides and isolates (U+202A-U+202E, U+2066-U+2069), or the invisible
  format characters U+061C (ALM), U+200B (ZWSP), U+200E (LRM), U+200F (RLM)
  and U+FEFF (BOM) (R9). The bidi and format-character rules are additions to
  the spec's "no control characters", to stop a name from visually reordering
  or hiding text in the leader's prompt. Emoji stay allowed, including ZWJ
  (U+200D) sequences, variation selectors and emoji tag characters (AC20).
  The same function runs on server and client.
- QR ticket: `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`, total <= 256.
- Codes blob: `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`, total <= 512.
- Request ID: 22 base64url characters (16 CSPRNG bytes).

### 4.6 Method B approval flow

- On a valid B code (or a QR ticket for a B group): if the queue holds 10 ->
  `APPROVAL_QUEUE_FULL { maxPending: 10 }`. Else a request is added with
  `deadline = now + approvalTimeoutSeconds * 1000`, `session.pendingJoin` is
  set, the joiner gets `join.pending { requestId, timeoutMs }`, and the leader
  (if attached) gets `join.requested` through `afterPending` (AC19). Frozen
  group: the request waits; nothing is sent until the leader returns (Q6.2).
- `join.approve`: leader only (ownership-checked, `NOT_LEADER` otherwise).
  Request taken from **this group's** queue only (a request ID of another group
  is `JOIN_REQUEST_NOT_FOUND`). `addParticipant`: ok -> joiner gets unsolicited
  `group.joined` (token), leader gets `join.decided admitted`; full -> joiner
  gets unsolicited `GROUP_FULL`, leader gets `join.decided group_full` (AC21).
- `join.deny`: joiner gets unsolicited `JOIN_DENIED`; leader gets `join.decided denied`.
- Deadline timer (scheduler, under the group lock): joiner gets
  `APPROVAL_TIMEOUT`, leader gets `join.withdrawn timeout`.
- `join.cancel` from the joiner: reply `join.cancelled`; leader gets
  `join.withdrawn cancelled`. Disconnect: leader gets `join.withdrawn disconnected`.
  `join.cancel` with no pending request -> `JOIN_REQUEST_NOT_FOUND`.
- Leader return (AC21, AC34): after `group.resumed`, every still-pending
  request is re-sent as `join.requested` with the remaining `expiresInMs`.
- Group end or drop: every pending joiner gets unsolicited `GROUP_ENDED`
  (D9), all timers are cancelled, nobody is admitted (AC22).
- A server restart loses pending requests (Q6.3). The joiner's socket closes,
  so its client rejects the join with `CONNECTION_LOST` and doesn't re-request.
- **Exactly-once settlement (R11).** Every way a request can end (approve,
  deny, deadline timer, `join.cancel`, joiner disconnect, group end or drop)
  takes the group's `KeyedLock` and starts by **removing** the entry from the
  queue (`take` / `takeBySession` / `drain`). Only the caller that got the entry
  acts on it; any later caller finds nothing (approve and deny reply
  `JOIN_REQUEST_NOT_FOUND`, the timer and disconnect do nothing). The deadline
  timer is cancelled by whoever removed the entry. Approve re-checks, under the
  lock and after removal, that the joiner's session is still open and still
  points at this request (`session.pendingJoin`); if not, the leader gets
  `JOIN_REQUEST_NOT_FOUND` and nobody is added, so no orphan member or token is
  created. The joiner-disconnect path runs through the same lock (the
  connection's close handler calls `joins.onDisconnect`, which takes it).
  Tests race approve against disconnect, cancel and the timer, in both orders,
  and assert one outcome to each side.

### 4.7 QR tickets (AC23-AC26)

- `qr.issue`: ownership-checked leader (`NOT_LEADER` / `NOT_IN_GROUP`); D in
  methods (else `JOIN_METHOD_NOT_ALLOWED`); 6 per connection per minute.
  Ticket = `signCompact({"v":1,"g":gid,"n":ticketGeneration,"e":expSeconds}, qrKey(ns))`
  with `exp = now + qrTicketSeconds`; reply `expiresInMs = qrTicketSeconds * 1000`.
- Verification order: length and pattern; signature with the current then the
  previous qr key (constant time, every key checked); parse JSON in try/catch;
  exact claim schema (`v === 1`, `g` matches `GROUP_ID_PATTERN`, `n` and `e`
  safe non-negative integers, `e * 1000 <= now + qrTicketSecondsCeiling * 1000 + MAX_CLOCK_SKEW_MS`
  as a plausibility bound); then expiry -> `QR_EXPIRED`; then group lookup under
  the lock (not in memory, ticket generation mismatch, no D) -> `QR_INVALID`.
- Multi-use until expiry (AC24). **Revocation (D12, Gate 2 Q-B):** outstanding
  tickets stop working when the ticket generation changes, which happens only
  on `codes.rotate` (leader request) and on a new full code set issued on
  recreation (leader token). A door rotation after wrong door codes bumps the
  code generation (AC29) but **not** the ticket generation, so the leader's QR
  tickets keep working (AC25 as reworded in 8.6). Group end or drop makes them
  `QR_INVALID` as before (group not in memory).
- **No revival after restart.** Recreation with a valid, usable blob keeps the
  blob's `generation` and `ticketGeneration` (tickets issued before the restart
  keep working, as before). Recreation without one (missing, invalid, other
  group or app, methods no longer allowed, a code taken) issues a full new set:
  `generation = nextGeneration(blobGeneration ?? 0, nowMs)` and
  `ticketGeneration = generation`, which is `>= nowMs` and so above every
  ticket generation set before the restart (every earlier one was a code
  generation set at an earlier time, and the D4 counter can't run ahead of the
  clock by more than the rotation limits allow). So an older ticket stays
  `QR_INVALID` (R3 test, 10).
- A ticket can't verify as a token (different key, two segments, no JWT header)
  and a token can't verify as a ticket (different key, three segments). Both
  directions tested (AC26).

### 4.8 Codes blob and recovery (AC32-AC35)

- Blob = `signCompact({"v":1,"g":gid,"n":generation,"t":ticketGeneration,"m":"AD","gc":"...","dc":"...","ac":"..."}, codesKey(ns))`
  (absent codes omitted; `t` always present). Sent in every `JoinCodesPayload`.
  Verification requires `t` a safe non-negative integer with `t <= n`; else the
  blob is invalid (treated as missing). The extra field adds about 20
  characters; a maximal blob stays well under 512 (pinned by test).
- **Recreation** (`group.resume`, leader token, group not in memory): verify
  the blob (current or previous codes key) and require `g === claims.gid`,
  `m` a valid method set that is a subset of the app's current `joinMethods`,
  and code formats that match `m`. If valid and `CodeIndex.claim` succeeds for
  all its codes -> same codes, `generation` and `ticketGeneration`, `codesChanged: false`. Otherwise
  (missing, invalid, other group or app, methods no longer allowed, or any code
  taken) -> methods = blob methods intersected with the app's methods if that
  is still a valid set, else the app default (AC5 rule); a full new set via
  `issueCodeSet` with `nextGeneration(blobGeneration ?? 0, now)` and
  `ticketGeneration` set to that same value (D12, ticket-revoking);
  `codesChanged: true` (AC33). `CODES_EXHAUSTED` here is reported as the resume
  error and nothing is recreated.
- **Leader return** to a live group: the blob is ignored for state; the reply
  carries the current codes and a fresh blob. `codesChanged` is true unless the
  presented blob verified and has the current generation (door rotations while
  the leader was offline show up as changed) (AC34).
- The server never accepts codes it didn't sign for that group ID (AC33).
- **Older blob replay** (security M1): the server can't tell an older,
  correctly signed blob from the latest one after a restart (it keeps no
  state). The control is on the client (R2, 7.3): the client stores the blob's
  generation next to it and, when merging stored copies, never replaces a
  stored blob with one of a lower generation for the same group, including
  across tabs and independent of the token merge rule (a blob in a direct
  server reply is always stored, N1). So the leader's own clients only ever
  send the newest blob they have seen. Residual: someone who copied an old
  blob **and** holds the leader token can still present it; that person
  already controls the group. With D12 the old blob also carries its old `t`,
  so unexpired tickets from that blob's era would match again; same residual,
  same holder (leader token), and bounded by ticket expiry.
- **R2 with two generations.** R2 compares the code `generation` only. That is
  enough for the ticket generation too: by D12, `ticketGeneration` never
  decreases as `generation` grows and is always `<= generation`, so the blob
  with the highest code generation also has the highest ticket generation. No
  second comparison on the client, and the client never reads `t`.

### 4.9 Frame sizes

- `group.resume` grows by at most 512 + ~20 bytes; `RECOVERY_EXTRA_BYTES`
  (16 384) already has more than that in slack (256 IDs x 39 + 2048 = 12 032),
  so `transportMaxPayload` is unchanged. A test pins a maximal resume frame
  (256 IDs, 2048 token, 512 blob, metadata and position at the ceiling).
- Client: `group.resumed` / `group.created` grow by about 320 characters,
  inside `FRAME_OVERHEAD_CHARS` (8192). `hello.ok` grows by about 80 characters,
  inside `PRE_HANDSHAKE_MAX_CHARS` (8192). No limit change.

## 5. Configuration

### 5.1 Env variables

| Variable | Default | Rule |
| --- | --- | --- |
| `JOIN_METHODS_ALLOWED` | `A,B,C,D` | Comma-separated, whitespace around items trimmed, letters `A`-`D` (case-sensitive, uppercase). Empty, unknown letter or duplicate -> `Config error: JOIN_METHODS_ALLOWED must be a non-empty comma-separated list of distinct methods A, B, C, D`. Never echoes the value (AC1). |
| `QR_TICKET_SECONDS_CEILING` | 3600 | Positive integer, `30 <= value <= 86400` (AC3). |
| `APPROVAL_TIMEOUT_SECONDS_CEILING` | 600 | Positive integer, `15 <= value <= 3600` (AC3). |

The lower bounds keep `min(default, ceiling)` above each field's minimum. The
upper bounds match the client's `CLIENT_LIMIT_BOUNDS`, so a valid server
config can't trip `SERVER_UNSUPPORTED`.

### 5.2 Apps config

| Field | Default | Validation |
| --- | --- | --- |
| `joinMethods` | `["A","D"]` intersected with `JOIN_METHODS_ALLOWED` | Non-empty array of distinct `A`-`D`. A method the env doesn't allow: `apps[0] (namespace "x"): joinMethods "C" is not in JOIN_METHODS_ALLOWED`. Empty default intersection: `apps[0] (namespace "x"): joinMethods is required because JOIN_METHODS_ALLOWED does not include A or D`. Never clamped or dropped (AC2). Stored in canonical order. |
| `qrTicketSeconds` | 300 | `LIMIT_FIELDS` entry: integer >= 30, <= `QR_TICKET_SECONDS_CEILING` (AC3). |
| `approvalTimeoutSeconds` | 120 | `LIMIT_FIELDS` entry: integer >= 15, <= `APPROVAL_TIMEOUT_SECONDS_CEILING` (AC3). |

`parseAppsConfig` already receives the env ceilings; its `Ceilings` pick gains
the two ceilings and `joinMethodsAllowed`.

### 5.3 Fixed constants (`limits/constants.ts`, not configurable; Q5.x)

| Constant | Value |
| --- | --- |
| `JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE` | 10 |
| `JOIN_ATTEMPTS_PER_APP_PER_MINUTE` | 600 |
| `JOIN_WINDOW_MS` | 60 000 |
| `DOOR_FAILURES_BEFORE_ROTATION` | 5, counted since the last door-code change (no time window; R1a) |
| `DOOR_FAILURES_PER_APP_PER_MINUTE` | **60** (user decision at Gate 2, Q-E; R1b) |
| `DOOR_FAILURES_APP_WINDOW_MS` | 60 000 |
| `DOOR_ROTATIONS_BEFORE_PAUSE` / `DOOR_ROTATION_WINDOW_MS` | 3 / 1 800 000 |
| `DOOR_PAUSE_MS` | 600 000 |
| `QR_ISSUE_PER_CONNECTION_PER_MINUTE` | 6 |
| `CODE_ROTATIONS_PER_GROUP_PER_MINUTE` | 6 |
| `MAX_PENDING_APPROVALS_PER_GROUP` | 10 |
| `MAX_CODE_DRAWS` | 20 |

Door-failure rotation (R1a): `DoorGuard` counts wrong door codes **against the
current door code**, with no time decay. On the 5th failure since the last
door-code change (whenever those 5 happened), the door code alone is redrawn,
the code generation bumps (D4) while the ticket generation stays the same (so
QR tickets keep working, D12), the counter resets to 0, and the leader gets
`codes.updated door_failures`. So there is no silent sub-threshold guessing:
every 5 wrong guesses against a door code change it and tell the leader. This
is stricter than AC29 ("5 within 10 minutes" still rotates) and therefore
satisfies it. Any door-code change resets the counter: a door rotation, a
leader `codes.rotate`, and a new code set on recreation. The rotation is
recorded; if it is the 3rd inside 30 minutes, method A pauses for 10 minutes
(`join.paused` to the leader; `join.resumed` from the pause timer). Pause rule
unchanged. `codes.rotate` resets the counter, rotation history and any pause
(AC29, AC30).

App wrong-door budget (R1b): independent of the per-group counter, at most
`DOOR_FAILURES_PER_APP_PER_MINUTE` failed door compares per app per sliding
minute. It is checked before the compare and counted only when the compare
fails (4.3 step 7). It caps untargeted guessing spread over many groups
(section 8.1). Correct door codes, `DOOR_CODE_REQUIRED`, paused groups and
other methods never use it. The 600/min join budget still applies first.

## 6. Server behavior summary

- **Create** (AC5-AC11): `resolveGroupMethods` (`JOIN_METHOD_NOT_ALLOWED`
  before anything is stored); `issueCodeSet` claims the codes in `CodeIndex`
  (`CODES_EXHAUSTED` -> nothing registered, no record); record stored with
  `joinMethods` and `codes`; reply with `codes` and blob. Order: size checks,
  methods, codes, store, timers (as today).
- **End and drop** (AC11, AC22, AC31): `forgetGroup` gains `joins.onGroupGone`:
  release codes, cancel door-guard and approval timers, notify pending joiners
  (`GROUP_ENDED`), forget the rotate limiter. Runs for `endGroup` (all reasons)
  and `dropGroup`.
- **Disconnect**: `joins.onDisconnect(session)` forgets the join and qr
  limiters for the connection and withdraws a pending request (leader gets
  `join.withdrawn disconnected`).
- **`server.close()`**: `joins.close()` clears every timer, queue, index and
  limiter (ManualScheduler pending = 0; AC31).
- **Leader return / recreation**: codes in `group.resumed`, pending requests
  re-sent, `join.paused` re-sent if still paused (AC33, AC34).

### 6.1 Logging (AC10, AC20, AC31)

Allowed fields only: `event`, `namespace`, `groupRef`, `participantRef` (of the
connection ID), `method`, fixed enum names in fields called `cause` or
`outcome`, counts and booleans. **No new event uses a field named `reason`**:
`reason` is a redacted path since #5, so its value would silently disappear
(R10). New events: `group_joined` + `method`; `join_rejected { namespace, cause }`
at debug, where `cause` is one of `not_found | door_required | door_wrong |
door_budget | paused | qr_invalid | qr_expired` (no group ref for `not_found` /
`qr_invalid`, so logs aren't an oracle either); `door_code_rotated { groupRef }`;
`join_paused` / `join_resumed`; `codes_rotated { groupRef, cause }` (`cause`:
`leader | door_failures`); `join_requested`, `join_settled { outcome }`
(`outcome`: `admitted | group_full | denied | timeout | cancelled |
disconnected | group_gone`); `qr_issued`; `codes_restored { changed }`;
`join_app_budget_exhausted { namespace }` and
`door_failures_app_budget_exhausted { namespace }` (warn, once per app per
window, R1b). Never logged: codes, door codes, tickets, blobs, display names,
request IDs, raw participant IDs, IPs.

## 7. Client behavior

### 7.1 Public API (AC38-AC42)

```ts
type JoinMethod = 'A' | 'B' | 'C' | 'D';
interface JoinCodes { readonly generation: number; readonly groupCode?: string; readonly doorCode?: string; readonly alphaCode?: string }
interface CreateGroupOptions { readonly joinMethods?: readonly JoinMethod[] }
interface CreatedGroup { groupId; role: 'leader'; participantId; joinMethods: readonly JoinMethod[]; codes: JoinCodes }  // + new fields
interface JoinOptions { readonly doorCode?: string; readonly displayName?: string }
interface QrTicket { readonly ticket: string; readonly expiresAt: number }   // local epoch ms = now + expiresInMs
interface JoinRequest { readonly requestId: string; readonly displayName?: string; readonly expiresAt: number }

createGroup(metadata, initialPosition?, options?: CreateGroupOptions): Promise<CreatedGroup>;
joinByCode(code: string, options?: JoinOptions): Promise<JoinedGroup>;
joinByQr(ticket: string, options?: { displayName?: string }): Promise<JoinedGroup>;
cancelJoin(): Promise<void>;
// leader
getJoinCodes(): JoinCodes | null;            // current active leader group, else null
getJoinRequests(): readonly JoinRequest[];   // pending, deduplicated by requestId
rotateCodes(): Promise<JoinCodes>;
issueQrTicket(): Promise<QrTicket>;
approveJoin(requestId: string): Promise<'admitted' | 'group_full'>;
denyJoin(requestId: string): Promise<void>;
// removed: joinGroup(groupId)   (AC41)
```

`ConnectedInfo` gains `joinMethods` and the two new limits (from `hello.ok`).

Local checks before sending (the #3 style; nothing is sent on failure):

- `NOT_CONNECTED`; `ALREADY_IN_GROUP` (also while `awaiting_approval`);
  `REQUEST_IN_PROGRESS` (one group request at a time, as today).
- `createGroup`: `joinMethods` must be non-empty, distinct, a subset of
  `hello.ok.joinMethods`, not both A and B -> `JOIN_METHOD_UNAVAILABLE` (AC38).
- `joinByCode`: normalized as in 4.5; invalid code or door code ->
  `INVALID_JOIN_CODE { field: 'code' | 'doorCode' }`. A 6-digit code when the app
  allows neither A nor B, or an 8-character code when it doesn't allow C ->
  `JOIN_METHOD_UNAVAILABLE` (AC12, AC39). `joinByQr`: pattern and length ->
  `QR_INVALID` (local); D not allowed -> `JOIN_METHOD_UNAVAILABLE`.
- Display name -> `INVALID_DISPLAY_NAME`.
- Leader calls: `NOT_IN_GROUP` / `NOT_LEADER` from the local state; `issueQrTicket`
  without D in the group's methods -> `JOIN_METHOD_UNAVAILABLE`; request ID
  pattern -> `INVALID_PAYLOAD`.

### 7.2 Join state machine

```
null ── joinByCode / joinByQr ──> (request in flight, state unchanged)
   ├─ group.joined (reply)       -> active member; promise resolves
   ├─ join.pending (reply)       -> { status: 'awaiting_approval', requestId, expiresAt }
   │     ├─ group.joined (no reqId) -> active member; promise resolves
   │     ├─ error JOIN_DENIED / APPROVAL_TIMEOUT / GROUP_FULL / GROUP_ENDED (no reqId)
   │     │                         -> null; promise rejects with that code
   │     ├─ cancelJoin() -> join.cancelled -> null; join promise rejects JOIN_CANCELLED
   │     ├─ local guard: expiresAt + requestTimeoutMs passes -> drop (REQUEST_TIMEOUT), null
   │     └─ connection lost        -> null; promise rejects CONNECTION_LOST; no auto re-request (Q6.3)
   └─ error (reply)              -> null; promise rejects with the server code
```

- `awaiting_approval` is a new `GroupState` variant without `groupId` (the
  server doesn't reveal it before admission). `indicatorOf`: connected +
  `awaiting_approval` -> `'awaiting_approval'` (new `SyncIndicator` value);
  connecting or reconnecting -> the state is already cleared, so `none`.
- Admitted joiners store their member token exactly as `joinGroup` did (#5
  AC31). Rejoin after a drop is token-based, so an approved member never needs
  approval again.
- `cancelJoin()` racing an approval: if `group.joined` arrives first, the join
  promise resolves, the group is active, and `cancelJoin()` rejects with
  `JOIN_REQUEST_NOT_FOUND`. Documented.

### 7.3 Leader side

- `group.created`, `group.resumed`, `codes.updated`: the codes are kept in
  memory, the blob goes into the stored recovery data (`recovery.joinCodes`),
  and `codesChanged { groupId, codes, reason: 'created' | 'resumed' | 'rotated' | 'door_failures' }`
  fires (only `resumed` when `codesChanged: true`).
- `join.requested` -> added to the in-memory list (dedup by `requestId`) and
  `joinRequested` fires. `join.withdrawn` / `join.decided` remove it
  (`joinWithdrawn` fires for withdrawn). The list is cleared when the group
  ends or the client drops (the server re-sends on return).
- `join.paused` / `join.resumed` -> `joinPaused { groupId, retryAfterMs }` /
  `joinResumed { groupId }`.
- **Which blob is stored (R2, security M1, N1).** The stored recovery data
  holds the blob and its code `generation` (from the `JoinCodesPayload`). Two
  rules, applied in different places:
  1. **Direct server reply: always stored (N1).** A blob that arrives in a
     `group.created`, `group.resumed` or `codes.updated` frame on this tab's
     connection is authoritative for that group and replaces the stored one,
     whatever its generation. (A lower generation can only come back after a
     server clock step back plus a recreation without a blob; keeping the old
     blob then could later bring back codes the server had replaced.)
  2. **Merging stored copies: highest generation wins (R2).** When the
     storage layer merges a write from another tab or a stale write (a tab
     writing its in-memory document that did not just receive that blob), it
     keeps, per group, the blob with the higher generation (ties keep the
     incoming one), separately from the token merge rule (newest token `iat`
     wins). So a stale tab can never write back a pre-rotation blob.
  The write API makes the source explicit (for example
  `setJoinCodes(groupKey, blob, generation, { fromServer: true })`) so the two
  paths can't be mixed up. Tests: two tabs, rotate in one, the other's older
  blob never overwrites the newer one, in either merge order; and a direct
  `group.resumed` with a **lower** generation than the stored blob replaces it
  (N1).
- The client compares only the code generation; the ticket generation lives
  inside the signed blob and orders the same way (4.8, D12).
- Recreation sends the stored blob as `group.resume.joinCodes` (AC32); the
  automatic rejoin path does the same.
- Deleting a group's stored data (#5 AC31 rules) deletes the blob with it (AC40).

### 7.4 Errors

New client codes: `INVALID_JOIN_CODE` (`details { field }`),
`INVALID_DISPLAY_NAME`, `JOIN_METHOD_UNAVAILABLE`, `JOIN_CANCELLED`. Server codes
pass through as typed codes (AC39). Fixed-key details: `JOIN_PAUSED { retryAfterMs }`,
`APPROVAL_QUEUE_FULL { maxPending }`, `RATE_LIMITED` unchanged keys. Texts are
fixed and never include a code, ticket or name (AC42).

### 7.5 Client logging (AC42)

New events: `join_requested { method }`, `join_pending`, `join_settled { outcome }`,
`codes_changed { cause }`, `qr_issued`, `join_request_received { count }`.
Never logged: codes, door codes, tickets, blob, display names, request IDs.

## 8. Security-sensitive areas

Security-sensitive: yes

| Area | Where | Notes |
| --- | --- | --- |
| Authentication / admission (new credentials) | `joins/join-service.ts`, `group-service.ts` | Codes and tickets become the only way to get a new identity; `group.join` by ID removed (AC36, AC37). |
| Authorization (leader-only actions) | `join.approve`, `join.deny`, `qr.issue`, `codes.rotate` | Ownership-checked through the notifier (M4), per-action `NOT_LEADER` texts; approve/deny scoped to the leader's own group queue. |
| New endpoints accepting user input | 7 new client message types, changed `group.create` and `group.resume` | Bounded zod schemas, normalization, budgets before lookups (4.3). |
| Brute force and enumeration | Door codes, alphanumeric codes, group codes | Per-connection and per-app join budgets, per-app wrong-door budget (R1b), door rotation on every 5th failure with no decay (R1a) and pause, constant-time door comparison, identical `CODE_NOT_FOUND` / `QR_INVALID` responses, no logs that act as oracles (4.3, 5.3, 6.1, 8.1). |
| Crypto (new signed formats) | `tokens/signed-blob.ts`, `qr-tickets.ts`, `codes-blob.ts`, `token-keys.ts` | HKDF per app and per purpose; HMAC-SHA256; constant-time compare across all keys; charset and length before decode; strict claim schema; previous-secret acceptance; token keys unchanged (D2). |
| Secrets / config | `env.ts`, `apps-config.ts` | Env ceiling for methods, no clamping, no values echoed (AC1-AC3). |
| PII (possibly minors) | Display names; codes | Display name relayed to the leader only, never stored after settle, never logged; codes leader-only; new redaction paths (AC10, AC20). |
| DoS surfaces | Approval queue, timers, code index, door guard | All bounded and cleared on end, drop and close (section 3, AC31). |
| Client credential storage | `token-store.ts` | Codes blob stored with the leader's recovery data, validated on load, deleted with it; a direct server reply is always stored (N1), merges of stored copies keep the highest generation per group (R2). |
| Dependencies | none added | AC45. |

### 8.1 Brute-force reasoning (for the README and the security review)

Corrected in revision 1 (R1c). The first version's door-code numbers were per
group only and also wrong for the targeted case (security H1). Only per-group
and per-app limits count here: per-connection budgets reset when the attacker
reconnects (security L4), so they reduce noise but are not a security bound.

- **Door code (A), one targeted group.** The attacker knows the group code.
  Every 5th wrong door code against the current door code rotates it (R1a,
  no time decay), and the 3rd rotation within 30 minutes pauses method A for
  10 minutes. The first 15 guesses can come quickly; after the first pause the
  earlier rotations are still inside the 30-minute window, so every later
  rotation pauses again at once. Steady state: **5 guesses per 10 minutes**,
  about 720 a day, each batch against a fresh 1-in-10^6 code: about
  **7 x 10^-4 per day per group**. A group lives at most `maxSessionMinutes`
  (default 180 min), which bounds one session to about 100 guesses, about
  **10^-4 per group session**. Every rotation and pause is visible to the
  leader.
- **Door code (A), untargeted across all groups of one app.** The attacker
  enumerates live group codes (they are shown openly, and `DOOR_CODE_REQUIRED`
  vs `CODE_NOT_FOUND` is an accepted oracle, Q2.2) and spreads guesses so that
  no single group pauses. Two controls now bound this. (1) R1a: there is no
  silent sub-threshold guessing; every 5 wrong guesses against any door code
  rotate it and notify that leader. (2) R1b: at most
  `DOOR_FAILURES_PER_APP_PER_MINUTE` failed door compares per app per minute.
  Expected break-ins per app per day at a full, nonstop attack =
  budget x 1440 x 10^-6:

  | Wrong-door budget per app per minute | Expected break-ins per app per day | Door rotations shown to leaders per day |
  |---|---|---|
  | none (first version; only the 600/min join budget) | ~0.86 | 0 (silent) |
  | **60 (chosen at Gate 2, Q-E)** | **~0.086 (about 1 in 12 days)** | ~17 000 |
  | 30 (recommended before Gate 2) | ~0.043 (about 1 in 23 days) | ~8 600 |
  | 10 | ~0.014 (about 1 in 70 days) | ~2 900 |

  At 60: 60 x 1440 = 86 400 wrong door codes per app per day, x 10^-6 =
  about 0.086 expected break-ins per app per day under a full, nonstop attack.

  Such an attack is loud: thousands of `codes.updated door_failures` events
  reach leaders and the `door_failures_app_budget_exhausted` warning is
  logged every minute. A 6-digit door code is a **"same room" control** (the
  joiner can see the screen or hear the leader). Apps that need stronger
  admission should use C (8-character code) or B (leader approval), or D.
- **Alphanumeric code (C):** 31^8 = 8.5 x 10^11 codes. With the whole per-app
  budget (600/min = 864 000/day) aimed at an app with 1000 live C groups:
  864 000 x 1000 / 8.5 x 10^11 = about **1.0 x 10^-3 per day** of hitting any
  group (Q5.6, accepted, confirmed by the security review). A and C share the
  600/min join budget, and wrong door codes are additionally capped at the
  R1b value, so an attacker can't get the full rate on both. Worst combined
  case at the chosen value (60): about 0.087 per app per day.
- **Group codes (A, B):** enumerable by design (they are shown openly). For B
  this lets a guesser reach a leader with requests; bounded by 10 pending per
  group and 1 per connection; the leader denies or rotates.
- **QR tickets:** 256-bit HMAC, unforgeable without the secret; replay bounded
  by expiry (<= `qrTicketSeconds`), by the leader's `codes.rotate`, and by a
  new code set on recreation (D12). Door rotations don't revoke them, so a
  guesser can't cancel the leader's QR tickets.

### 8.2 What the block list now guarantees (AC37)

A blocked participant can't come back with its old identity on any path
(resume checks the block list, #5). The only way in with a **new** identity is
a current code or ticket. Someone who still knows the current codes can join
as a new person; the leader's mitigation is `codes.rotate` (and item 5's
remove-member can trigger it). README and client README replace the "join by
group ID until item 4" note with this.

### 8.3 Logging defenses

First line: call sites log only the allowed fields (6.1). Second line: new
`REDACT_PATHS` (`joinCode`, `doorCode`, `groupCode`, `alphaCode`, `codes`,
`joinCodes`, `blob`, `ticket`, `requestId`, plus `*.` variants; R10). `codes`
alone only covers a `JoinCodesPayload` logged whole at depth 0 or 1, so `blob`
gets its own paths. No new log field is named `reason` (6.1). Errors from the
signed blob services never carry input; verification returns a result object.
`logger.test.ts` asserts each new path, including a nested `{ x: { blob } }`.

### 8.4 Required security controls (security.md section 5) mapped to commits

Every control is part of this plan. Commit numbers refer to section 11.

| # | Control | Where in this plan | Commit |
|---|---|---|---|
| R1a | Door failures counted since the last door-code change, no 10-minute decay; every 5th rotates the door code and notifies the leader; pause rule unchanged. Test: 4 failures, 11 min, 1 failure -> rotates; 4 + 4 + ... over hours still rotate on every 5th | 3 (`DoorGuard`), 5.3, 10 (AC29) | 9 |
| R1b | `DOOR_FAILURES_PER_APP_PER_MINUTE` (60, Gate 2 Q-E): `check` before the compare, `record` only on a wrong compare, `RATE_LIMITED` with the join-attempt text and `retryAfterMs`, one namespace-only warn per window; tests with two apps and with correct door codes not using the budget; **N2**: check, compare and record in one synchronous block before any `await` (4.3) | 2.2 (`rate-limiter.ts` `check`/`record`), 4.3 step 7, 5.3 | 8 (limiter `check`/`record`, constant), 9 (wiring) |
| R1c | Corrected numbers: per-group steady state (5 per 10 min, bounded by session length) and per-app aggregate at the chosen R1b value; "same room" wording | 8.1 (done in this revision), 8.6 (spec note, README) | 21 |
| R2 | Client keeps the highest-generation codes blob per group when merging stored copies, across tabs and independent of the token merge; **N1**: a blob from a direct server reply is always stored; compares the code generation only, which also orders the ticket generation (4.8) | 2.2 (`token-store.ts`), 4.8, 7.3 | 17 |
| R3 | Generation `max(prev + 1, nowMs)` in milliseconds; the ticket generation is always a copy of a code generation taken at a ticket-revoking change (D12), so it inherits the rule, and a recreation without a usable blob sets it `>= nowMs` | D4, D12, 2.1 (`codes.ts`), 4.7 | 4 (rule, `ticketGeneration` field, `rotateDoorCode`), 13 (recreation) |
| R4 | HKDF `info` exactly `sync-system/token/v1:<ns>` (unchanged, pinned bytes), `sync-system/qr-ticket/v1:<ns>`, `sync-system/codes-blob/v1:<ns>`; keyring cache keyed by purpose and namespace (separate keyring instances per purpose); keys differ per purpose and app; ticket, blob and token never interchangeable in any direction | D2, 2.2 (`token-keys.ts`), 4.7 | 3 |
| R5 | `verifyCompact`: length cap first, exact two-segment pattern, 43-character signature, constant-time compare against every key, JSON parsed in try/catch, exact claim schema (`v === 1`, `g` matches `GROUP_ID_PATTERN`, `n`/`e` safe non-negative integers, plausibility bound on `e`), result objects, never throwing with input | 2.1 (`signed-blob.ts`), 4.7, 4.8 | 3, 12, 13 |
| R6 | Door compare: both sides validated to `^[0-9]{6}$`, then `timingSafeEqual` on two 6-byte ASCII buffers; a paused group never compares | 4.3 step 7 | 6, 9 |
| R7 | `CODE_NOT_FOUND` and `QR_INVALID` each built from one constant (fixed text, no `details`, never echo input); deep-equal tests across unknown code, other app's code, unused code type and every invalid-ticket case; `join_rejected` without group ref for `not_found` / `qr_invalid` | 4.3, 4.4, 6.1 | 6, 12 |
| R8 | Validation order of 4.3 (busy, per-connection budget, per-app budget, then normalization and lookup); refused attempts never reach `CodeIndex.lookup` (spy test); lookup outside the lock re-checked under the lock | 4.3 | 6, 8 |
| R9 | Display name: 4.5 rules plus well-formed UTF-16 and no U+061C, U+200B, U+200E, U+200F, U+FEFF; same function on server and client | 4.5 | 1 |
| R10 | Redact `blob`, `*.blob` in addition to the planned paths; no new log field named `reason` | 2.2 (`logger.ts`), 6.1, 8.3 | 18 (the redact paths themselves land with the first commit that can log the field, see note) |
| R11 | Approval settles exactly once under the group lock; approve re-checks the joiner session; request IDs from 16 CSPRNG bytes, looked up only in the acting leader's own group queue | 2.1 (`approval-queue.ts`), 4.6 | 11 |
| R12 | `qr.issue`, `codes.rotate`, `join.approve`, `join.deny` authorized by ownership (notifier, M4), not by cached role; per-action `NOT_LEADER` texts | 4.4, 4.6, 4.7 | 10, 11, 12 |
| R13 | Codes, blobs and display names sent only to the ownership-checked leader connection (never broadcast, never to members or pending joiners); pending-joiner frames carry no `groupId` (including `GROUP_ENDED`, built by `errorMessage(ErrorCode.GROUP_ENDED)` with no `details`); member-socket frame test | 4.2, 4.6, D9 | 5, 9, 11, 13 |
| R14 | `CodeIndex` claim all-or-nothing and synchronous; codes released, timers cancelled and limiters forgotten on end, drop and `close()` (ManualScheduler pending = 0) | 2.1 (`code-index.ts`), 6 | 4, 5, 9, 11 |
| R15 | `group.join` removed from schema, dispatch, `GroupActions` and client; static test that no client message type carries a raw `groupId` admission field | 4.1 | 15 |
| R16 | READMEs: corrected odds (R1c), per-connection budgets reset on reconnect (L4), pause abuse and `codes.rotate` (M3), group-code squatting limit (M2), QR tickets are bearer credentials (URL fragment, strip with `history.replaceState`, never log or persist; revoked by `codes.rotate` and a new code set, not by door rotations) (L6, Q-B), render display names as text only (L2), block-list residual (AC37) | 8.6 | 21 |
| Q-B | Separate ticket generation (D12): door rotations leave it unchanged; `codes.rotate` and a new code set on recreation set it to the new code generation; tickets checked against it only; blob carries it as `t` with `t <= n`; invariants `ticketGeneration <= generation` and monotonic; no revival after a restart without a usable blob | D12, 3, 4.3, 4.7, 4.8 | 3 (blob `t`), 4 (field, `issueCodeSet`, `rotateDoorCode`), 9 (door rotation keeps it), 10 (`codes.rotate` bumps it), 12 (ticket check), 13 (recreation) |

Note on R10: to keep "no secret in logs" true at every commit, each commit
that introduces a new sensitive field also adds its redact paths (`joinCode`
and `doorCode` in 6, `codes`, `joinCodes` and `blob` in 5, `ticket` in 12,
`requestId` in 11). Commit 18 then adds the cross-cutting privacy tests and
verifies the full list. Commit 18 owns the R10 check either way.

### 8.5 Advisories (no code change in this issue)

| # | Advisory | Handling |
|---|---|---|
| M2 | Unlimited group creation lets one client squat the 6-digit code space (pre-existing: no per-connection create rate, no per-app live-group cap). | **Follow-up issue** (the orchestrator opens it): fixed per-connection `group.create` rate and per-app live-group cap. Until then, documented in the README (R16). |
| M3 | Anyone who knows a group code can keep that group's method A paused. | PRD trade-off (Q5.1). Documented in the README next to the pause, with `codes.rotate` as the leader's way out (R16). R1b at 60/min caps it at about 120 groups per app at once (keeping one group paused costs 5 wrong codes per 10 minutes). Item 5 may add "rotate on pause" UI. |
| L4 | Per-connection join and `qr.issue` budgets reset on reconnect. | Matches #7 L-2. Odds rest only on per-group and per-app limits (8.1). Stated in the README brute-force paragraph (R16). |
| L5 | The QR ticket payload is readable (group ID and generation). | Acceptable since the group ID is no longer an admission credential (AC36). The AC36 static test stays (R15). |
| L6 | `QR_TICKET_SECONDS_CEILING` allows 24-hour multi-use tickets. | Client README: tickets are bearer credentials; keep `qrTicketSeconds` short; read the ticket from the fragment, then remove it from the URL with `history.replaceState`; never log or persist it (R16). |

### 8.6 Spec and README corrections the engineer makes (R1c, R16)

In commit 21. R1a is stricter than AC29 ("5 within 10 minutes" still
rotates), so that part of AC29 holds as written, and R1b adds an extra cap
that no AC forbids. AC43 (README documents the fixed constants and odds) now
includes `DOOR_FAILURES_PER_APP_PER_MINUTE`.

**AC wording changes from Gate 2 Q-B (user decision, D12).** Checked against
every AC: AC25 conflicts as worded ("carries an older code generation than
the group's current one is rejected" would reject a ticket after a door
rotation). AC6, AC29, AC30, AC32 and AC33 don't conflict, but their wording
ties tickets to "the generation" and is made exact. AC23, AC24, AC26 and AC40
are unaffected. Each AC keeps its intent; only the generation wording changes.
The engineer applies exactly these replacements in `docs/issues/10/spec.md`
(commit 21) and adds a line under "Gate 1 decisions" reading "Gate 2: QR
tickets have their own ticket generation (Q-B); wrong door codes per app 60
per minute (Q-E)":

- Design decision 6, last sentence: "It works for many joiners until it
  expires, and stops working when the group's codes rotate." ->
  "It works for many joiners until it expires, and stops working when the
  leader rotates the codes or the server issues the group a new code set. An
  automatic door-code rotation after wrong door codes does not invalidate it."
  Also in its first sentence: "(app, group, expiry, code generation)" ->
  "(app, group, expiry, ticket generation)".
- AC25: "or carries an older code generation than the group's current one is
  rejected." -> "or carries a ticket generation other than the group's current
  ticket generation is rejected. The ticket generation changes on leader
  rotation (AC30) and on a new code set at recreation (AC33), never on an
  automatic door-code rotation (AC29)."
- AC29, second sentence: "with the new door code, a new generation and a new
  signed blob." -> "with the new door code, a new code generation and a new
  signed blob. The ticket generation does not change, so the leader's QR
  tickets keep working (AC25)."
- AC30: "the generation increases (so older QR tickets stop working)" ->
  "the code generation and the ticket generation increase (so older QR tickets
  stop working)".
- AC32: "covering the app, group ID, generation and codes" -> "covering the
  app, group ID, code generation, ticket generation and codes".
- AC33: "the group gets the same codes and generation." -> "the group gets the
  same codes, code generation and ticket generation." and "issues a full new
  set with a higher generation." -> "issues a full new set with a higher code
  generation and a new ticket generation, so QR tickets issued before stop
  working."
- AC6 needs no change ("a counter that increases on every rotation" is the
  code generation, which still increases on every rotation).

**Other spec corrections (R1c, Q-E):**

- `docs/issues/10/spec.md`, "Defaults" table: the row "Door-code failures
  before rotation" becomes "5 since the last door-code change, per group (no
  time window; stricter than AC29)"; add a row "Wrong door codes per app |
  60 per minute | Fixed | Checked before the compare, counted only
  on a wrong door code".
- `docs/issues/10/spec.md`, paragraph under the table: replace "about 15
  door-code tries per 40 minutes, roughly 540 a day ... about 5 x 10^-4 per
  day" with the 8.1 numbers: targeted steady state 5 per 10 minutes (about
  7 x 10^-4 per day per group, about 10^-4 per 180-minute session), the
  per-app aggregate at the chosen value (about 0.086 expected break-ins per
  app per day at 60 under a nonstop attack, about 1 in 12 days), and the
  "same room" sentence. Add a line "Corrected after the security plan
  review (docs/issues/10/security.md, H1) and Gate 2 (Q-E)".
- `README.md` brute-force section: the same numbers and table as 8.1, the
  "same room" sentence with C, B or D as stronger options, per-connection
  budgets reset on reconnect (L4), pause abuse and `codes.rotate` (M3),
  group-code squatting until the follow-up issue lands (M2), the new constant
  in the fixed-limits table.
- `packages/client/README.md`: QR tickets are bearer credentials, deep link in
  the fragment, strip it with `history.replaceState`, never log or persist it,
  keep `qrTicketSeconds` short (L6); tickets are revoked by `rotateCodes()` and
  by a new code set on recreation, not by door rotations, so re-issue after
  `codesChanged` with reason `rotated` or `resumed` (a `door_failures` change
  needs no new ticket; re-issuing anyway is harmless) (Q-B, D7); render display
  names as text only, never as HTML (L2); block-list residual (AC37).

## 9. Risks and edge cases

- **Two generations (D12, Gate 2 Q-B).** Door rotations no longer revoke QR
  tickets, so a guesser can't cancel them. Risks of the extra counter: (1) a
  code path that changes codes but forgets to decide about `ticketGeneration`.
  Mitigation: `GroupCodes` is built only by `issueCodeSet` (sets both) and
  `rotateDoorCode` (copies `ticketGeneration`); no other code assigns
  `generation`; unit tests assert the invariants after every operation.
  (2) A ticket stays valid across a door rotation for its remaining lifetime
  (<= `qrTicketSeconds`). Accepted: a ticket is a 256-bit bearer credential
  unrelated to the guessed door code, and the leader can still revoke it with
  `codes.rotate`. (3) Leader return: `codesChanged` is based on the code
  generation, so it is true after an offline door rotation even though tickets
  still work; re-issuing is harmless.
- **Wrong-door budget as a lever (R1b).** One client can use up an app's 60
  wrong door codes per minute and make every method A attempt with a door code
  in that app get `RATE_LIMITED` for the rest of the minute. This is not a new
  class of DoS (one client can already use up the 600/min join budget, accepted
  at Gate 1, Q5.2), but it is cheaper. Correct door codes are not counted, so
  real joiners only feel it while an attack is running. C, B and D joins are
  unaffected. The warn log makes it visible.
- **Group code races.** The index lookup is outside the group lock; the flow
  re-checks the mapping under the lock, so a code that rotated or was freed in
  between gets `CODE_NOT_FOUND`, never a join to the wrong group.
- **Approval spam.** 10 pending per group can be filled by 10 connections
  holding a B group code, blocking real joiners (`APPROVAL_QUEUE_FULL`) until
  the leader denies or rotates or the requests time out. Accepted at Gate 1
  (Q5.4). Rotation does not clear pending requests (the leader decides each).
- **Per-app budget exhaustion.** One attacker can spend an app's 600 joins per
  minute and slow real joins for that app (accepted at Gate 1, Q5.2). The
  warning log makes it visible.
- **Older blob replay** (4.8, security M1): closed for the leader's own
  clients by R2 (highest generation wins). Residual only for someone holding
  both the leader token and a copied older blob.
- **Generation and clock.** D4 uses server time in milliseconds (R3), so a
  quick restart can't reuse a generation. A server clock stepping far back
  after a restart without a blob could still give a lower generation (and so a
  lower ticket generation) than an outstanding ticket; a ticket matches only
  on equality, and tickets expire within `qrTicketSeconds` (<= 1 h by default
  ceiling), so the window is bounded. NTP assumed (as #5). The client stores a
  lower-generation blob from a direct server reply anyway (N1, 7.3).
- **Group-code squatting** (security M2, pre-existing): unlimited group
  creation can fill an app's 6-digit code space. Follow-up issue; README note.
- **Method A pause griefing** (security M3): accepted trade-off (Q5.1); README
  note; the leader's way out is `codes.rotate`.
- **Codes out of memory are not reserved** (Q4.2). After a drop, another group
  can take the code, and the recreating leader gets new codes. People already
  told the old codes must be told again.
- **Pending requests while the leader is offline** wait until their deadline
  (Q6.2); the leader sees them on return with the remaining time.
- **Multi-tab leaders.** The token follows the #5/#7 storage merge rules
  (newest token `iat` wins), but the blob has its own rule (R2): when stored
  copies merge, the higher generation wins per group, so a stale tab can't
  store an older blob; a direct server reply is always stored (N1).
- **Test churn** (AC44): 18 server and about 20 client test files change from
  `group.join` / `joinGroup` to codes. Tests that join more than 10 times on one
  connection within a minute must advance the scheduler or use new
  connections; tests with more than 600 joins per minute per app don't exist
  today.
- **Breaking change**: removing `group.join` and `joinGroup` is breaking for any
  outside caller. Nothing is released (Q2.1), so the protocol stays v1; the
  commit carries a `BREAKING CHANGE` footer and item 9's changelog records it.

## 10. Test plan (every AC)

Conventions as in #5 and #7: pure unit tests; server integration tests on
`startTestServer` (port 0) with a `ManualScheduler` (or `TestClock` for
limiters); client unit tests with the fake socket and fake timers; client
integration against the real in-process server. The unhandled-rejection guard
stays in every suite.

| AC | How verified | Where |
| --- | --- | --- |
| AC1 | Unset -> `A,B,C,D`; `""`, `A,,B`, `E`, `a`, `A,A` -> `ConfigError` naming `JOIN_METHODS_ALLOWED`, value not echoed; ` A , D ` accepted. | `env.test.ts` |
| AC2 | Omitted -> `["A","D"]` ∩ env; env `B,C` with omitted field -> error naming the namespace; listed `C` with env `A,D` -> error naming namespace, field and method; duplicates, empty array, `"E"` -> errors; canonical order. | `apps-config.test.ts` |
| AC3 | Defaults 300 / 120; below minimum, above ceiling -> errors as #1 AC5; ceilings validated (`< 30`, `> 86400`, `< 15`, `> 3600`). | `apps-config.test.ts`, `env.test.ts` |
| AC4 | `hello.ok` has `joinMethods`, `limits.qrTicketSeconds`, `limits.approvalTimeoutSeconds`; client parses them into `ConnectedInfo`; out-of-bounds values -> `SERVER_UNSUPPORTED`. | `handshake.int.test.ts`, `client.handshake.test.ts` |
| AC5 | Create with `[]`, `["A","A"]`, `["A","B"]`, a method outside the app set -> `JOIN_METHOD_NOT_ALLOWED` and the store stays empty; omitted -> app methods minus B when A is present. | `join-methods.test.ts`, `join-code.int.test.ts` |
| AC6 | `group.created` codes match the methods (A: group + door, B: group, C: alpha, D: none); generation present; blob verifies and covers the codes. | `join-code.int.test.ts`, `codes-blob.test.ts` |
| AC7 | 10 000 draws: all `^[0-9]{6}$`, leading zeros occur, chi-square-style bucket check (loose bound), door != group (stubbed `randomInt` forcing an equal draw redraws). | `codes.test.ts` |
| AC8 | Alphabet constant equals the 31 characters, excludes 0/O/1/I/L; 8-character draws use only it; lowercase input accepted. | `codes.test.ts`, `join.test.ts`, `join-code.int.test.ts` |
| AC9 | `CodeIndex` collision: stubbed generator returning a taken code then a free one; 20 taken draws -> `CODES_EXHAUSTED`, nothing registered; same code in app A and app B at once. | `code-index.test.ts`, `codes.test.ts`, `join-code.int.test.ts` |
| AC10 | Log capture at `trace` over create, every join outcome, rotation (both reasons), QR issue and join, approval, recreation: no code, door code, ticket, blob or display-name sentinel in logs or in any `error` frame; members never receive codes (frame log of a member socket). | `join-privacy.int.test.ts` |
| AC11 | End (each reason) and drop -> the old code returns `CODE_NOT_FOUND`; a new group can be issued that code (stubbed generator). | `join-code.int.test.ts` |
| AC12 | `" 123-456 "` and `"abcd-efgh"` normalize; `12345`, `1234567`, `ABCDEFG0`, 33-char input -> `INVALID_MESSAGE` (schema or format); client sends nothing and rejects `INVALID_JOIN_CODE`. | `join.test.ts`, `join-code.int.test.ts`, `client.join.test.ts` |
| AC13 | Unknown code, other app's live code, 6-digit code against a C-only app: responses deep-equal except `reqId`. | `join-code.int.test.ts` |
| AC14 | Correct A codes -> `group.joined` with metadata, position or `hasPosition: false`, token whose claims verify; group full -> `GROUP_FULL`. | `join-code.int.test.ts` |
| AC15 | No door code -> `DOOR_CODE_REQUIRED` and no failure counted (6 of them don't rotate); wrong -> `DOOR_CODE_WRONG` and counted; compare uses `timingSafeEqual` (spy). | `join-code.int.test.ts`, `door-guard.test.ts` |
| AC16 | C code -> admitted directly. | `join-code.int.test.ts` |
| AC17 | Leader socket closed (frozen) -> A, C, D joins admitted with `leaderOnline: false`; B request waits (no leader to notify). | `join-code.int.test.ts`, `join-approval.int.test.ts`, `join-qr.int.test.ts` |
| AC18 | Member, parked and pending sessions get `ALREADY_IN_GROUP` on every join request and spend no budget. | `join-code.int.test.ts`, `join-approval.int.test.ts` |
| AC19 | B code -> joiner `join.pending { requestId, timeoutMs }`, leader `join.requested` with the same `requestId` and the display name. | `join-approval.int.test.ts` |
| AC20 | Names `""`, `"   "`, 33 code points, control char, U+202E -> `INVALID_MESSAGE`; 32 emoji accepted; name absent from logs and from every frame except `join.requested`; not re-sent after settle. | `join.test.ts`, `join-approval.int.test.ts`, `join-privacy.int.test.ts` |
| AC21 | Approve -> joiner `group.joined` + token, leader `join.decided admitted`; approve when full -> `GROUP_FULL` / `group_full`; deny -> `JOIN_DENIED`; ManualScheduler past `approvalTimeoutSeconds` -> `APPROVAL_TIMEOUT` + `join.withdrawn timeout`; cancel and disconnect -> `join.withdrawn`; leader offline then back -> request re-sent with remaining `expiresInMs`; member approves -> `NOT_LEADER` with its text; other group's request ID -> `JOIN_REQUEST_NOT_FOUND`. | `join-approval.int.test.ts` |
| AC22 | 11th pending -> `APPROVAL_QUEUE_FULL { maxPending: 10 }`; second request on the same socket -> `ALREADY_IN_GROUP`; group ended and group dropped -> every pending joiner gets `GROUP_ENDED`, none admitted. | `join-approval.int.test.ts`, `approval-queue.test.ts` |
| AC23 | `qr.issue` reply: ticket <= 256, `^[A-Za-z0-9_.-]+$`, `expiresInMs === qrTicketSeconds*1000`; max-length namespace and generation still <= 256; member -> `NOT_LEADER`; group without D -> `JOIN_METHOD_NOT_ALLOWED`; 7th per minute -> `RATE_LIMITED` with its text. | `join-qr.int.test.ts`, `qr-tickets.test.ts` |
| AC24 | Valid ticket -> admitted; 3 joiners on one ticket; B + D group -> approval. | `join-qr.int.test.ts` |
| AC25 | Expired (ManualScheduler), bad signature, malformed, 257 chars, other app, group dropped, older ticket generation (after `codes.rotate`, and after a recreation that issued a new code set) -> `QR_INVALID`, except expired-but-valid -> `QR_EXPIRED`; invalid responses deep-equal; ticket never echoed. **Q-B:** a ticket issued before a door rotation (5 wrong door codes) still admits a joiner after it, and after 3 door rotations and a pause (D join works during the pause). | `join-qr.int.test.ts`, `qr-tickets.test.ts` |
| AC26 | HKDF keys differ per purpose and namespace; token keys byte-equal to a pinned value; ticket signed with previous secret accepted until expiry; ticket given as a token -> `TOKEN_INVALID`; token given as a ticket -> `QR_INVALID`; blob given as a ticket and vice versa -> invalid. | `token-keys.test.ts`, `qr-tickets.test.ts`, `codes-blob.test.ts`, `join-qr.int.test.ts` |
| AC27 | 10 attempts OK (mix of outcomes, including `DOOR_CODE_REQUIRED`), 11th -> `RATE_LIMITED { retryAfterMs }` "Too many join attempts" before lookup (`CodeIndex.lookup` spy not called), socket open; window advance -> OK. | `join-bruteforce.int.test.ts` |
| AC28 | 61 app-a connections x 10 -> 601st `RATE_LIMITED`; app-b unaffected; no lookup for refused attempts. | `join-bruteforce.int.test.ts` |
| AC29 + R1a | 5 wrong door codes in 10 min -> leader `codes.updated door_failures` with a new door code, same group code, higher code generation, new blob whose `t` equals the previous ticket generation (Q-B); old door code now wrong; an earlier QR ticket still works. **R1a:** 4 failures + 11 min + 1 failure -> rotates (no decay); 4 failures, then hours later 1 more -> rotates; the counter resets on door rotation, `codes.rotate` and recreation. 3 rotations in 30 min -> `JOIN_PAUSED { retryAfterMs }` for A attempts (correct door code included, no compare), leader `join.paused`; C and D still work; after 10 min `join.resumed` and joins work; the next rotation inside the 30-min window pauses again at once. | `join-bruteforce.int.test.ts`, `door-guard.test.ts` |
| R1b | Limiter unit: `check` records nothing, `record` adds one, `retryAfterMs` correct. Integration (two apps, many A groups, new connections to dodge per-connection limits): the 61st wrong door code in a minute across different groups -> `RATE_LIMITED` "Too many join attempts" with `retryAfterMs`, the compare is not run (spy on `timingSafeEqual`) and no group's failure counter moves; app-b unaffected; correct door codes, `DOOR_CODE_REQUIRED` and paused attempts never use the budget (61 correct joins pass); window advance -> allowed again; one `door_failures_app_budget_exhausted` warn per window, namespace only. **N2:** the 5th failure's rotation `setCodes` held pending by a deferred store; attempts on other groups of the app meanwhile see the recorded event (61st refused). | `rate-limiter.test.ts`, `join-bruteforce.int.test.ts`, `join-privacy.int.test.ts` |
| R2 + N1 | Two storage instances on one fake storage: rotate in tab 1 (higher generation), tab 2 writes its older blob -> stored blob stays the newer one; merge in both orders keeps the higher generation; a stored blob without a valid generation is dropped on load. N1: a direct `group.resumed` (and `codes.updated`) carrying a lower generation than the stored blob replaces it. |
| Q-B (D12) | Unit: `issueCodeSet` sets `ticketGeneration === generation`; `rotateDoorCode` raises `generation` and keeps `ticketGeneration`; after any sequence of operations `ticketGeneration <= generation` and neither decreases. Blob: `t` missing, negative, non-integer, or `t > n` -> invalid. Integration: door rotation keeps tickets valid; `codes.rotate` revokes; recreation with a valid blob keeps `t` (earlier ticket valid); recreation without a blob, with a tampered blob and with a taken code revokes (earlier ticket `QR_INVALID`), including after 50 rapid rotations within one `TestClock` millisecond (R3). | `codes.test.ts`, `codes-blob.test.ts`, `join-qr.int.test.ts`, `join-recovery.int.test.ts` | `token-store.test.ts`, `client.leader-codes.test.ts` |
| R3 | `nextGeneration`: millisecond floor; 50 rotations within one millisecond of `TestClock` stay strictly increasing; recreation without a blob after rapid rotations gives a generation above every earlier one, so an older ticket stays `QR_INVALID`; maximal ticket still <= 256. | `codes.test.ts`, `join-qr.int.test.ts`, `qr-tickets.test.ts` |
| R9 | Names with a lone high or low surrogate, U+061C, U+200B, U+200E, U+200F, U+FEFF -> invalid on server (`INVALID_MESSAGE`) and client (`INVALID_DISPLAY_NAME`); ZWJ family emoji, flag and tag-sequence emoji accepted. | `join.test.ts`, `join-approval.int.test.ts`, `client.join.test.ts` |
| R10 | Logger test: `blob`, `*.blob` and every new path redacted (nested object case); a static check that no new log call passes a `reason` field (grep-style test over `src/joins/**`). | `logger.test.ts`, `join-privacy.int.test.ts` |
| R11 | Races with `ManualScheduler`: approve vs joiner disconnect (both orders), approve vs `join.cancel`, approve vs deadline timer, deny vs timeout, approve vs group end: exactly one outcome to the joiner and one to the leader, no participant added for a closed socket, second actor gets `JOIN_REQUEST_NOT_FOUND`, timers pending 0. | `approval-queue.test.ts`, `join-approval.int.test.ts` |
| AC30 | `codes.rotate`: every code replaced, code and ticket generation up (equal to each other), old QR ticket `QR_INVALID`, failures reset, pause lifted (`join.resumed`); 7th per minute -> `RATE_LIMITED`; member -> `NOT_LEADER`. | `join-bruteforce.int.test.ts` |
| AC31 | After group end and after `server.close()`: ManualScheduler pending 0, `CodeIndex.size` 0, queues and limiters empty; log capture shows no codes, names, IPs or raw pids. | `join-bruteforce.int.test.ts`, `join-privacy.int.test.ts` |
| AC32 | Every `JoinCodesPayload` (create, rotate, door rotation, resume) carries a blob that verifies with the codes key only; client stores it in recovery and sends it in `group.resume`. | `codes-blob.test.ts`, `join-recovery.int.test.ts`, `client.leader-codes.test.ts` |
| AC33 | Recreate with valid blob -> same codes, generation and ticket generation, `codesChanged: false`; missing, tampered, other group, other app, methods no longer allowed, one code taken -> full new set, higher generation, `codesChanged: true`; client-invented blob rejected. | `join-recovery.int.test.ts` |
| AC34 | Leader return -> current codes and blob; pending re-sent; `codesChanged` true after an offline door rotation, false otherwise. | `join-recovery.int.test.ts` |
| AC35 | In-process: A + D group, member joins by code, new server instance with the same secret, leader resumes -> same codes, new joiner gets in, old member resumes with its token. Second test: another group takes the group code first -> leader gets new codes. Child-process variant extends `restart-process.int.test.ts`. Client variant in `integration/restart.int.test.ts`. | `join-recovery.int.test.ts`, `restart-process.int.test.ts`, `integration/restart.int.test.ts` |
| AC36 | `group.join` -> `INVALID_MESSAGE`; schema test; no `GroupActions.join`; static test: no client message type in the schema carries `groupId` as a field. | `join-removed.int.test.ts`, `schemas.test.ts` |
| AC37 | Blocked member resumes -> `PARTICIPANT_BLOCKED`; forged `group.join` -> invalid; new identity only by current code; after `codes.rotate` the old codes fail. README texts reviewed. | `join-removed.int.test.ts`, review |
| AC38 | `createGroup` with `joinMethods` sends them and resolves codes, generation, methods; invalid sets rejected locally with nothing sent. | `client.join.test.ts`, `client.groups.test.ts` |
| AC39 | Each server code rejects with its typed code; `awaiting_approval` state and `indicatorOf` row; `cancelJoin` flow and race; local guard timeout; drop while pending -> `CONNECTION_LOST`, no re-request. | `client.join.test.ts`, `state.test.ts`, `integration/join.int.test.ts` |
| AC40 | `getJoinCodes`, `rotateCodes`, `issueQrTicket` (`expiresAt` from local clock), `approveJoin`, `denyJoin`, events with reasons, dedup of re-sent requests; blob stored, deleted with the token. | `client.leader-codes.test.ts`, `token-store.test.ts` |
| AC41 | `joinGroup` absent from the class and exports (type test with `@ts-expect-error`); README has no `joinGroup`; token rejoin tests unchanged. | `client.groups.test.ts`, `readme.test.ts`, `client.rejoin.test.ts` |
| AC42 | Recording logger plus every error's `message`, `details`, `serverMessage` across all new flows: no code, ticket, blob or name sentinel. | `logging.test.ts`, `client.join.test.ts` |
| AC43 | READMEs and the spec "Defaults" note reviewed against sections 4-5, 8.1 and the 8.6 list (R1c, R16); `readme.test.ts` asserts the join-flow, leader-API and QR deep-link headings and the fragment advice; example configs parse. | review, `readme.test.ts`, `apps-config.test.ts` |
| AC44 | Migrated tests pass; every other existing test unchanged. | CI |
| AC45 | `pnpm lint`, `typecheck`, `test`, `build`, `pnpm audit --audit-level=high`; lockfile unchanged except workspace edits; no Node-only runtime import in the client (existing no-DOM/no-Node typecheck); `ssr-import` test still passes with the new protocol module. | CI |

## 11. Implementation chunks (planned commits)

Every commit keeps `pnpm lint/typecheck/test/build` green, carries its tests,
and ends with the `Refs: #10` trailer. When a protocol change alters a server
frame the client parses, the same commit updates the client's types and
fake-socket fixtures (type-level only; client behavior lands in 14-17).

Revision 1 keeps the same 21 commits in the same order; the security controls
(section 8.4) are folded into them, shown in brackets as `[Rx]`. Two subjects
change (8 and 17) to say what they now do.

Revision 2 (Gate 2) keeps the same 21 commits in the same order. The Q-B
ticket generation (D12) is folded in as `[Q-B]`, N1 and N2 as `[N1]` / `[N2]`.
Two subjects change to say what they now do: 4 (draws codes **and** keeps the
two generations) and 12 (tickets bound to the ticket generation).

1. `feat(protocol): add join methods, code normalization and display name rules`
   (join.ts, limits, exports; AC8, AC12, AC20 shared rules; [R9] well-formed UTF-16 and invisible-character rejection)
2. `feat(config): add join methods and join timers to env and apps config`
   (env.ts, apps-config.ts, AppConfig, `hello.ok` fields, client limit bounds and `ConnectedInfo`, example and dev configs, compose; AC1-AC4)
3. `feat(server): add signed qr tickets and codes blobs with separate keys`
   (token-keys purpose prefix, signed-blob.ts, qr-tickets.ts, codes-blob.ts; AC26 unit, AC32 format; [R4] HKDF labels and per-purpose keyrings with pinned token key bytes, [R5] `verifyCompact` rules; [Q-B] blob claim `t` with `t <= n`)
4. `feat(server): draw and index join codes with code and ticket generations`
   (codes.ts, code-index.ts, join-methods.ts; AC7-AC9 unit; [R3] millisecond generation, [R14] all-or-nothing synchronous claim; [Q-B] `GroupCodes.ticketGeneration`, `issueCodeSet` sets it to the new generation, `rotateDoorCode` keeps it, invariant tests)
5. `feat(server): issue join codes when a group is created`
   (protocol `group.create.joinMethods`, `group.created.codes`; GroupRecord fields, `setCodes`; release on end and drop; client fixtures; redact paths `codes`, `joinCodes`, `blob`; AC5, AC6, AC9, AC11; [R13] codes to the leader only, [R14] release on end and drop)
6. `feat(server): join groups by group code and door code or alphanumeric code`
   (JoinService skeleton, `group.joinByCode` for A and C, new error codes and texts, redact paths `joinCode`, `doorCode`; AC12-AC18; [R6] validated 6-byte constant-time compare, [R7] one constant per `CODE_NOT_FOUND`, [R8] lookup re-checked under the lock)
7. `test(server): join through codes in server test helpers`
   (helpers and the 18 server test files off `group.join`; AC44)
8. `feat(server): limit join attempts and wrong door codes per app`
   (join limiters per connection and per app, action texts, budget warning; `SlidingWindowRateLimiter.check` / `record`; `DOOR_FAILURES_PER_APP_PER_MINUTE` constant; AC27, AC28; [R8] budgets before lookup, [R1b] limiter infrastructure)
9. `feat(server): rotate door codes and pause method a after failures`
   (DoorGuard with failures counted since the last door-code change, app wrong-door budget (60/min) checked before the compare and recorded only on a wrong compare, `codes.updated door_failures`, `join.paused` / `join.resumed`, `door_failures_app_budget_exhausted` warn; AC29; [R1a], [R1b], [N2] check, compare and record in one synchronous block before any `await`, [R6] paused groups never compare, [R13], [R14] door timers cleared; [Q-B] door rotation via `rotateDoorCode`, ticket generation unchanged)
10. `feat(server): let the leader rotate join codes`
    (`codes.rotate`; AC30; [R12] ownership-checked; resets the R1a counter; [Q-B] full new set, so the ticket generation moves to the new generation)
11. `feat(server): add leader approval for method b joins`
    (ApprovalQueue, `join.*` messages, timers, redact path `requestId`; AC19-AC22; [R11] exactly-once settlement under the group lock, [R12], [R13] `GROUP_ENDED` without `groupId` or `details`, [R14])
12. `feat(server): issue and accept qr tickets bound to a ticket generation`
    (`qr.issue`, `group.joinByQr`, redact path `ticket`; AC23-AC26; [R5], [R7] one constant for `QR_INVALID`, [R12]; [Q-B] ticket `n` = `ticketGeneration`, checked against it only; tickets survive door rotations, `codes.rotate` revokes)
13. `feat(server): keep join codes across group recreation and leader return`
    (`group.resume.joinCodes`, `codesChanged`, re-sent requests and pause; AC32-AC34, AC35 in-process; [R5] blob verification, [R13]; [Q-B] valid blob keeps `t`, a new set on recreation revokes tickets, no revival after restart without a usable blob)
14. `feat(client): join groups by code and qr ticket`
    (`joinByCode`, `joinByQr`, `cancelJoin`, `awaiting_approval`, indicator, error codes; client tests moved off `joinGroup`; AC12, AC39; [R9] on the client)
15. `feat(protocol)!: remove join by group id`
    (schema, server dispatch, `GroupActions.join`, client `joinGroup`, remaining references; AC36, AC41; `BREAKING CHANGE:` footer; [R15])
16. `feat(client): add leader api for join codes, qr tickets and approvals`
    (getJoinCodes, rotateCodes, issueQrTicket, approve/deny, events, request list; AC38, AC40)
17. `feat(client): keep the newest codes blob and send it when recreating a group`
    (token-store `recovery.joinCodes` and `joinCodesGeneration`, highest generation wins when merging stored copies across tabs, resume and auto-rejoin; AC32, AC40; [R2]; [N1] a blob from a direct server reply is always stored, test with a lower-generation reply)
18. `test(server): verify join codes, tickets and names never reach logs`
    (full redact-path list incl. `blob`, no `reason` log field, privacy and cleanup tests; AC10, AC20, AC31; [R10], [R14] cleanup)
19. `test(server): keep join codes across a server process restart`
    (child-process restart; AC35)
20. `test(client): cover join flows against the real server`
    (integration join, approval, QR, restart; recording-logger checks; AC35, AC39, AC42)
21. `docs: document join methods, brute-force limits and the leader api`
    (both READMEs and the spec "Defaults" note per section 8.6, block-list note, QR deep-link advice; AC37, AC43; [R1c], [R16]; M2, M3, L4, L6 notes; [Q-B] spec AC25/AC29/AC30/AC32/AC33 and decision 6 wording exactly as in 8.6; [Q-E] 60/min and ~0.086/day)

## 12. Gate 2 decisions (user, plan approved)

The user approved this plan at Gate 2 with the decisions below. They are
binding for the engineer. The original options and the security view are kept
in short form for the record.

- **Q-A (AC38). `createGroup` signature: as proposed.** Keep
  `createGroup(metadata, initialPosition?, options?)` with
  `options.joinMethods` (D10). No breaking change; AC38's
  `createGroup(metadata, options?)` wording is read as this signature.
  *Security:* no impact.
- **Q-B (AC25, AC29, AC30). QR tickets and door rotations: CHANGED from the
  recommendation.** The user doesn't want anyone who knows the group code to
  be able to cancel the leader's QR tickets with 5 wrong door codes. Decision:
  a separate **ticket generation** (D12).
  - Bumped only by ticket-revoking leader/server actions: create, leader
    `codes.rotate`, and a new full code set issued on recreation (missing,
    invalid or foreign blob, methods no longer allowed, or a code taken).
    Item 5's remove-member rotation will go through `codes.rotate` and so
    revokes too.
  - Not bumped by the automatic door-code rotation after wrong door codes,
    which still bumps the code generation (AC29) and still notifies the
    leader.
  - Value rule (R3 kept): on a ticket-revoking change the server computes the
    new code generation `max(previous + 1, nowMs)` in milliseconds and sets
    `ticketGeneration` to that same value. So it is never below its previous
    value or below `nowMs` at that time, and a restart or recreation without a
    usable blob sets it above every earlier ticket generation: old tickets
    can't come back (4.7).
  - Invariants: `ticketGeneration <= generation`; neither ever decreases; the
    ticket generation only moves together with the code generation.
  - Blob: carries `t` (ticket generation) next to `n`; `t <= n` required.
    Recreation with a valid, usable blob keeps both (tickets issued before
    the restart keep working, as before).
  - R2 stays consistent without a second rule: the client compares the code
    generation only, and by the invariants the blob with the highest code
    generation also has the highest ticket generation (4.8). N1 folded in:
    blobs from a direct server reply are always stored; the highest-
    generation rule applies only when merging stored copies (7.3).
  - Spec impact: AC25 conflicts as worded and is reworded; AC29, AC30, AC32,
    AC33 and design decision 6 get exact generation wording; AC6, AC23,
    AC24, AC26, AC40 unchanged. Exact replacements in 8.6 (commit 21). Intent
    of every AC kept.
  - *Security (round 2 view, before the decision):* preferred one generation
    for simplicity. The plan answers that concern by deriving the ticket
    generation from the code generation (one rule, one ordering) and testing
    the invariants. Security to re-check D12, 4.7, 4.8, 7.3 and 8.6.
- **Q-C (AC22). Pending joiners when the group ends or leaves memory: as
  proposed.** Unsolicited `GROUP_ENDED` for both, with no `groupId` and no
  `details` (D9, R13, commit 11).
- **Q-D (Q3.1). QR refresh: as proposed.** App-driven `issueQrTicket()` plus
  the README recipe; no client timer (D7). The recipe re-issues at about 80 %
  of `expiresInMs` and after `codesChanged` with reason `rotated` or
  `resumed`.
- **Q-E (R1b). `DOOR_FAILURES_PER_APP_PER_MINUTE = 60`** (not the recommended
  30). About 0.086 expected break-ins per app per day under a nonstop
  untargeted attack (about 1 in 12 days); every 5 wrong guesses still rotate
  a door code and notify that leader (8.1). README and spec corrections in
  8.6 use 60.
- **Security notes folded in:** N1 (7.3, commit 17), N2 (4.3 step 7, commit
  9), N3 accepted (no change).
- Informational items (accepted with the plan, no objection):
  - Time-based generation floor in milliseconds (D4, R3).
  - Door failures counted since the last door-code change (R1a), stricter
    than AC29; spec "Defaults" note and README numbers corrected in commit 21.
  - Advisories without code here: M2 group-code squatting (follow-up issue to
    open), M3 pause griefing (README), L4, L5, L6 (8.5).
  - Wire field names `joinCode` / `doorCode` / `joinCodes` for redaction (D5).
  - Display names also reject bidi overrides and isolates, lone surrogates
    and invisible format characters (4.5, R9).
  - Relative `...Ms` fields instead of absolute deadlines (D6).
  - New client indicator value `awaiting_approval`.
  - The dev apps config allows all four methods; the example config shows
    `["A","D"]` and `["C","D"]`.

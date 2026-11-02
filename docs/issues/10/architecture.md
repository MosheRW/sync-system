# Architecture: #10 Join methods A-D (door code, approval, alphanumeric, QR)

Issue: https://github.com/MosheRW/sync-system/issues/10
Spec: [`spec.md`](./spec.md) (45 ACs; Gate 1 accepted every recommended default Q1.1-Q6.3)
Path: full | Branch: `feat/10-join-methods` | Designer: skipped (no UI, Q1.4)
Builds on: #1, #3, #5, #7 (`docs/issues/{1,3,5,7}/*`). Every hardening control
from those issues stays in place; nothing here removes or weakens one. "Item N"
means PRD item N of 9. GitHub #9 (client clock skew) is out of scope, but the
new wire fields avoid absolute client-side deadlines for the same reason
(relative `...Ms` fields, section 4).

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
                      ├─ DoorGuard       door-failure windows, rotation count, method A pause timer
                      ├─ ApprovalQueue   method B pending requests (<= 10 per group), deadline timers
                      ├─ QrTicketService sign / verify QR tickets   (HKDF label "qr-ticket")
                      ├─ CodesBlobService sign / verify codes blobs (HKDF label "codes-blob")
                      └─ 4 SlidingWindowRateLimiters (join per conn, join per app, qr.issue per conn, rotate per group)
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
| D3 | QR ticket payload is minimal: `{"v":1,"g":<gid>,"n":<generation>,"e":<exp seconds>}`. No namespace (the per-app key binds it), no server URL (Q3.3). | Keeps the worst-case ticket at about 170 characters, well under 256 (AC23). |
| D4 | Code generation rule: every new code set gets `generation = max(previous + 1, floor(now / 1000))`. A recreation with a valid blob keeps the blob's generation. | "Increases on every rotation" (AC6) holds. A full new set issued after a restart **without** a valid blob still gets a generation above every earlier one, so a ticket issued before the restart can't come back to life (AC25, AC33). Rotations are rate-limited, so the counter never runs far ahead of the clock. |
| D5 | Wire field names are `joinCode`, `doorCode`, `displayName`, `ticket`, `joinCodes` (blob), never bare `code`. | Pino redaction is a second line of defense and can't redact `code`, which logs already use for error codes. Distinct names are redactable (section 8.3). |
| D6 | Relative times on the wire: `join.pending.timeoutMs`, `join.requested.expiresInMs`, `qr.ticket.expiresInMs`, `retryAfterMs`. The client derives local deadlines. | Server and client clocks differ (the subject of #9). A relative value is correct on any client clock. |
| D7 | QR refresh is **app-driven**: the client exposes `issueQrTicket()` and does not refresh on a timer (Q3.1, architect's choice). The README gives the recipe: re-issue at about 80 % of `expiresInMs` while the QR is on screen, and right after `codesChanged`. | Only the app knows when the QR is visible. A background timer would spend the 6/min `qr.issue` budget while nothing is shown. Item 6 can wrap the recipe in a hook. |
| D8 | `joinByCode` / `joinByQr` promises resolve when the joiner is **admitted** (method B included) and reject with a typed error otherwise. While waiting for approval the group state is `awaiting_approval`. | One await per join flow for apps; the state and indicator cover the waiting UI. |
| D9 | Pending joiners whose group ends **or leaves memory** get an unsolicited `error` `GROUP_ENDED` (AC22, the architect's pick). | An existing, accurate code for "this group is gone for you". The joiner holds no token, so nothing else changes on the client. |
| D10 | `createGroup(metadata, initialPosition?, options?)` keeps its #3 positional `initialPosition` and adds a third `options` argument (`{ joinMethods? }`). | The spec's `createGroup(metadata, options?)` wording would break every existing caller that passes a position. Gate 2 question Q-A. |
| D11 | Test migration (AC44): server tests join through a new `joinByCode(ts, created, apiKey?)` helper and the existing `createGroupWithMembers`, which switches to codes. Client tests use `joinByCode()` with the codes from `createGroup()`. No test-only server flag. | Keeps the removed path removed (AC36) and exercises the real admission path everywhere. |

### 1.2 Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Separate `code.lookup` request for method A | Rejected at Gate 1 (Q2.2). |
| Codes inside the participant token | Codes rotate; every rotation would force a token re-issue (#5 architecture 4.1). |
| JWT format (reusing `TokenService`) for tickets and blobs | Three segments plus a header push the ticket past 256 characters, and sharing the token code path invites confusion between credential types. A tiny separate format with its own keys is simpler to reason about. |
| Server-side ticket table | Violates "persist nothing" and adds memory per ticket. Stateless tickets plus the generation check give the same revocation (rotate). |
| Client refreshes QR tickets automatically | See D7. |
| Separate "ticket generation" that door-code rotations don't bump | Would keep QR tickets alive through attacker-triggered door rotations, but AC29 requires a new generation on every rotation. Raised as Gate 2 question Q-B. |
| Per-IP limits | Rejected at Gate 1 (Q5.3). |
| Putting codes into the client snapshot (`GroupState`) | Apps often log or serialize the snapshot. Codes are read through `getJoinCodes()` and the `codesChanged` event instead. |

## 2. Files

### 2.1 Create

| Path | What |
| --- | --- |
| `packages/protocol/src/join.ts` | `JoinMethod = 'A'\|'B'\|'C'\|'D'`, `JOIN_METHODS`, `ALPHA_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'`, `normalizeJoinCode(raw)` (strip spaces and hyphens, uppercase), `classifyJoinCode(normalized) -> 'group' \| 'alpha' \| undefined`, `isDoorCode(normalized)`, `normalizeDisplayName(raw) -> string \| undefined` (section 4.5), `QR_TICKET_PATTERN`, `CODES_BLOB_PATTERN`, `JOIN_REQUEST_ID_PATTERN`. Pure, no globals (SSR rule #3 AC7). Shared by server and client so both normalize identically (AC12). |
| `packages/protocol/test/join.test.ts` | Normalization, classification, alphabet (no 0/O/1/I/L), display-name rules, patterns. |
| `apps/sync-server/src/tokens/signed-blob.ts` | `signCompact(payloadJson, key)`, `verifyCompact(text, keys, maxLength) -> { payloadJson, keyIndex } \| undefined`: length first, exactly two segments, base64url charset before decoding, 43-character signature, `timingSafeEqual` against every key. |
| `apps/sync-server/src/tokens/qr-tickets.ts` | `QrTicketService.issue(ns, gid, generation, now, seconds) -> { ticket, expiresInMs }`, `verify(ticket, ns, now) -> { ok: true, gid, generation } \| { ok: false, expired: boolean }` (`expired` only for a well-formed, correctly signed ticket). |
| `apps/sync-server/src/tokens/codes-blob.ts` | `CodesBlobService.sign(ns, gid, methods, codes) -> string`, `verify(blob, ns, gid) -> { methods, codes } \| undefined`. |
| `apps/sync-server/src/joins/join-methods.ts` | `defaultAppMethods(envAllowed)`, `resolveGroupMethods(app, requested?) -> { ok: true, methods } \| { ok: false }` (AC5 rules), `methodsKey()` canonical sort A-D. |
| `apps/sync-server/src/joins/codes.ts` | `GroupCodes` type, `drawGroupCode()`, `drawDoorCode(groupCode)`, `drawAlphaCode()` (`crypto.randomInt`, uniform), `nextGeneration(prev, now)` (D4), `issueCodeSet(index, ns, gid, methods, prevGeneration, now) -> GroupCodes \| 'exhausted'`, `MAX_CODE_DRAWS = 20`. |
| `apps/sync-server/src/joins/code-index.ts` | `CodeIndex`: `lookup(ns, kind, code) -> gid \| undefined`, `claim(ns, gid, codes) -> boolean` (all or nothing), `release(ns, gid, codes)`, `size`, `clear()`. Synchronous, so a claim is atomic in-process. |
| `apps/sync-server/src/joins/door-guard.ts` | `DoorGuard` per group key: `recordFailure(key, now) -> 'counted' \| 'rotate'`, `recordRotation(key, now) -> { paused: boolean, until? }`, `pausedFor(key, now) -> ms \| 0`, `reset(key)` (leader rotate), `clear(key)`, `clearAll()`. Pause-end timer on the injected `Scheduler`. |
| `apps/sync-server/src/joins/approval-queue.ts` | `ApprovalQueue`: `add(groupKey, session, displayName?, deadline, onTimeout) -> requestId \| 'full'`, `take(groupKey, requestId)`, `takeBySession(session)`, `list(groupKey)`, `drain(groupKey)`, `clearAll()`. Sets and clears `session.pendingJoin`. |
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
| `apps/sync-server/src/limits/constants.ts` | Fixed join constants (section 5.3). |
| `apps/sync-server/src/tokens/token-keys.ts` | `deriveAppKey(secret, ns, infoPrefix = HKDF_INFO_PREFIX)`; `TokenKeyring` takes an optional purpose prefix. Token keys byte-identical to today (pinned by test). |
| `apps/sync-server/src/server.ts` | Builds the two extra keyrings, `QrTicketService`, `CodesBlobService`, passes them to `GroupService`. |
| `apps/sync-server/src/groups/group-store.ts`, `in-memory-group-store.ts` | `GroupRecord.joinMethods`, `GroupRecord.codes`; `setCodes(ns, id, codes) -> GroupRecord \| undefined`; `copy()` copies `codes`. |
| `apps/sync-server/src/groups/session.ts` | `Session.pendingJoin?`; `GroupActions`: `join` removed; `joinByCode`, `joinByQr`, `cancelJoin`, `approveJoin`, `denyJoin`, `issueQr`, `rotateCodes` added. |
| `apps/sync-server/src/groups/group-service.ts` | Builds `JoinService`; `busy()` includes `pendingJoin`; create issues codes; `join()` and the group-ID path removed; `forgetGroup` / `endGroup` / `dropGroup` call `joins.onGroupGone`; leader return and recreation return codes; disconnect calls `joins.onDisconnect`; `close()` calls `joins.close()`. |
| `apps/sync-server/src/ws/connection.ts` | `hello.ok` gets `joinMethods` and the two new limits; dispatch for the new types; `group.join` case removed; `canCarryReqId` extended. |
| `apps/sync-server/src/ws/error-messages.ts` | Texts for the new codes; `ACTION_ERROR_TEXT` rows for the new actions (section 4.4). |
| `apps/sync-server/src/logging/logger.ts` | `REDACT_PATHS` adds `joinCode`, `doorCode`, `groupCode`, `alphaCode`, `codes`, `joinCodes`, `ticket`, `requestId` (each also as `*.x`). `displayName` is already there. |
| `apps/sync-server/test/helpers/groups.ts` | `createGroupWithMembers` joins by code; new `joinByCode(ts, created, opts)`, `codesOf(created)`. |
| `apps/sync-server/test/helpers/test-server.ts` | `TestAppInput` gains `joinMethods`, `qrTicketSeconds`, `approvalTimeoutSeconds`. |
| Server tests that send `group.join` (`end-leave`, `flood`, `frozen`, `groups`, `handshake`, `isolation`, `lifecycle`, `limits`, `opaque-payload`, `position`, `privacy`, `recreate`, `restart-process`, `restart`, `resume`, `robustness`, `slow-consumer`, `tokens`) | Join through the helpers (AC44). `groups.int` and `isolation.int` cases about group IDs become code cases; tests that loop more than 10 joins on one connection get a scheduler advance or new connections. |
| `apps/sync-server/test/env.test.ts`, `apps-config.test.ts`, `handshake.int.test.ts`, `token-keys.test.ts`, `error-messages.test.ts`, `in-memory-group-store.test.ts`, `logger.test.ts` | New config, `hello.ok` fields, key pinning, texts, store fields, redaction. |
| `config/apps.example.json`, `config/apps.dev.json` | `joinMethods` (example: `["A","D"]` and `["C","D"]`; dev: `["A","B","C","D"]` so every flow can be tried locally). |
| `compose.yaml` | `JOIN_METHODS_ALLOWED: A,B,C,D` with a comment. |
| `README.md` | Env vars, app settings, fixed join limits, brute-force reasoning, protocol summary, updated block-list note (AC37, AC43). |
| `packages/client/src/state.ts` | `awaiting_approval` group state; `SyncIndicator` adds `'awaiting_approval'`; new event and result types (section 7). |
| `packages/client/src/errors.ts` | `RequestKind` swaps `group.join` for the new kinds; client codes `INVALID_JOIN_CODE`, `INVALID_DISPLAY_NAME`, `JOIN_METHOD_UNAVAILABLE`, `JOIN_CANCELLED`; details for `JOIN_PAUSED`, `RATE_LIMITED`, `APPROVAL_QUEUE_FULL`; `ACTION_MESSAGES` rows matching the server. |
| `packages/client/src/client.ts` | `joinGroup` removed; `joinByCode`, `joinByQr`, `cancelJoin`, leader API, new inbound messages, blob capture. |
| `packages/client/src/token-store.ts` | `Recovery.joinCodes?: string` (validated on load against `CODES_BLOB_PATTERN` and length); document stays `v: 1` (additive). |
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
  generation: number;   // D4; safe integer
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
| `DoorGuard` | `ns:gid` -> `{ failures: number[], rotations: number[], pausedUntil?, timer? }` | Method A groups only; at most 5 + 3 timestamps each (older ones pruned) |
| `ApprovalQueue` | `ns:gid` -> `Map<requestId, { session, displayName?, deadline, cancel }>`; `session.pendingJoin` back-pointer | 10 per group, 1 per connection |
| Join limiter (per connection) | `connectionId` -> timestamps | 10 per minute; forgotten on disconnect |
| Join limiter (per app) | `ns` -> timestamps | 600 per minute |
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
  generation: number;
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
   - 6-digit code, group uses **A**: paused -> `JOIN_PAUSED { retryAfterMs }` (door code not checked); no door code -> `DOOR_CODE_REQUIRED` (no failure counted); wrong door code (constant-time compare of 6-byte buffers) -> `DOOR_CODE_WRONG` and `DoorGuard.recordFailure`; correct -> admit.
   - 6-digit code, group uses **B** -> approval (4.6).
   - 8-character code (C) -> admit.
   - QR ticket: group not in memory, generation != current, or D not in methods -> `QR_INVALID`; B group -> approval; else admit.
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
- Display name: `trim()`; length 1..32 counted in code points; rejected if it
  contains `\p{Cc}` (control characters), U+2028/U+2029, or bidi overrides and
  isolates (U+202A-U+202E, U+2066-U+2069). The bidi rule is an addition to the
  spec's "no control characters", to stop a name from visually reordering the
  leader's prompt. Emoji (including ZWJ sequences) stay allowed (AC20).
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

### 4.7 QR tickets (AC23-AC26)

- `qr.issue`: ownership-checked leader (`NOT_LEADER` / `NOT_IN_GROUP`); D in
  methods (else `JOIN_METHOD_NOT_ALLOWED`); 6 per connection per minute.
  Ticket = `signCompact({"v":1,"g":gid,"n":generation,"e":expSeconds}, qrKey(ns))`
  with `exp = now + qrTicketSeconds`; reply `expiresInMs = qrTicketSeconds * 1000`.
- Verification order: length and pattern; signature with the current then the
  previous qr key (constant time, every key checked); parse JSON in try/catch;
  exact claim schema (`v === 1`, `g` matches `GROUP_ID_PATTERN`, `n` and `e`
  safe non-negative integers, `e * 1000 <= now + qrTicketSecondsCeiling * 1000 + MAX_CLOCK_SKEW_MS`
  as a plausibility bound); then expiry -> `QR_EXPIRED`; then group lookup under
  the lock (not in memory, generation mismatch, no D) -> `QR_INVALID`.
- Multi-use until expiry; rotation (any reason) bumps the generation and so
  invalidates outstanding tickets (AC24, AC25).
- A ticket can't verify as a token (different key, two segments, no JWT header)
  and a token can't verify as a ticket (different key, three segments). Both
  directions tested (AC26).

### 4.8 Codes blob and recovery (AC32-AC35)

- Blob = `signCompact({"v":1,"g":gid,"n":generation,"m":"AD","gc":"...","dc":"...","ac":"..."}, codesKey(ns))`
  (absent codes omitted). Sent in every `JoinCodesPayload`.
- **Recreation** (`group.resume`, leader token, group not in memory): verify
  the blob (current or previous codes key) and require `g === claims.gid`,
  `m` a valid method set that is a subset of the app's current `joinMethods`,
  and code formats that match `m`. If valid and `CodeIndex.claim` succeeds for
  all its codes -> same codes and generation, `codesChanged: false`. Otherwise
  (missing, invalid, other group or app, methods no longer allowed, or any code
  taken) -> methods = blob methods intersected with the app's methods if that
  is still a valid set, else the app default (AC5 rule); a full new set via
  `issueCodeSet` with `nextGeneration(blobGeneration ?? 0, now)`;
  `codesChanged: true` (AC33). `CODES_EXHAUSTED` here is reported as the resume
  error and nothing is recreated.
- **Leader return** to a live group: the blob is ignored for state; the reply
  carries the current codes and a fresh blob. `codesChanged` is true unless the
  presented blob verified and has the current generation (door rotations while
  the leader was offline show up as changed) (AC34).
- The server never accepts codes it didn't sign for that group ID (AC33).
- Accepted limit: a leader-token holder could present an **older** blob of the
  same group and get older codes back if they are free. Only the leader's own
  client holds blobs, it always stores the latest, and the leader can rotate.
  Recorded in section 9.

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
| `DOOR_FAILURES_BEFORE_ROTATION` / `DOOR_FAILURE_WINDOW_MS` | 5 / 600 000 |
| `DOOR_ROTATIONS_BEFORE_PAUSE` / `DOOR_ROTATION_WINDOW_MS` | 3 / 1 800 000 |
| `DOOR_PAUSE_MS` | 600 000 |
| `QR_ISSUE_PER_CONNECTION_PER_MINUTE` | 6 |
| `CODE_ROTATIONS_PER_GROUP_PER_MINUTE` | 6 |
| `MAX_PENDING_APPROVALS_PER_GROUP` | 10 |
| `MAX_CODE_DRAWS` | 20 |

Door-failure rotation: on the 5th failure inside the 10-minute window, the
door code alone is redrawn, the generation bumps (D4), failures reset, and the
leader gets `codes.updated door_failures`. The rotation is recorded; if it is
the 3rd inside 30 minutes, method A pauses for 10 minutes (`join.paused` to the
leader; `join.resumed` from the pause timer). `codes.rotate` resets failures,
rotation history and any pause (AC29, AC30).

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
connection ID), `method`, `reason` as a fixed enum name, counts and booleans.
New events: `group_joined` + `method`; `join_rejected { namespace, cause }`
at debug, where `cause` is one of `not_found | door_required | door_wrong |
paused | qr_invalid | qr_expired` (no group ref for `not_found` / `qr_invalid`,
so logs aren't an oracle either); `door_code_rotated { groupRef }`;
`join_paused` / `join_resumed`; `codes_rotated`; `join_requested`,
`join_settled { outcome }`; `qr_issued`; `codes_restored { changed }`;
`join_app_budget_exhausted { namespace }` (once per window). Never logged:
codes, door codes, tickets, blobs, display names, request IDs, raw participant
IDs, IPs.

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
`codes_changed { reason }`, `qr_issued`, `join_request_received { count }`.
Never logged: codes, door codes, tickets, blob, display names, request IDs.

## 8. Security-sensitive areas

Security-sensitive: yes

| Area | Where | Notes |
| --- | --- | --- |
| Authentication / admission (new credentials) | `joins/join-service.ts`, `group-service.ts` | Codes and tickets become the only way to get a new identity; `group.join` by ID removed (AC36, AC37). |
| Authorization (leader-only actions) | `join.approve`, `join.deny`, `qr.issue`, `codes.rotate` | Ownership-checked through the notifier (M4), per-action `NOT_LEADER` texts; approve/deny scoped to the leader's own group queue. |
| New endpoints accepting user input | 7 new client message types, changed `group.create` and `group.resume` | Bounded zod schemas, normalization, budgets before lookups (4.3). |
| Brute force and enumeration | Door codes, alphanumeric codes, group codes | Per-connection and per-app budgets, door rotation and pause, constant-time door comparison, identical `CODE_NOT_FOUND` / `QR_INVALID` responses, no logs that act as oracles (4.3, 5.3, 6.1). |
| Crypto (new signed formats) | `tokens/signed-blob.ts`, `qr-tickets.ts`, `codes-blob.ts`, `token-keys.ts` | HKDF per app and per purpose; HMAC-SHA256; constant-time compare across all keys; charset and length before decode; strict claim schema; previous-secret acceptance; token keys unchanged (D2). |
| Secrets / config | `env.ts`, `apps-config.ts` | Env ceiling for methods, no clamping, no values echoed (AC1-AC3). |
| PII (possibly minors) | Display names; codes | Display name relayed to the leader only, never stored after settle, never logged; codes leader-only; new redaction paths (AC10, AC20). |
| DoS surfaces | Approval queue, timers, code index, door guard | All bounded and cleared on end, drop and close (section 3, AC31). |
| Client credential storage | `token-store.ts` | Codes blob stored with the leader's recovery data, validated on load, deleted with it. |
| Dependencies | none added | AC45. |

### 8.1 Brute-force reasoning (for the README and the security review)

- **Door code (A):** with the group code known, at most 5 wrong door codes per
  10 minutes before the door code changes, and after 3 rotations in 30 minutes
  a 10-minute pause. That is at most 15 guesses per 40 minutes, about 540 a day,
  each against a fresh 1-in-10^6 code: about 5 x 10^-4 per day per group. Every
  rotation and pause is visible to the leader. The per-connection and per-app
  budgets are additional caps.
- **Alphanumeric code (C):** 31^8 = 8.5 x 10^11 codes. With the whole per-app
  budget (600/min = 864 000/day) aimed at an app with 1000 live C groups:
  864 000 x 1000 / 8.5 x 10^11 = about 1.0 x 10^-3 per day of hitting any group
  (Q5.6, accepted; to be confirmed by the security plan review).
- **Group codes (A, B):** enumerable by design (they are shown openly). For B
  this lets a guesser reach a leader with requests; bounded by 10 pending per
  group and 1 per connection; the leader denies or rotates.
- **QR tickets:** 256-bit HMAC, unforgeable without the secret; replay bounded
  by expiry (<= `qrTicketSeconds`) and by rotation.

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
`joinCodes`, `ticket`, `requestId`, plus `*.` variants). Errors from the signed
blob services never carry input; verification returns a result object.

## 9. Risks and edge cases

- **Door rotations kill QR tickets.** AC29 bumps the generation, so an attacker
  who knows the group code can invalidate QR tickets every 5 wrong guesses (at
  most 3 times per 30 minutes before the pause stops door guessing). The leader
  app re-issues on `codesChanged` (D7 recipe). Gate 2 question Q-B offers a
  separate ticket generation instead.
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
- **Older blob replay** (4.8): only by the leader-token holder; accepted.
- **Generation and clock.** D4 uses server time. A server clock stepping far
  back after a restart without a blob could give a lower generation than an
  outstanding ticket; tickets expire within `qrTicketSeconds` (<= 1 h by
  default ceiling), so the window is bounded. NTP assumed (as #5).
- **Codes out of memory are not reserved** (Q4.2). After a drop, another group
  can take the code, and the recreating leader gets new codes. People already
  told the old codes must be told again.
- **Pending requests while the leader is offline** wait until their deadline
  (Q6.2); the leader sees them on return with the remaining time.
- **Multi-tab leaders.** The blob follows the #5/#7 storage merge rules
  (newest token `iat` wins); a stale tab could store an older blob, with the
  replay consequence above.
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
| AC25 | Expired (ManualScheduler), bad signature, malformed, 257 chars, other app, group dropped, older generation (after `codes.rotate` and after a door rotation) -> `QR_INVALID`, except expired-but-valid -> `QR_EXPIRED`; invalid responses deep-equal; ticket never echoed. | `join-qr.int.test.ts`, `qr-tickets.test.ts` |
| AC26 | HKDF keys differ per purpose and namespace; token keys byte-equal to a pinned value; ticket signed with previous secret accepted until expiry; ticket given as a token -> `TOKEN_INVALID`; token given as a ticket -> `QR_INVALID`; blob given as a ticket and vice versa -> invalid. | `token-keys.test.ts`, `qr-tickets.test.ts`, `codes-blob.test.ts`, `join-qr.int.test.ts` |
| AC27 | 10 attempts OK (mix of outcomes, including `DOOR_CODE_REQUIRED`), 11th -> `RATE_LIMITED { retryAfterMs }` "Too many join attempts" before lookup (`CodeIndex.lookup` spy not called), socket open; window advance -> OK. | `join-bruteforce.int.test.ts` |
| AC28 | 61 app-a connections x 10 -> 601st `RATE_LIMITED`; app-b unaffected; no lookup for refused attempts. | `join-bruteforce.int.test.ts` |
| AC29 | 5 wrong door codes in 10 min -> leader `codes.updated door_failures` with a new door code, same group code, higher generation, new blob; old door code now wrong; 4 failures + 11 min + 1 failure -> no rotation; 3 rotations in 30 min -> `JOIN_PAUSED { retryAfterMs }` for A attempts (correct door code included), leader `join.paused`; C and D still work; after 10 min `join.resumed` and joins work. | `join-bruteforce.int.test.ts`, `door-guard.test.ts` |
| AC30 | `codes.rotate`: every code replaced, generation up, old QR ticket `QR_INVALID`, failures reset, pause lifted (`join.resumed`); 7th per minute -> `RATE_LIMITED`; member -> `NOT_LEADER`. | `join-bruteforce.int.test.ts` |
| AC31 | After group end and after `server.close()`: ManualScheduler pending 0, `CodeIndex.size` 0, queues and limiters empty; log capture shows no codes, names, IPs or raw pids. | `join-bruteforce.int.test.ts`, `join-privacy.int.test.ts` |
| AC32 | Every `JoinCodesPayload` (create, rotate, door rotation, resume) carries a blob that verifies with the codes key only; client stores it in recovery and sends it in `group.resume`. | `codes-blob.test.ts`, `join-recovery.int.test.ts`, `client.leader-codes.test.ts` |
| AC33 | Recreate with valid blob -> same codes and generation, `codesChanged: false`; missing, tampered, other group, other app, methods no longer allowed, one code taken -> full new set, higher generation, `codesChanged: true`; client-invented blob rejected. | `join-recovery.int.test.ts` |
| AC34 | Leader return -> current codes and blob; pending re-sent; `codesChanged` true after an offline door rotation, false otherwise. | `join-recovery.int.test.ts` |
| AC35 | In-process: A + D group, member joins by code, new server instance with the same secret, leader resumes -> same codes, new joiner gets in, old member resumes with its token. Second test: another group takes the group code first -> leader gets new codes. Child-process variant extends `restart-process.int.test.ts`. Client variant in `integration/restart.int.test.ts`. | `join-recovery.int.test.ts`, `restart-process.int.test.ts`, `integration/restart.int.test.ts` |
| AC36 | `group.join` -> `INVALID_MESSAGE`; schema test; no `GroupActions.join`; static test: no client message type in the schema carries `groupId` as a field. | `join-removed.int.test.ts`, `schemas.test.ts` |
| AC37 | Blocked member resumes -> `PARTICIPANT_BLOCKED`; forged `group.join` -> invalid; new identity only by current code; after `codes.rotate` the old codes fail. README texts reviewed. | `join-removed.int.test.ts`, review |
| AC38 | `createGroup` with `joinMethods` sends them and resolves codes, generation, methods; invalid sets rejected locally with nothing sent. | `client.join.test.ts`, `client.groups.test.ts` |
| AC39 | Each server code rejects with its typed code; `awaiting_approval` state and `indicatorOf` row; `cancelJoin` flow and race; local guard timeout; drop while pending -> `CONNECTION_LOST`, no re-request. | `client.join.test.ts`, `state.test.ts`, `integration/join.int.test.ts` |
| AC40 | `getJoinCodes`, `rotateCodes`, `issueQrTicket` (`expiresAt` from local clock), `approveJoin`, `denyJoin`, events with reasons, dedup of re-sent requests; blob stored, deleted with the token. | `client.leader-codes.test.ts`, `token-store.test.ts` |
| AC41 | `joinGroup` absent from the class and exports (type test with `@ts-expect-error`); README has no `joinGroup`; token rejoin tests unchanged. | `client.groups.test.ts`, `readme.test.ts`, `client.rejoin.test.ts` |
| AC42 | Recording logger plus every error's `message`, `details`, `serverMessage` across all new flows: no code, ticket, blob or name sentinel. | `logging.test.ts`, `client.join.test.ts` |
| AC43 | READMEs reviewed against sections 4-5 and 8.1; `readme.test.ts` asserts the join-flow, leader-API and QR deep-link headings and the fragment advice; example configs parse. | review, `readme.test.ts`, `apps-config.test.ts` |
| AC44 | Migrated tests pass; every other existing test unchanged. | CI |
| AC45 | `pnpm lint`, `typecheck`, `test`, `build`, `pnpm audit --audit-level=high`; lockfile unchanged except workspace edits; no Node-only runtime import in the client (existing no-DOM/no-Node typecheck); `ssr-import` test still passes with the new protocol module. | CI |

## 11. Implementation chunks (planned commits)

Every commit keeps `pnpm lint/typecheck/test/build` green, carries its tests,
and ends with the `Refs: #10` trailer. When a protocol change alters a server
frame the client parses, the same commit updates the client's types and
fake-socket fixtures (type-level only; client behavior lands in 14-17).

1. `feat(protocol): add join methods, code normalization and display name rules`
   (join.ts, limits, exports; AC8, AC12, AC20 shared rules)
2. `feat(config): add join methods and join timers to env and apps config`
   (env.ts, apps-config.ts, AppConfig, `hello.ok` fields, client limit bounds and `ConnectedInfo`, example and dev configs, compose; AC1-AC4)
3. `feat(server): add signed qr tickets and codes blobs with separate keys`
   (token-keys purpose prefix, signed-blob.ts, qr-tickets.ts, codes-blob.ts; AC26 unit, AC32 format)
4. `feat(server): draw and index join codes per app`
   (codes.ts, code-index.ts, join-methods.ts; AC7-AC9 unit)
5. `feat(server): issue join codes when a group is created`
   (protocol `group.create.joinMethods`, `group.created.codes`; GroupRecord fields, `setCodes`; release on end and drop; client fixtures; AC5, AC6, AC9, AC11)
6. `feat(server): join groups by group code and door code or alphanumeric code`
   (JoinService skeleton, `group.joinByCode` for A and C, new error codes and texts; AC12-AC18)
7. `test(server): join through codes in server test helpers`
   (helpers and the 18 server test files off `group.join`; AC44)
8. `feat(server): limit join attempts per connection and per app`
   (two limiters, action texts, budget warning; AC27, AC28)
9. `feat(server): rotate door codes and pause method a after failures`
   (DoorGuard, `codes.updated door_failures`, `join.paused` / `join.resumed`; AC29)
10. `feat(server): let the leader rotate join codes` (`codes.rotate`; AC30)
11. `feat(server): add leader approval for method b joins`
    (ApprovalQueue, `join.*` messages, timers; AC19-AC22)
12. `feat(server): issue and accept qr join tickets` (`qr.issue`, `group.joinByQr`; AC23-AC26)
13. `feat(server): keep join codes across group recreation and leader return`
    (`group.resume.joinCodes`, `codesChanged`, re-sent requests and pause; AC32-AC34, AC35 in-process)
14. `feat(client): join groups by code and qr ticket`
    (`joinByCode`, `joinByQr`, `cancelJoin`, `awaiting_approval`, indicator, error codes; client tests moved off `joinGroup`; AC12, AC39)
15. `feat(protocol)!: remove join by group id`
    (schema, server dispatch, `GroupActions.join`, client `joinGroup`, remaining references; AC36, AC41; `BREAKING CHANGE:` footer)
16. `feat(client): add leader api for join codes, qr tickets and approvals`
    (getJoinCodes, rotateCodes, issueQrTicket, approve/deny, events, request list; AC38, AC40)
17. `feat(client): store the codes blob and send it when recreating a group`
    (token-store `recovery.joinCodes`, resume and auto-rejoin; AC32, AC40)
18. `test(server): verify join codes, tickets and names never reach logs`
    (redact paths, privacy and cleanup tests; AC10, AC20, AC31)
19. `test(server): keep join codes across a server process restart`
    (child-process restart; AC35)
20. `test(client): cover join flows against the real server`
    (integration join, approval, QR, restart; recording-logger checks; AC35, AC39, AC42)
21. `docs: document join methods, brute-force limits and the leader api`
    (both READMEs, block-list note, QR deep-link advice; AC37, AC43)

## 12. Questions for Gate 2

- **Q-A (AC38). `createGroup` signature.** Proposed: keep
  `createGroup(metadata, initialPosition?, options?)` and add `options.joinMethods`
  (D10). The spec's `createGroup(metadata, options?)` wording would break every
  caller that passes an initial position. Alternative: change to
  `createGroup(metadata, { position?, joinMethods? })` now, since nothing is
  released.
- **Q-B (AC29 vs AC25). Door rotations and QR tickets.** As specified, every
  rotation bumps the one generation, so an attacker who knows the group code can
  invalidate the leader's QR tickets with 5 wrong door codes (at most 3 times
  per 30 minutes before the pause). Proposed: follow the spec, and the leader app
  re-issues on `codesChanged`. Alternative: a separate ticket generation that
  only `codes.rotate` (and recreation without a valid blob) bumps.
- **Q-C (AC22). Reply to pending joiners when the group ends or leaves memory.**
  Proposed: unsolicited `GROUP_ENDED` for both (D9). Alternative: a new
  `JOIN_REQUEST_CLOSED` code.
- **Q-D (Q3.1). QR refresh.** Proposed: app-driven `issueQrTicket()` with a
  documented refresh recipe; no client timer (D7). Alternative: an opt-in
  client helper that refreshes on a timer while started.
- Informational (no decision needed unless you object):
  - Time-based generation floor (D4) so post-restart code sets always outrank
    old tickets.
  - Wire field names `joinCode` / `doorCode` / `joinCodes` for redaction (D5).
  - Display names also reject bidi overrides and isolates, beyond "control
    characters" (4.5).
  - Relative `...Ms` fields instead of absolute deadlines (D6).
  - New client indicator value `awaiting_approval`.
  - The dev apps config allows all four methods so every flow can be tried
    locally; the example config shows `["A","D"]` and `["C","D"]`.

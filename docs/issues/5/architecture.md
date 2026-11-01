# Architecture: #5 Participant tokens, token rejoin and restart recovery

Issue: https://github.com/MosheRW/sync-system/issues/5
Spec: [`spec.md`](./spec.md) (43 ACs; Gate 1 accepted every proposed default Q1-Q15 as written)
Path: full | Branch: `feat/5-tokens-recovery` | Designer: skipped (no UI)
Builds on: #1 (`packages/protocol`, `apps/sync-server`, see `docs/issues/1/*`) and
#3 (`packages/client`, see `docs/issues/3/*`). Every hardening control from those
issues (H1-H4, M1-M6, L1-L8, S1-S4 on the server; H1-H2, M1-M5, L1-L8, R2-L1..L6
on the client) stays in place. Nothing in this plan removes or weakens one.

"Item N" means PRD item N of 9, as in the spec.

## 1. Approach

The server stays stateless on disk. Each participant gets a signed JWT per
group. The token, plus data the leader's client keeps (metadata, latest
position, block list), is all that is needed to rebuild a group after a
restart. Server memory is only a cache of live groups: a group nobody is
connected to is dropped from memory, and the leader's token recreates it. A
restart, a "resume later" and a leader coming back are therefore one code path
(spec decision 4).

Layering stays as in #1 (transport -> connection -> GroupService -> GroupStore /
Notifier). New collaborators are small, single-purpose and unit-testable with
an injected clock and scheduler:

```
Connection ──> GroupService (facade, implements GroupActions)
                 ├─ TokenService      sign / verify / classify tokens (HS256, per-app keys)
                 ├─ resume.ts         group.resume and tokens.check rules
                 ├─ GroupTimers       frozen-group end + max-session end, per group
                 ├─ TokenRefresher    AC12 leader refresh policy, per group
                 ├─ EndedGroups       remembered ended group refs (Q8)
                 ├─ ParkingLot        members waiting for a recreation (Q7)
                 ├─ GroupStore        + lastActivityAt, leaderOnline, blockList
                 └─ Notifier          keyed by membership (namespace, group, participant)
```

The client gets a pluggable `TokenStorage`, an internal `TokenStore` (one
versioned JSON document per server and app), a token-based `RejoinStrategy`
that replaces `memberRejoinByGroupId` at the seam #3 built for it, and the new
public methods `checkTokens`, `resumeGroup`, `endGroup`, `leaveGroup` and the
block-list methods.

### 1.1 Token library: minimal in-house HS256 (no new dependency)

Decision: a ~80-line HS256 implementation on `node:crypto` (`createHmac`,
`timingSafeEqual`, `hkdfSync`) in `apps/sync-server/src/tokens/jwt.ts`. No new
runtime or dev dependency is added (AC43).

Why not a library:

| Option | Assessment |
| --- | --- |
| `jose` (panva) | Zero dependencies and well maintained, the best library choice. But we use one algorithm, one header and our own claim checks. `jose` brings JWS/JWE/JWK/JWKS, algorithm negotiation and `crit` handling: surface we would have to configure correctly and keep patched, and a supply-chain entry in the server image for about 80 lines of value. |
| `jsonwebtoken` | Pulls a dependency tree (`jws`, `lodash.*`, `semver`, `ms`) and has a history of algorithm-confusion advisories. Rejected. |
| In-house | HS256 is only `base64url(header) "." base64url(payload)` with HMAC-SHA256. The main JWT bugs come from **accepting** variety (`alg: none`, RS/HS confusion, `kid`, `jku`, `crit`). We remove that whole class by construction: the header segment must be **byte-equal** to the one constant header we emit. |

Controls that make the in-house version safe (all tested, section 10):

1. Length checked first (`<= MAX_TOKEN_LENGTH = 2048`), then exactly three
   segments, each matching `^[A-Za-z0-9_-]+$` (Node's base64url decoder is
   lenient, so the charset is checked before decoding).
2. Header segment `=== "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"`
   (`{"alg":"HS256","typ":"JWT"}`). Anything else (`none`, `HS512`, `RS256`, an
   extra `kid`, reordered keys) is `invalid` before any HMAC is computed.
3. Signature: decoded to bytes; length must be 32; compared with
   `crypto.timingSafeEqual` against `HMAC-SHA256(key, header "." payload)` for
   the current key, then the previous key (AC2). There is no string comparison
   of signatures anywhere.
4. Only after a valid signature: the payload is `JSON.parse`d in `try/catch`,
   depth-checked with `checkJson(maxDepth 4)`, and validated by a zod claims
   schema (types, patterns, safe integers). Unknown extra claims are ignored
   (AC40).
5. The HMAC math is pinned by the RFC 7515 appendix A.1 test vector, which
   tests the low-level `hmacSha256(signingInput, key)` helper.

### 1.2 Per-app signing keys (cross-app isolation by construction)

The operator sets one `TOKEN_SECRET`. The server derives one 32-byte key per
app: `hkdfSync('sha256', secret, 'sync-system/token/v1', namespace, 32)`.
Keys are derived once per app at startup, for the current and the previous
secret. A token from app A presented on app B **fails the signature check**,
so it takes exactly the same code path as a random string (AC8, AC15). We
don't rely on comparing the `aud` claim for this, though `aud` is still
checked as a second line of defense. This mirrors how the store keys groups by
`namespace + id` (#1 AC18).

### 1.3 Server in-memory structures

| Structure | Where | Key -> value | Bound |
| --- | --- | --- | --- |
| `GroupRecord` (+ `lastActivityAt`, `leaderOnline`, `blockList`) | `GroupStore` (in-memory now, Redis in item 9) | `ns:groupId` -> record | Every record has at least one connected participant (dropped at 0), so at most `MAX_CONNECTIONS` |
| Attachments | `LocalNotifier` | `ns:groupId:participantId` -> `Session` | One per connection |
| Group timers | `GroupTimers` | `ns:groupId` -> `{ maxSession, frozenEnd? }` handles | One pair per record |
| Refresh state | `TokenRefresher` | `ns:groupId` -> `{ activities, lastTokenAt, timer? }` | One per record with leader online |
| Parked members | `ParkingLot` | `ns:groupId` -> ordered `Set<Session>`; `Session.parked` back-pointer + expiry timer | One parked group per connection (Q7) |
| Ended groups | `EndedGroups` | `sha256hex("ns:groupId")` -> deadline ms | Expired entries swept every 60 s; hard cap `MAX_ENDED_GROUPS = 100_000`, oldest evicted first (risk noted, section 9) |
| `tokens.check` limiter | `SlidingWindowRateLimiter(window 60 s)` | `connectionId` -> timestamps | One per connection, forgotten on close |

Everything that must be atomic across instances later (records, block lists,
leader-online flag, last activity) goes through `GroupStore`. Everything tied to
a socket or a timer (attachments, parking, timers, refresh) is process-local by
nature, and item 9 replaces it with pub/sub plus per-instance timers.

### 1.4 Client storage abstraction

```ts
export interface TokenStorage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
// option: storage?: TokenStorage | 'local' | 'memory'   (default 'local')
```

- The method names match Web Storage, so `localStorage`, `sessionStorage`,
  React Native `AsyncStorage` and simple Map wrappers fit as they are. Sync or
  async are both accepted; the client always `await`s.
- `'local'` is resolved **lazily**, on the first storage operation (after
  `hello.ok`, because the key needs the namespace). It is never resolved at
  import or construction (#3 AC7 still holds). The lookup
  `globalThis.localStorage` runs inside `try/catch`, since sandboxed iframes and
  some private modes throw on access. If it is missing or throws, the client
  uses an in-memory store and logs `warn storage_unavailable { name }`, with the
  error name only (AC32).
- All reads and writes go through one internal `TokenStore`, which serializes
  operations through a promise chain. Each write is **read-merge-write** (it
  reads the document again, applies the change, prunes, writes), so two tabs
  sharing `localStorage` overwrite each other's entries less often (section 9).
- Storage failures never reject a public method. A failed `setItem` (quota) or
  `getItem` logs `warn storage_error { op, name }` and keeps the in-memory copy.

### 1.5 Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Token in `hello` (one per connection) | Tokens are per group, and one connection can check 20 groups. A request (`group.resume`) also gives per-group errors and a `reqId`. |
| Server-side token or session table | Violates "persist nothing" (AC11) and the PRD principle. Out of scope (revocation lists). |
| Separate `group.recreate` message | The client can't know whether the group is still in memory. One `group.resume` that recreates when needed avoids a probe round trip and a race. |
| Encrypted tokens (JWE) | Out of scope. Claims hold no personal data. |
| Refreshing member tokens | Q6. Member validity comes from group liveness and creation time. |
| Client polling for an absent leader | Q7 chose server parking. Polling also burns the `tokens.check` budget. |
| Storing derived claims (groupId, role) next to tokens on the client | They could be tampered with or go stale. The client decodes them from the token on every load. |
| Nesting recovery data (`recovery: { metadata, ... }`) | It adds a depth level. `group.resume` carries `metadata`, `position` and `blockList` at top level, like `group.create`, so the frame depth budget (64) is unchanged. |

## 2. Files

### 2.1 Create

| Path | What |
| --- | --- |
| `packages/protocol/src/tokens.ts` | `TOKEN_FORMAT_VERSION = 1`, `TokenClaims` type, jitless zod `tokenClaimsSchema`, pure `base64UrlToAscii(segment)` (no globals; rejects non-ASCII bytes), `decodeTokenClaims(token): TokenClaims \| undefined` (unverified decode, used by the client; the server calls it only after the signature passes). |
| `packages/protocol/test/tokens.test.ts` | Decode, charset, ASCII-only, length, unknown claims ignored, `__proto__` claim harmless. |
| `apps/sync-server/src/config/token-secret.ts` | `parseTokenSecrets(env, nodeEnv)` returns `{ current: Buffer; previous?: Buffer; source: 'env' \| 'dev' \| 'random' }`; `DEV_TOKEN_SECRET`; rules from section 5.1. |
| `apps/sync-server/src/tokens/jwt.ts` | `TOKEN_HEADER_SEGMENT`, `hmacSha256`, `signHs256(payloadJson, key)`, `verifyHs256(token, keys) -> { payloadSegment, keyIndex } \| undefined` (section 1.1). |
| `apps/sync-server/src/tokens/token-keys.ts` | `TokenKeyring`: HKDF per-app keys for current and previous secrets, cached per namespace. |
| `apps/sync-server/src/tokens/token-service.ts` | `TokenService.issue(input)`, `verify(token, namespace, now) -> { ok: true; claims; viaPrevious } \| { ok: false }`, `resign(claims, namespace)`. Never logs or throws with token content. |
| `apps/sync-server/src/time/scheduler.ts` | `Scheduler { now(): number; at(timeMs, task): Cancel }`; `realScheduler(now)` uses `setTimeout(...).unref()`, with the delay clamped to `[0, 2^31-1]`. |
| `apps/sync-server/src/groups/group-timers.ts` | Per-group max-session and frozen-end timers (section 6.3). |
| `apps/sync-server/src/groups/token-refresher.ts` | AC12 policy (section 6.4). Pure apart from the scheduler. |
| `apps/sync-server/src/groups/ended-groups.ts` | `EndedGroups.remember(ns, id, deadline)`, `has(ns, id)`, `sweep()`; keys are sha256 refs only. |
| `apps/sync-server/src/groups/parking-lot.ts` | `park(session, ns, id, until)`, `unpark(session)`, `drain(ns, id) -> Session[]`; one parked group per session; expiry callback. |
| `apps/sync-server/src/groups/resume.ts` | `classifyToken(...)` (shared by `tokens.check` and `group.resume`) and the resume and recreate procedures used by `GroupService`. |
| `apps/sync-server/test/helpers/manual-scheduler.ts` | `ManualScheduler` (`now`, `at`, `advance(ms)` runs due tasks in time order). Replaces `TestClock` in new tests; `TestClock` stays for old ones. |
| `apps/sync-server/test/helpers/tokens.ts` | Test-only helpers: forge tokens (`alg: none`, HS512, wrong key, extra header fields, bad claims), decode claims. |
| `apps/sync-server/test/token-secret.test.ts`, `jwt.test.ts`, `token-keys.test.ts`, `token-service.test.ts`, `token-refresher.test.ts`, `group-timers.test.ts`, `ended-groups.test.ts`, `parking-lot.test.ts`, `scheduler.test.ts` | Unit tests (section 10). |
| `apps/sync-server/test/tokens.int.test.ts`, `resume.int.test.ts`, `frozen.int.test.ts`, `recreate.int.test.ts`, `parking.int.test.ts`, `blocklist.int.test.ts`, `end-leave.int.test.ts`, `tokens-check.int.test.ts`, `refresh.int.test.ts`, `token-privacy.int.test.ts`, `restart-process.int.test.ts`, `no-disk.test.ts` | Integration and static tests (section 10). |
| `packages/client/src/storage.ts` | `TokenStorage`, `memoryStorage()`, `resolveStorage(option, log)` (lazy `localStorage`). |
| `packages/client/src/token-store.ts` | `storageKey(namespace, host)`, `TokenStore` (load, validate, prune, read-merge-write, recovery data, block list). |
| `packages/client/test/storage.test.ts`, `token-store.test.ts`, `client.tokens.test.ts`, `client.resume.test.ts`, `client.blocklist.test.ts`, `integration/tokens.int.test.ts`, `integration/restart.int.test.ts`, `integration/frozen.int.test.ts` | Tests (section 10). |

### 2.2 Modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/limits.ts` | Add `MAX_TOKEN_LENGTH = 2048`, `MAX_TOKENS_PER_CHECK = 20`, `MAX_BLOCK_LIST_SIZE = 256`, `PARTICIPANT_ID_PATTERN` (lowercase UUID v4), `NAMESPACE_PATTERN` (moved from server `apps-config.ts`, re-exported there). |
| `packages/protocol/src/errors.ts` | Add `TOKEN_INVALID`, `TOKEN_EXPIRED`, `GROUP_ENDED`, `PARTICIPANT_BLOCKED`, `LEADER_CANNOT_LEAVE`. |
| `packages/protocol/src/messages.ts` / `schemas.ts` | New and changed messages (section 4). `GroupEndedReason` becomes `'ended_by_leader' \| 'leader_timeout' \| 'max_session' \| 'replaced' \| 'removed'` (`leader_disconnected` removed, Q13: still v1). |
| `packages/protocol/src/index.ts` | Export the new names. |
| `packages/protocol/test/schemas.test.ts` | New messages, bounds and patterns. |
| `apps/sync-server/src/config/env.ts` | New vars and cross-field rules (section 5.2). `TOKEN_SECRET*` are parsed by `token-secret.ts`, never stored in `ServerEnv`. |
| `apps/sync-server/src/config/apps-config.ts` | `maxSessionMinutes`, `inactivityLimitMinutes` as `LIMIT_FIELDS` with ceilings (AC4). |
| `apps/sync-server/src/apps/app-registry.ts` | `AppConfig` gains `maxSessionMinutes`, `inactivityLimitMinutes`. |
| `apps/sync-server/src/main.ts` | Parse secrets after env (ConfigError on rule failure). Log `warn token_secret_random` or `warn dev_token_secret`, never the value. Pass secrets to `createSyncServer`. |
| `apps/sync-server/src/server.ts` | Options `tokenSecrets` (required in `main`; tests default to a random per-instance secret), `scheduler?`, `refresh?`. Builds `TokenService`, `GroupTimers`, `TokenRefresher`, `EndedGroups`, `ParkingLot`; starts and stops the ended-groups sweep with the heartbeat. |
| `apps/sync-server/src/limits/constants.ts` | `TOKEN_TTL_SECONDS = 365*86400`, `TOKENS_CHECK_PER_MINUTE = 10`, `MAX_ENDED_GROUPS`, `ENDED_SWEEP_MS = 60_000`, `MIN_TOKEN_SECRET_BYTES = 32`. `transportMaxPayload` grows to make room for the block list and token (section 4.6). |
| `apps/sync-server/src/groups/session.ts` | `Session.participantId` renamed `connectionId` (it is still the `hello.ok` value). Adds `membership?: { groupId; participantId; role }` (replaces `groupId`/`role`) and `parked?`. `GroupActions` gains `resume`, `checkTokens`, `end`, `leave`, `setBlockList`; `attach` is removed. |
| `apps/sync-server/src/groups/notifier.ts` | Keyed by membership key `ns:groupId:participantId`: `register(key, s)`, `unregister(key, s)` (only if `s` still owns it), `get(key)`, `broadcast(keys, msg)`. |
| `apps/sync-server/src/groups/group-store.ts` / `in-memory-group-store.ts` | Record fields and atomic methods (section 3). |
| `apps/sync-server/src/groups/group-service.ts` | Group-scoped participant IDs; tokens on create and join; frozen instead of ended on leader disconnect; drop at zero connected; end, leave, resume, check, block list; refresher hooks. |
| `apps/sync-server/src/ws/connection.ts` | Dispatch for the new types; `hello.ok` gets `namespace`; `canCarryReqId` extended; `tokens.check` rate check; disconnect also unparks. |
| `apps/sync-server/src/ws/error-messages.ts` | Fixed text for the new codes. |
| `apps/sync-server/src/logging/logger.ts` | `REDACT_PATHS` adds `token`, `*.token`, `tokens`, `*.tokens`, `blockList`, `*.blockList`, `participantId`, `*.participantId`, `secret`, `*.secret`. |
| `apps/sync-server/test/helpers/test-server.ts`, `test-client.ts`, `failing-store.ts`, `groups.ts` | Secrets option, scheduler option, new store methods, resume helpers. |
| `apps/sync-server/test/lifecycle.int.test.ts`, `robustness.int.test.ts`, `handshake.int.test.ts`, `groups.int.test.ts`, `in-memory-group-store.test.ts`, `restart.int.test.ts`, `privacy.int.test.ts`, `env.test.ts`, `apps-config.test.ts`, `main.test.ts` | Updated for new behavior per AC42 (leader disconnect freezes; `hello.ok` has `namespace`; restart test now also recovers). |
| `compose.yaml` | `TOKEN_SECRET: <DEV_TOKEN_SECRET>` with a comment (AC3); refresh vars and ceilings at their defaults. |
| `config/apps.example.json`, `config/apps.dev.json` | Example `maxSessionMinutes` / `inactivityLimitMinutes` (example file only; dev file uses defaults). |
| `README.md` | Server: env vars, secret generation and rotation, recovery behavior, protocol summary (AC41). |
| `packages/client/src/options.ts` | `storage` option (validated: `'local'`, `'memory'`, or an object with three functions; otherwise `INVALID_OPTIONS { field: 'storage' }`). Keeps `storageHost` (URL `host`) privately. |
| `packages/client/src/url-policy.ts`, `host.ts` | `checkServerUrl` also returns `host` (WHATWG `host`: hostname plus non-default port); `UrlLike.host`; lazy `localStorageGlobal()` accessor. |
| `packages/client/src/state.ts` | Group states `active` (+ `leaderOnline`), `rejoining` (leader or member), `waiting`, `ended`; new `GroupEndedReason` values; `indicatorOf` (section 7.4); `ConnectedInfo.namespace`; new event and result types. |
| `packages/client/src/rejoin.ts` | `tokenRejoin` strategy replaces `memberRejoinByGroupId` (AC35). |
| `packages/client/src/client.ts` | Token capture and deletion, resume flows, new public methods, new server messages; the private `#endGroup` is renamed `#finishGroup`. |
| `packages/client/src/errors.ts` | `RequestKind` gains `group.resume`, `tokens.check`, `group.end`, `group.leave`, `blocklist.set`. Client codes `TOKEN_NOT_FOUND`, `BLOCK_LIST_FULL`. Server details for `RATE_LIMITED` stay fixed-key. |
| `packages/client/src/transport.ts` | `KNOWN_TYPES` adds the new server types. |
| `packages/client/src/limits.ts` | `maxInboundChars` also allows for a token and for a full `tokens.result` (section 4.6). |
| `packages/client/src/index.ts` | Export new types and methods. |
| `packages/client/README.md` | Storage, `checkTokens`, `resumeGroup`, block list, `endGroup`/`leaveGroup`, XSS caveat, multi-tab note (AC41). |
| `packages/client/test/*` (rejoin, groups, close, reconnect, state, handshake, inbound, integration groups/reconnect, ssr-import, logging, readme) | Updated per AC42. `ssr-import` also traps `localStorage`. |

No migrations: there is no database.

## 3. Data model (server memory, no persistence)

```ts
type Role = 'leader' | 'member';

interface GroupRecord {
  id: string;                    // 43-char base64url (unchanged)
  appNamespace: string;
  metadata: JsonObject;          // opaque
  position: StoredPosition;      // opaque
  leaderId: string;              // group-scoped participant ID (UUID v4)
  participantIds: string[];      // leaderId (always, connected or not) + attached members
  createdAt: number;             // epoch ms; from the token's gct on recreation
  lastActivityAt: number;        // epoch ms; leader activity (AC12)
  leaderOnline: boolean;         // false = frozen
  blockList: readonly string[];  // participant IDs; never logged
}

type AddParticipantResult =
  | { status: 'ok'; group: GroupRecord }
  | { status: 'not_found' } | { status: 'full' } | { status: 'blocked' };

interface GroupStore {
  create(group: GroupRecord): Promise<void>;                       // new random IDs
  createIfAbsent(group: GroupRecord): Promise<'created' | 'exists'>; // recreation (AC27)
  get(ns, id): Promise<GroupRecord | undefined>;
  addParticipant(ns, id, pid, maxSize): Promise<AddParticipantResult>; // checks blockList atomically
  removeParticipant(ns, id, pid): Promise<{ connected: number } | undefined>;
  setLeaderOnline(ns, id, online: boolean, at?: number): Promise<GroupRecord | undefined>;
  setPosition(ns, id, payload, at: number): Promise<boolean>;      // also sets lastActivityAt
  setBlockList(ns, id, list): Promise<{ removed: string[] } | undefined>; // removes listed members atomically
  delete(ns, id): Promise<void>;
}
```

- The leader's slot is **reserved** while it is offline: `leaderId` stays in
  `participantIds`, so members cannot fill the group and lock the leader out.
  The size check is unchanged (#1 AC21).
- `connected = (leaderOnline ? 1 : 0) + members`. When it reaches 0 the record is
  deleted ("dropped", AC22). This is not an end: nothing goes into
  `EndedGroups`.
- Still no `list` method (#1 AC20). `get` still returns shallow copies, and
  `blockList` is copied too.
- Participant IDs: `hello.ok.participantId` stays the per-connection ID
  (`connectionId`). A **group-scoped** participant ID is minted with
  `newParticipantId()` on every `group.create` and `group.join`, and is reused
  from the token on resume and recreation (AC6). This is the ID in tokens,
  block lists and `group.created/joined.participantId`.

## 4. Wire protocol (still version 1, Q13)

Unknown fields in client messages are still ignored, and the new fields are
additive. Every new request accepts `reqId?` and every direct reply echoes it.

### 4.1 Token format (AC5, AC40)

```
header  {"alg":"HS256","typ":"JWT"}          (fixed bytes, section 1.1)
payload {
  "v":    1,                // token format version (TOKEN_FORMAT_VERSION)
  "aud":  "reading-app",    // app namespace
  "gid":  "<43-char group ID>",
  "pid":  "<uuid v4>",      // group-scoped participant ID
  "role": "leader" | "member",
  "gct":  1767225600000,    // group creation time, epoch ms
  "lat":  1767226800000,    // leader's last activity at issue, epoch ms
  "iat":  1767226800,       // issued at, epoch seconds (JWT NumericDate)
  "exp":  1798762800        // iat + 31_536_000 (365 days)
}
signature HMAC-SHA256(perAppKey, header "." payload)
```

- Claim schema: `v` int; `aud` matches `NAMESPACE_PATTERN`; `gid` matches
  `GROUP_ID_PATTERN`; `pid` matches `PARTICIPANT_ID_PATTERN`; `role` enum;
  `gct`, `lat`, `iat`, `exp` non-negative safe integers; `lat >= gct`;
  `exp > iat`. A missing or wrongly typed claim is `invalid`. An unknown `v` is
  `invalid`. Unknown extra claims are ignored.
- A typical token is about 330 characters, well below the 2048 limit.
- The payload is readable by anyone holding the token. It holds no personal
  data and nothing secret (spec decision 1).
- **Item 4 (join codes):** codes go in the **recreation request**
  (`group.resume.joinCodes?`), not in the token. Codes rotate, and putting them
  in the token would force a token re-issue on every rotation. On recreation,
  item 4 re-registers the codes; if a code was taken in the meantime, the
  server issues new codes and returns them in `group.resumed.joinCodes`. Item 4
  may also add an optional claim if it needs one: unknown claims are already
  ignored and `v` stays 1 for additive claims. Nothing is implemented now
  (AC40). Item 5 (handoff) issues a new leader token through the same
  `TokenService.issue`; the "leader token whose `pid` is not the record's
  `leaderId` is invalid" rule (6.2) is where item 5 adds the demotion rule.

### 4.2 Token verification and classification (AC7, AC9)

`TokenService.verify(token, connectionNamespace, now)`:

1. `typeof token === 'string'`, length `<= 2048`, three segments with the
   base64url charset; else `invalid`.
2. Header segment byte-equal to the constant; else `invalid`.
3. HMAC with the app's current key, then its previous key, compared in
   constant time; neither matches -> `invalid`. Record `viaPrevious`.
4. Parse the payload, `checkJson` depth 4, `tokenClaimsSchema`; else `invalid`.
5. `v === 1` and `aud === connectionNamespace`; else `invalid`.
6. `exp * 1000 > now`; else `invalid` (AC7 lists an expired `exp` as invalid).

`classifyToken(claims, app, now)` then applies, in order:

| Check | Result |
| --- | --- |
| `EndedGroups.has(ns, gid)` | `ended` |
| `gct + maxSessionMinutes*60_000 <= now` | `expired` |
| leader token and `lat + inactivityLimitMinutes*60_000 + refreshMaxMs <= now` | `expired` |
| group in memory, member token, `pid` in `blockList` | `blocked` |
| group in memory, leader token, `pid !== record.leaderId` | `invalid` (item 5 hook) |
| group in memory | `live` |
| not in memory, leader token | `recoverable` |
| not in memory, member token | `waiting` |

**Member tokens skip the `lat` check.** Members are never refreshed (AC13), so
their `lat` is the issue time; applying the check would lock a member out of a
live group 25 minutes after joining. A member's validity comes from the group
being live (or recreatable by its leader) and from `gct` (AC13 wording). A
parked member is bounded separately (6.5). Listed as Q-B in section 12.

### 4.3 Client -> server (new and changed)

| type | Fields | Success reply |
| --- | --- | --- |
| `group.resume` | `token: string (<= 2048)`, `metadata?: JsonObject`, `position?: JsonValue`, `blockList?: string[] (<= 256, each PARTICIPANT_ID_PATTERN)` | Leader: `group.resumed`. Member, live: `group.joined`. Member, not in memory: `group.waiting`. |
| `tokens.check` | `tokens: string[] (1..20, each <= 2048)` | `tokens.result` |
| `group.end` | (none) | `group.ended { reason: 'ended_by_leader' }` with `reqId` |
| `group.leave` | (none) | `group.left { groupId }` |
| `blocklist.set` | `blockList: string[] (0..256, pattern)` | `blocklist.ack` |

- Schema violations (more than 20 tokens, a token over 2048 characters, a block
  list over 256 entries or with a malformed ID, a wrong type) give
  `INVALID_MESSAGE` and touch nothing (AC14, AC24).
- `group.resume` on a session that already has a membership or a parked group
  gives `ALREADY_IN_GROUP`, checked first.
- Recreation without `metadata` gives `INVALID_MESSAGE`. `metadata` and
  `position` are size-checked against `maxMessageBytes` like `group.create`
  (`MESSAGE_TOO_LARGE`), whether or not they end up used. The block list has
  its own count limit and is **not** counted against `maxMessageBytes` (AC24).

### 4.4 Server -> client (new and changed)

| type | Fields | When |
| --- | --- | --- |
| `hello.ok` | + `namespace` | Handshake (AC33) |
| `group.created` | + `token` | Create (AC5) |
| `group.joined` | + `token`, + `leaderOnline: boolean` | Join, member resume of a live group, parked member admitted (no `reqId` then) |
| `group.resumed` | `groupId`, `participantId`, `role: 'leader'`, `metadata`, `hasPosition`, `position?`, `token`, `recreated: boolean` | Leader resume (AC19, AC23) |
| `group.waiting` | `groupId` | Member resume, group not in memory (AC25) |
| `group.left` | `groupId` | Leave reply (AC30) |
| `blocklist.ack` | (none) | Block list set |
| `tokens.result` | `results: Array<{ status: TokenStatus; token?: string }>`, same order and length as the request | AC14; `token` appears only when the presented token verified with the previous secret and its status is `live`, `recoverable` or `waiting`. It is the same claims re-signed with the current secret (AC2), so it carries no new data. |
| `token.refreshed` | `groupId`, `token` | Leader refresh (AC12) |
| `leader.offline` / `leader.online` | `groupId` | To attached members (AC18, AC19) |
| `group.ended` | `groupId`, `reason`, `reqId?` | Reasons below |
| `error` | unchanged shape | New codes below |

`TokenStatus = 'live' | 'recoverable' | 'waiting' | 'blocked' | 'ended' | 'expired' | 'invalid'`.

`group.ended` reasons: `ended_by_leader` (members, plus the reply to the
leader), `leader_timeout` and `max_session` (everyone attached or parked),
`replaced` (only the older connection, AC20), `removed` (blocked members, AC26).

### 4.5 New error codes

| Code | When | `details` |
| --- | --- | --- |
| `TOKEN_INVALID` | Any verification failure, cross-app token, leader `pid` mismatch. The bytes are identical for every cause (AC8, AC15). | - |
| `TOKEN_EXPIRED` | `classifyToken` = `expired` (AC9) | - |
| `GROUP_ENDED` | `classifyToken` = `ended` (AC27, AC29) | - |
| `PARTICIPANT_BLOCKED` | Member resume with a blocked ID; parked member blocked at recreation (AC17, AC25, AC26) | - |
| `LEADER_CANNOT_LEAVE` | Leader sends `group.leave` (it must `group.end`) | - |

`RATE_LIMITED` is reused for `tokens.check` with `details { retryAfterMs }`,
and the connection stays open (AC16). Parked members that cannot be admitted
at recreation get an **unsolicited** `error` (no `reqId`) with `GROUP_FULL` or
`PARTICIPANT_BLOCKED` (AC25). A connection has at most one parked group, so
the client can tell which group it refers to (7.3). Errors never carry a group
ID, participant ID or token.

### 4.6 Frame size limits

- Server transport `maxPayload` becomes
  `max(2*MAX_MESSAGE_SIZE_CEILING + 8192 + RECOVERY_EXTRA_BYTES, TOKENS_CHECK_MAX_FRAME_BYTES)`,
  with `RECOVERY_EXTRA_BYTES = 16_384` (256 IDs x ~39 bytes, a 2048-character
  token, and slack) and `TOKENS_CHECK_MAX_FRAME_BYTES = 45_056` (20 x 2051 +
  envelope). With default ceilings this is 57 344 bytes (was 40 960).
  `MAX_BUFFERED_BYTES >= 4 * ceiling` is unchanged and still enough.
- Client `maxInboundChars(limits) = max(2*maxMessageBytes + 8192 + MAX_TOKEN_LENGTH, TOKENS_CHECK_MAX_FRAME_BYTES)`.
  `PRE_HANDSHAKE_MAX_CHARS` (8192) is unchanged: `hello.ok` grows only by the
  namespace (at most 63 characters).

### 4.7 Logging (AC10)

- Allowed: event, `namespace`, `groupRef`, `participantRef`, codes, counts,
  `status` names, `recreated` boolean, `viaPrevious` boolean.
- Never logged: tokens, raw participant IDs, block-list entries (count only),
  metadata, positions, secrets.
- Errors from `TokenService` are never thrown with input in the message;
  verification returns `{ ok: false }`. Redaction paths are extended as a second
  line of defense (2.2).

## 5. Configuration

### 5.1 Token secret (AC1-AC3, Q15)

| Variable | Rule |
| --- | --- |
| `TOKEN_SECRET` | UTF-8 byte length >= 32. In production, a missing secret, one under 32 bytes, or one equal to `DEV_TOKEN_SECRET` is a `ConfigError`. The message names `TOKEN_SECRET` and never the value. |
| `TOKEN_SECRET_PREVIOUS` | Optional, used for verification only. Same length and dev-secret rules; must differ from `TOKEN_SECRET` (`TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET`). The server never signs with it. |

Proposed environment rule (Q-A, section 12): "production" means **fail closed,
like the dev API key (#1 S4)**. A missing `TOKEN_SECRET`, or the dev secret, is
allowed only when `NODE_ENV` is exactly `development` or `test`:

- missing: a random 32-byte secret per process, plus
  `warn token_secret_random` ("tokens will not survive a restart") (AC3);
- dev secret: `warn dev_token_secret`.

With any other `NODE_ENV`, including unset and `production`, both are startup
errors. A secret that is **set but under 32 bytes** is an error in every
environment, since it can only be a mistake. `compose.yaml` sets
`NODE_ENV=development` and `TOKEN_SECRET=<DEV_TOKEN_SECRET>` so restart
recovery can be tried locally (AC3).

`DEV_TOKEN_SECRET = 'dev-only-insecure-token-secret-change-me-please'`
(public, committed, 47 bytes).

### 5.2 Env variables (new)

All are positive integers, parsed with the existing `positiveIntegerText` rules.

| Variable | Default | Rule |
| --- | --- | --- |
| `MAX_SESSION_MINUTES_CEILING` | 480 | Ceiling for app `maxSessionMinutes` |
| `INACTIVITY_LIMIT_MINUTES_CEILING` | 60 | Ceiling for app `inactivityLimitMinutes` |
| `TOKEN_REFRESH_ACTIVITIES` | 10 | N for AC12(a) |
| `TOKEN_REFRESH_MIN_SECONDS` | 60 | Must be `<= TOKEN_REFRESH_MAX_SECONDS` |
| `TOKEN_REFRESH_MAX_SECONDS` | 300 | Must be `<= 3600`; also the recovery slack (Q10) |

Fixed constants: token TTL 365 days, `MAX_TOKEN_LENGTH` 2048, 20 tokens per
check, 10 checks per connection per minute, block list 256, minimum secret 32
bytes, ended-groups cap 100 000 and sweep every 60 s.

### 5.3 Apps config (AC4)

| Field | Default | Validation |
| --- | --- | --- |
| `maxSessionMinutes` | 180 | Integer >= 1, <= `MAX_SESSION_MINUTES_CEILING`; never clamped; omitted = `min(default, ceiling)` |
| `inactivityLimitMinutes` | 20 | Integer >= 1, <= `INACTIVITY_LIMIT_MINUTES_CEILING`; same rules |

Both go into the existing `LIMIT_FIELDS` table, so error texts follow #1 AC5
(`apps[0] (namespace "x"): maxSessionMinutes 500 exceeds MAX_SESSION_MINUTES_CEILING 480`).

## 6. Server behavior

### 6.1 Group lifecycle state machine

States: **live** (leader online), **frozen** (leader offline, at least one
member attached), **dropped** (not in memory, not ended; tokens are
`recoverable`/`waiting` until AC9 expires them), **ended** (ref remembered
until its max-session deadline), **forgotten** (ref gone; tokens are `expired`
by `gct`, or a restart lost the ref, Q8).

```
                 group.create
                      │
                      v
   ┌──────────────── LIVE ──────────────────┐
   │   leader resume (newest wins, AC20)    │ group.end ──────────────> ENDED(ended_by_leader)
   │   position.update -> activity          │ max-session timer ─────> ENDED(max_session)
   └──┬──────────────────────────────┬──────┘
      │ leader socket closes,        │ leader socket closes, 0 members
      │ members > 0 (leader.offline) │ (or leader alone and leaves)
      v                              v
    FROZEN ── last member leaves ──> DROPPED ──(token limits pass)──> forgotten
      │  ^                              │
      │  └─ leader resume (leader.online)
      │                                 │ leader resume, not ended, within AC9
      │                                 v
      │                         LIVE (recreated, same ID; parked members admitted)
      ├── frozen-end timer: lastActivityAt + inactivity + refreshMax -> ENDED(leader_timeout)
      └── max-session timer: createdAt + maxSession                  -> ENDED(max_session)

ENDED: members (and the leader if attached) get group.ended; record deleted;
       EndedGroups.remember(ref, createdAt + maxSession); timers, refresher and rate limiter cleared.
```

Every transition runs under the existing per-group `KeyedLock` (`ns:groupId`).
That includes timer callbacks, which acquire the lock and then re-read the
record (the timer may be stale). Event delivery to members keeps the #1 rule:
a session is cleared and notified through `afterPending`, so a reply already
owed arrives before the event.

**Membership ownership.** The notifier's attachment map is the source of truth
for which session holds `(ns, gid, pid)`. `disconnect` and `leave` change the
store only if the session **still owns** its attachment. When a newer resume
replaces a session, the attachment is moved synchronously under the lock, so
the old socket's later disconnect is a no-op for the group (AC20).

### 6.2 Flows

**Create (AC5, AC6).** As today, plus: a new group pid; record with
`lastActivityAt = createdAt = now`, `leaderOnline = true`, `blockList = []`;
max-session timer armed; refresher `reset(now)`; reply `group.created` with a
leader token (`gct = lat = now`).

**Join by ID (#1, still temporary).** As today, plus: a new pid, a member token
(`lat = record.lastActivityAt`), and `leaderOnline` in `group.joined`. Works on
frozen groups (AC18).

**Leader disconnect (AC18, replaces #1 AC17).** If the session owns the leader
attachment: `setLeaderOnline(false)`, refresher cleared. If `connected === 0`,
the record is dropped. Otherwise members get `leader.offline` and the
frozen-end timer is armed at `min(lastActivityAt + inactivity + refreshMax,
createdAt + maxSession)`. If that time has already passed, the group ends at
once with the matching reason.

**Member disconnect / `group.leave` (AC30).** Remove the participant if the
session still owns it. At `connected === 0`, drop the record. Leaving never
blocks. A leader's `group.leave` gives `LEADER_CANNOT_LEAVE`. A parked session's
`group.leave` unparks it and replies `group.left`.

**`group.end` (AC29).** Leader only (`NOT_LEADER` for a member or a parked
session, `NOT_IN_GROUP` without a membership). Members get `group.ended
ended_by_leader`; the leader gets the same type as its reply (with `reqId`).
The record is deleted and the ref remembered until `createdAt + maxSession`.

**`group.resume`, leader token**, under the group lock (sections 4.2-4.3 give
the order):

- *Record present (live or frozen, AC19):* if another session owns the leader
  attachment, that session gets `group.ended replaced` and is detached (AC20).
  Then: `setLeaderOnline(true, now)` (an activity), `blockList` replaced by the
  request's list (members now blocked get `group.ended removed`, AC26),
  frozen-end timer cleared, members get `leader.online`, refresher
  `reset(now)`. Reply: `group.resumed { recreated: false }` with the server's
  metadata and position (Q14) and a fresh token.
- *Record absent (AC23, AC28):* `metadata` required; record built from claims
  (`id = gid`, `leaderId = pid`, `createdAt = gct`), the request's metadata,
  position and deduplicated `blockList` (the leader's own pid is ignored),
  `lastActivityAt = now`, `leaderOnline = true`. `createIfAbsent` must return
  `created` (the lock makes `exists` impossible in-process; if it happens, the
  code takes the record-present path). Max-session timer armed at `gct +
  maxSession`; refresher reset; then parked members are drained (6.5). Reply:
  `group.resumed { recreated: true }` and a fresh token.
- Two concurrent resumes with the same token serialize on the lock: the first
  recreates, the second takes the record-present path and replaces the first
  (AC27).

**`group.resume`, member token:** blocked -> `PARTICIPANT_BLOCKED`. Present ->
`addParticipant` (`full` -> `GROUP_FULL`, `blocked` -> `PARTICIPANT_BLOCKED`).
An older session owning this pid gets `replaced`. Reply `group.joined` with a
fresh member token (same `pid`, `lat = record.lastActivityAt`) (AC17).
Absent -> park (6.5) and reply `group.waiting` (AC25).

**`blocklist.set` (AC26, AC34).** Leader only. `setBlockList` atomically
replaces the list and removes listed members, who get `group.ended removed`.
Reply `blocklist.ack`. The list lives only in the record and is never logged
(count only).

**`tokens.check` (AC14-AC16).** First the per-connection limiter (10/min, 60 s
sliding window): over the limit -> `RATE_LIMITED { retryAfterMs }`. Then every
token is verified and classified, with one result per token, in order. For a
token verified with the previous secret and usable (`live`, `recoverable`,
`waiting`), `token` is the same claims re-signed (AC2). The handler does a
store `get` only for tokens that verified, so invalid tokens never touch group
state (AC15).

### 6.3 Timers (`GroupTimers`, Q2)

- **Max session** (all live and frozen groups, leader online or not): armed on
  create and recreation at `createdAt + maxSessionMinutes`. When it fires:
  end with `max_session`.
- **Frozen end:** armed on leader disconnect, cleared on leader return. When
  it fires: `leader_timeout`, or `max_session` if that comes first.
- Inactivity while the leader is online is **not** enforced (item 5). It only
  affects the leader token's `lat` check and the frozen-end time.
- Timers use the injected `Scheduler`, so tests advance a `ManualScheduler`
  instead of using fake timers (which would interfere with socket I/O, as in
  #1). Real timers are `unref()`ed and cleared on `server.close()`.

### 6.4 Token refresh (`TokenRefresher`, AC12, AC13)

Per group, while the leader is online: `{ activities, lastTokenAt, timer }`.

```
reset(at):        activities = 0; lastTokenAt = at; cancel timer        // create, leader return, recreation
activity(at):     activities += 1
                  if (activities >= N && at - lastTokenAt >= min) refresh(at)
                  else if (at - lastTokenAt >= max)              refresh(at)
                  else schedule(activities >= N ? lastTokenAt + min : lastTokenAt + max)
timer fires (t):  if (activities >= 1) refresh(t)
refresh(at):      issue leader token with lat = record.lastActivityAt; send token.refreshed
                  to the leader's attachment; reset(at)
clear():          cancel timer; delete state                            // leader offline, group end/drop
```

An "activity" is an accepted `position.update` (`setPosition(..., at)` also
updates `lastActivityAt`), a leader return, or a recreation. The last two issue
a fresh token anyway and call `reset`. Member tokens are never refreshed
(AC13).

### 6.5 Parking (Q7, AC25)

- Parking happens under the group lock and only when no record exists:
  `session.parked = { ns, gid, pid, until }`, where
  `until = min(gct + maxSession, now + inactivity + refreshMax)`. Any leader
  token able to recreate the group has `lat <= now`, so after
  `now + inactivity + refreshMax` no such token can exist any more. The bound
  is therefore safe and frees the member.
- When `until` passes: under the lock, unpark and deliver `group.ended` with
  `max_session` (if `gct + maxSession` was the bound) or `leader_timeout`.
- On recreation, `drain(ns, gid)` goes through parked sessions in arrival
  order: blocked -> `error PARTICIPANT_BLOCKED`; group full -> `error
  GROUP_FULL`; otherwise `addParticipant` and an unsolicited `group.joined`
  (fresh token, current position, `leaderOnline: true`). All are delivered
  through `afterPending`.
- A parked session's disconnect unparks it. A parked session is "in a group"
  for `ALREADY_IN_GROUP`.

## 7. Client behavior

### 7.1 Public API additions (AC31-AC39)

```ts
interface SyncClientOptions { /* ...#3 options... */ storage?: TokenStorage | 'local' | 'memory' }

type TokenStatus = 'live' | 'recoverable' | 'waiting' | 'blocked' | 'ended' | 'expired' | 'invalid';
interface StoredGroupStatus { readonly groupId: string; readonly role: Role; readonly status: TokenStatus }
interface ResumeOptions { metadata?: JsonObject; position?: JsonValue }   // leader overrides
interface ResumedGroup {
  readonly groupId: string; readonly role: Role; readonly participantId: string;
  readonly status: 'active' | 'waiting'; readonly recreated: boolean; readonly leaderOnline: boolean;
  readonly metadata?: JsonObject; readonly hasPosition: boolean; readonly position?: JsonValue;
}

checkTokens(): Promise<readonly StoredGroupStatus[]>;
resumeGroup(groupId: string, options?: ResumeOptions): Promise<ResumedGroup>;
endGroup(): Promise<void>;                      // leader
leaveGroup(): Promise<void>;                    // member (active or waiting)
getBlockList(groupId: string): Promise<readonly string[]>;
addToBlockList(groupId: string, participantIds: readonly string[]): Promise<readonly string[]>;
removeFromBlockList(groupId: string, participantIds: readonly string[]): Promise<readonly string[]>;
```

- Local checks run before anything is sent, in the #3 style:
  - `NOT_CONNECTED`; `ALREADY_IN_GROUP` / `REQUEST_IN_PROGRESS` for
    `resumeGroup`;
  - `TOKEN_NOT_FOUND` when no stored token exists for `groupId` (resume and
    block-list methods; block-list methods also need a **leader** token);
  - `NOT_IN_GROUP` / `NOT_LEADER` for end and leave;
  - `INVALID_PAYLOAD` for malformed IDs or overrides; `MESSAGE_TOO_LARGE` for
    metadata or position overrides;
  - `BLOCK_LIST_FULL { limit: 256 }` when an add would exceed 256 (AC34).
- `checkTokens()` resolves `[]` without sending when nothing is stored. It sends
  at most 20 tokens (the storage cap), maps results back by index to the
  decoded `groupId` and `role`, stores re-signed tokens, and deletes per AC31.
  One check in flight at a time (`REQUEST_IN_PROGRESS`). It is never called
  automatically (Q9).
- `resumeGroup` for a leader sends the saved metadata, latest position and
  block list (overridable). For a member it sends only the token.
- Block-list changes for the current, active leader group are sent with
  `blocklist.set` (full list) and resolve on `blocklist.ack`. Otherwise they
  are only stored and are sent with the next resume (AC34).

### 7.2 Storage document (AC33, AC34)

Key: `sync-system:v1:<namespace>@<host>` (`host` is WHATWG `URL.host`: hostname
plus non-default port; `ws`/`wss` default ports are omitted). The namespace
comes from `hello.ok` and is validated against `NAMESPACE_PATTERN` by the
schema.

```json
{ "v": 1,
  "entries": [
    { "token": "<jwt>",
      "recovery": { "metadata": {}, "hasPosition": true, "position": {}, "blockList": ["<uuid>"] } }
  ] }
```

- `entries` is an array, not an object keyed by group ID, so a `__proto__`
  group key can do nothing. `groupId`, `role`, `lat` and `exp` are decoded from
  each token (`decodeTokenClaims`) on every load; they are never stored.
- Load validation: unparsable JSON, `v !== 1` or a non-array `entries` -> the
  document is discarded. Bad entries are dropped one by one: token not
  decodable or over 2048, duplicate group (newest `iat` wins), recovery that
  fails `checkJson`, metadata that is not an object, or a block list that is
  not `<= 256` pattern-matching strings. Nothing throws (AC33). `recovery` is
  kept only for leader tokens.
- Pruning on every write: entries with `exp` passed are dropped first, then the
  oldest by `lat` until at most 20 remain (AC33).
- Position saves are coalesced: the in-memory copy is always current, and
  storage is written at most once per second (`POSITION_SAVE_INTERVAL_MS =
  1000`). The pending write is flushed on drop and on `close()`. Token,
  metadata and block-list changes are written immediately.
- Stored on: `group.created` (with metadata and initial position),
  `group.joined`, `group.resumed`, parked admission, `token.refreshed`, and
  re-signed tokens from `tokens.result`. Each replaces the group's previous
  token (AC31).
- Deleted (token, recovery and block list) on: `checkTokens` status `ended`,
  `expired`, `invalid` or `blocked`; resume errors `TOKEN_INVALID`,
  `TOKEN_EXPIRED`, `GROUP_ENDED` and `PARTICIPANT_BLOCKED` (including the
  unsolicited one while waiting); every `group.ended` **except `replaced`**
  (Q-C, section 12: another tab or device now holds the same identity); and
  after `endGroup()` / `leaveGroup()` succeed. `GROUP_FULL` keeps the token
  (it may be temporary). `close()` keeps tokens (resume later).

### 7.3 Rejoin and recovery (AC35, AC36)

`tokenRejoin` replaces `memberRejoinByGroupId` at the `RejoinStrategy` seam:

- `onDisconnected(active group, leader or member)` -> `rejoining` (role kept,
  last metadata and position kept). `waiting` -> `rejoining` (member).
- `onReady` (after `hello.ok` following an **unexpected** drop): reads the
  stored token for the group (cache first) and sends `group.resume`. A leader
  includes its saved metadata, latest position and block list.
  - `group.resumed` -> `active` leader; throttle restarted; the server's
    position is adopted and saved (Q14); `rejoined` event.
  - `group.joined` -> `active` member (`leaderOnline` from the frame);
    `rejoined` event.
  - `group.waiting` -> `waiting`.
  - `TOKEN_*`, `GROUP_ENDED`, `PARTICIPANT_BLOCKED` -> token deleted, group
    `ended { reason: 'rejoin_failed', code }`.
  - `GROUP_FULL`, `REQUEST_TIMEOUT` or another server code -> `ended
    rejoin_failed` with the token kept.
  - Connection lost again -> stays `rejoining`; the next reconnect retries.
  - No stored token -> `ended rejoin_failed` with `TOKEN_NOT_FOUND`.
- While `waiting`:
  - an unsolicited `group.joined` for that group -> `active` plus `rejoined`;
  - an unsolicited `error` (no `reqId`) `PARTICIPANT_BLOCKED` or `GROUP_FULL`
    -> `ended rejoin_failed` (blocked deletes the token);
  - `group.ended` -> `ended` with the server's reason.
- Members: `leader.offline` / `leader.online` update `active.leaderOnline` and
  emit `leaderStatus { groupId, online }`.
- Every async storage `await` inside these flows re-checks the lifecycle
  generation and the current transport (the #3 AC28 pattern), so a `close()`
  or `connect()` from a listener during a storage read never sends on a stale
  socket.

### 7.4 State and indicator (AC36)

```ts
type GroupState =
  | { status: 'active'; groupId; role: 'leader' | 'member'; metadata: JsonObject; hasPosition; position; leaderOnline: boolean }
  | { status: 'rejoining'; groupId; role: 'leader' | 'member'; metadata: JsonObject | null; hasPosition; position }
  | { status: 'waiting'; groupId; role: 'member' }
  | { status: 'ended'; groupId; reason: GroupEndedReason; code?: ClientErrorCode };
type GroupEndedReason =
  'ended_by_leader' | 'leader_timeout' | 'max_session' | 'replaced' | 'removed' | 'left' | 'rejoin_failed' | 'closed';
```

`active.metadata` is now the group's metadata for a leader too (in #3 it was
`null`): the leader needs it for recovery.

`indicatorOf`:

| Snapshot | Indicator |
| --- | --- |
| no group, or `ended` (any reason) | `none` |
| connecting / reconnecting with `active`, `rejoining` or `waiting` | `reconnecting` |
| connected + `rejoining` | `reconnecting` |
| connected + `waiting` | `leader_offline` |
| connected + `active` member, `leaderOnline: false` | `leader_offline` |
| connected + `active` member, `leaderOnline: true` | `following` |
| connected + `active` leader | `leading` |

In #3 an ended group showed `leader_offline`, because a leader drop ended the
group. Now a leader drop is shown as `active` with `leaderOnline: false`, and
`ended` means the session is really over, so it maps to `none`.

### 7.5 Client logging (AC39)

- New events: `token_stored`, `token_deleted { count }`,
  `storage_unavailable { name }`, `storage_error { op, name }`,
  `tokens_checked { count }`, `group_resumed { role, recreated }`,
  `group_waiting`, `leader_status { online }`.
- Never logged and never in errors: tokens, participant IDs, group IDs, block
  lists, metadata, positions, storage keys (the key contains the namespace and
  host, which are not secret, but it isn't needed in logs).
- `SyncClientError` details for the new codes are fixed-key numbers only
  (`BLOCK_LIST_FULL { limit }`).

## 8. Security-sensitive areas

Security-sensitive: yes

| Area | Where | Notes |
| --- | --- | --- |
| Token signing and verification (crypto) | `apps/sync-server/src/tokens/*` | In-house HS256; fixed header; constant-time compare; HKDF per-app keys (1.1, 1.2) |
| Secret configuration | `config/token-secret.ts`, `main.ts`, `compose.yaml`, README | Production refusal, dev secret, rotation, never logged (5.1) |
| Authentication / authorization of group actions | `groups/resume.ts`, `group-service.ts` | Tokens become bearer credentials for group identity and leadership; leader-only `group.end` and `blocklist.set`; blocked-ID enforcement |
| New endpoints accepting user input | `group.resume`, `tokens.check`, `group.end`, `group.leave`, `blocklist.set` | Bounded schemas, rate limit on `tokens.check`, size limits, depth limits |
| Enumeration and oracles | `tokens.check`, resume errors | Identical `invalid` / `TOKEN_INVALID` for every verification failure; no store access for invalid tokens; no listing (AC15) |
| Data about users (pseudonymous IDs, possibly minors) | logs, errors, memory | Participant IDs, tokens and block lists never logged; ended refs hashed; nothing on disk (AC10, AC11) |
| Client-side credential storage | `packages/client/src/storage.ts`, `token-store.ts` | `localStorage` is readable by XSS (documented); pluggable store; defensive parsing of stored data |
| DoS surfaces | parking, ended memory, block lists, larger transport frames, timers | All bounded (1.3, 4.6) |
| Dependencies | none added | AC43 |

A security plan review (`security.md`) is expected before Gate 2 approval;
its findings will be folded in as a revision.

## 9. Risks and edge cases

- **Tokens are bearer credentials.** Whoever holds a leader token can take the
  lead back (newest resume wins) until the group ends or the token's limits
  pass. Mitigations: `wss://` (#3 M2), tokens never logged, short
  recoverability (inactivity 20 min + 5 min slack), and `group.end` deletes the
  token. Revocation lists are out of scope.
- **XSS reads `localStorage`** (Q11 accepted). Documented in the client README,
  with the storage option as the way out (for example `sessionStorage` or
  memory).
- **Join by group ID mints a new identity.** Until join codes (item 4), a
  blocked member can rejoin by group ID with a new participant ID. The block
  list binds token identities only. Documented; item 4 closes it.
- **Ended-group memory is process-local** (Q8 accepted). After a restart, a
  leftover leader token could recreate an ended group; the leader's client
  deletes its token on end. The 100 000-entry cap evicts the oldest refs early
  under a create/end flood, with the same accepted consequence.
- **An idle online leader freezes into an immediate end.** If the leader was
  inactive for longer than inactivity + slack and then drops, the frozen-end
  time has already passed and the group ends with `leader_timeout` at once.
  Item 5's keep-alive prompt produces the activity that prevents this.
  Consistent with Q2.
- **Multi-tab.** Two tabs of the same app share one storage document.
  Read-merge-write limits lost updates; a resume from tab B replaces tab A
  (`replaced`, token kept). Async custom stores can still race; documented.
- **Clock jumps.** All token times are server times. A server whose clock
  moves backward accepts tokens a little longer, and one that moves forward
  expires them early. NTP is assumed (README note).
- **Secret rotation.** Rotation needs no downtime: tokens signed with the
  previous secret keep working and are re-signed on `tokens.check`, resume and
  refresh. Remove `TOKEN_SECRET_PREVIOUS` after `MAX_SESSION_MINUTES_CEILING` +
  `TOKEN_REFRESH_MAX_SECONDS` (8 h 5 min by default); after that, tokens signed
  with the old secret are `expired` by `gct` anyway.
- **Unsolicited errors while waiting.** The client links them to its single
  parked group. Without a `reqId` they could in theory be confused with another
  unsolicited error, but the client always sends a `reqId`, and the server only
  omits it for these AC25 cases and for errors on frames that had none.
- **Restart test fidelity.** AC23 has both an in-process restart (new server
  instance, new store, same secret) and a child-process restart test
  (`tsx src/index.ts` started twice with the same `TOKEN_SECRET`).
- **Larger transport frames** (57 KB default, was 41 KB): small memory increase
  per in-flight frame; still bounded by the queue cap (32) and connection caps.

## 10. Test plan (every AC)

Conventions follow #1 and #3: unit tests are pure; server integration tests use
`startTestServer` on port 0 with a `ManualScheduler` for timers; client tests
use the fake socket and fake timers, plus integration against the real
in-process server. Every test file keeps the unhandled-rejection guard
(`test/setup.ts`).

| AC | How verified | Where |
| --- | --- | --- |
| AC1 | `parseTokenSecrets` with `NODE_ENV=production`: missing, 31 bytes, dev secret -> `ConfigError` naming `TOKEN_SECRET`, message contains no secret. 32 bytes OK. `run()` returns exit 1 with `Config error:`; child-process check of stderr. Also the Q-A rule for unset and `staging`. | `token-secret.test.ts`, `main.test.ts` |
| AC2 | Previous: same rules; equal to current -> error. Token signed with previous verifies (`viaPrevious`); the server never signs with it (decode the issued token's signature against both keys). `tokens.check` and `group.resume` return a current-secret token for it. | `token-secret.test.ts`, `token-service.test.ts`, `tokens-check.int.test.ts`, `resume.int.test.ts` |
| AC3 | `NODE_ENV=development`/`test` and no secret: starts, `warn token_secret_random`; two instances cannot verify each other's tokens. `compose.yaml` sets `TOKEN_SECRET` equal to `DEV_TOKEN_SECRET` (regex test). | `token-secret.test.ts`, `main.test.ts`, `repo-hygiene.test.ts` |
| AC4 | Defaults 180 and 20; above ceiling -> error naming field and ceiling; at ceiling OK; omitted = `min(default, ceiling)`; new env vars validated (positive integer, `min <= max`, `max <= 3600`). | `apps-config.test.ts`, `env.test.ts` |
| AC5 | Create and join replies carry tokens; verified claims have all fields; `exp - iat === 31_536_000`; role correct. | `tokens.int.test.ts`, `token-service.test.ts` |
| AC6 | Token `pid` equals `group.created/joined.participantId`, and is unchanged after resume (live), recreation and parked admission. | `tokens.int.test.ts`, `resume.int.test.ts`, `recreate.int.test.ts` |
| AC7 | Forged tokens: `alg:none`, HS512, RS256 header, extra `kid`, reordered header, bad signature, signature of 31 bytes, wrong key, missing or wrongly typed claim (each claim), `v: 2`, expired `exp`, 2049 characters, invalid charset, 2 or 4 segments, aud mismatch -> all `invalid` / `TOKEN_INVALID`. The response contains no token substring. RFC 7515 A.1 vector for HMAC. Unknown extra claim accepted. | `jwt.test.ts`, `token-service.test.ts`, `resume.int.test.ts` |
| AC8 | App A token on app B: `tokens.check` result and resume error deep-equal to those for a random string and for a garbage JWT (except `reqId`). HKDF keys differ per namespace. | `tokens-check.int.test.ts`, `token-keys.test.ts` |
| AC9 | ManualScheduler: leader token at `gct + maxSession` -> `expired`; leader `lat + inactivity + refreshMax` -> `expired`, one ms earlier -> not; member token with old `lat` on a live group -> `live`; resume of an expired token -> `TOKEN_EXPIRED`, no group created. | `resume.int.test.ts`, `tokens-check.int.test.ts` |
| AC10 | Log capture at `trace` with sentinels for issue, check (all statuses), resume, recreation, refresh, rejection, block list and park paths. No token, its segments, raw pid, block-list entry, metadata or position sentinel appears in logs or in any `error` frame. | `token-privacy.int.test.ts` |
| AC11 | Static test: only `config/apps-config.ts` imports `node:fs` in `apps/sync-server/src`, and no `writeFile`/`appendFile`/`createWriteStream` appears. Restart test: a new instance holds no groups until a leader resumes. | `no-disk.test.ts`, `recreate.int.test.ts` |
| AC12 | `TokenRefresher` with ManualScheduler: no refresh before min even after N activities; refresh at N and min; refresh at max after one activity (timer-driven, no further activity); no refresh without activity; reset on leader return and recreation. Integration: `token.refreshed` has new `lat`, `iat`, `exp` and the other claims unchanged. | `token-refresher.test.ts`, `refresh.int.test.ts` |
| AC13 | Members never get `token.refreshed` across many leader updates and timer advances. | `refresh.int.test.ts` |
| AC14 | Check 7 tokens covering all 7 statuses, in order; 21 tokens -> `INVALID_MESSAGE`; results carry only `status` (and the AC2 `token`). | `tokens-check.int.test.ts`, `schemas.test.ts` |
| AC15 | Invalid token naming a live group's ID (claims copied, wrong signature) -> `invalid`, deep-equal to a random string's result; a store spy shows no `get` for invalid tokens; no `group.list`-like message exists. | `tokens-check.int.test.ts` |
| AC16 | 10 checks OK, 11th -> `RATE_LIMITED { retryAfterMs }` and the socket stays open; after advancing 60 s, OK again; another connection unaffected. | `tokens-check.int.test.ts` |
| AC17 | Member drops, resumes with token -> `group.joined` (+ metadata, position or `hasPosition: false`, fresh token); full group -> `GROUP_FULL`; blocked ID -> `PARTICIPANT_BLOCKED`. | `resume.int.test.ts` |
| AC18 | Leader socket closes -> members get `leader.offline`, stay in the group, receive no positions; a new member can join and another can resume (`leaderOnline: false`). | `frozen.int.test.ts` |
| AC19 | Leader resumes on a new socket -> `group.resumed` with the server's position (the leader sent a different one), metadata and a fresh token; members get `leader.online`; the next update is relayed. | `frozen.int.test.ts` |
| AC20 | Second resume with the same leader or member token while the first socket is open -> the first gets `group.ended replaced` and is detached; the group goes on for others; the first socket closing later does not remove the participant. | `resume.int.test.ts` |
| AC21 | Frozen group, advance to `lat + inactivity + refreshMax` -> `group.ended leader_timeout`; separately, `max_session` when it comes first; both remembered as ended. Client: token deleted on receipt. | `frozen.int.test.ts`, `group-timers.test.ts`, `client.tokens.test.ts` |
| AC22 | Last participant leaves (frozen group's last member; leader alone disconnects) -> store empty, `EndedGroups` empty, `tokens.check` gives `recoverable` / `waiting`. | `frozen.int.test.ts` |
| AC23 | In-process: create, join, update, close server, new server with the same secret, leader resumes (`recreated: true`, same group ID, `gct`, `pid`), member resumes, member receives the leader's next position. Child-process variant with `TOKEN_SECRET`. Client integration with real server restart. | `recreate.int.test.ts`, `restart-process.int.test.ts`, `integration/restart.int.test.ts` |
| AC24 | Recreation without metadata -> `INVALID_MESSAGE`; oversized metadata -> `MESSAGE_TOO_LARGE`; 257 IDs or a malformed ID -> `INVALID_MESSAGE`; 256 IDs plus metadata and position at `maxMessageBytes` each fit the transport frame and are accepted. | `recreate.int.test.ts`, `schemas.test.ts` |
| AC25 | Members resume before the leader -> `group.waiting`; the leader recreates -> members get unsolicited `group.joined` with position and token; over size -> `GROUP_FULL`; blocked -> `PARTICIPANT_BLOCKED`; a second resume while parked -> `ALREADY_IN_GROUP`; park expiry -> `group.ended`. | `parking.int.test.ts`, `parking-lot.test.ts` |
| AC26 | Block list on recreation and on leader return removes attached (`removed`) and parked (`PARTICIPANT_BLOCKED`) blocked members; later resumes -> `PARTICIPANT_BLOCKED`; check -> `blocked`; `blocklist.set` while live does the same; the leader's own pid is ignored. | `blocklist.int.test.ts` |
| AC27 | `group.end`, then resume with the old leader token -> `GROUP_ENDED`; two concurrent resumes with one leader token -> one record, the first socket replaced; a lock-order test with a deferred store. | `recreate.int.test.ts`, `end-leave.int.test.ts` |
| AC28 | Leader alone disconnects (dropped), later resume within the window -> recreated exactly as AC23. | `recreate.int.test.ts` |
| AC29 | `group.end`: members get `ended_by_leader`, the leader gets the reply, store empty, `EndedGroups.has` true until the max-session deadline then swept; a member sending it -> `NOT_LEADER`. | `end-leave.int.test.ts`, `ended-groups.test.ts` |
| AC30 | `group.leave`: member removed, leader unaffected, `group.left` reply; resume afterwards works (not blocked); leader leave -> `LEADER_CANNOT_LEAVE`. | `end-leave.int.test.ts` |
| AC31 | Client stores on create, join, resume, refresh and parked admission (replace per group); deletes on each listed status, error and `group.ended` (not `replaced`), and after `endGroup` / `leaveGroup`; keeps on `close()` and `GROUP_FULL`. | `client.tokens.test.ts`, `token-store.test.ts` |
| AC32 | Default `localStorage` used when present; looked up lazily (trap getter: 0 reads at import and construction, ssr-import also checks dist); a throwing getter or `setItem` -> memory plus a warn with the name only; `'memory'` and a custom async store work; invalid option -> `INVALID_OPTIONS { field: 'storage' }`. | `storage.test.ts`, `ssr-import.test.ts`, `options.test.ts` |
| AC33 | Key format (with and without port, `wss` default port omitted); corrupt JSON, wrong `v`, `entries` not an array, bad entries, `__proto__` content -> discarded without throwing; 21 entries -> expired dropped first, then oldest `lat`. `hello.ok.namespace` validated. | `token-store.test.ts`, `client.handshake.test.ts`, `handshake.int.test.ts` |
| AC34 | Recovery data stored for leaders and survives a new client instance with the same storage; positions coalesced to 1 write per second; block list add/remove/get; 257th ID -> `BLOCK_LIST_FULL`; change while live sends `blocklist.set` and resolves on ack. | `token-store.test.ts`, `client.blocklist.test.ts` |
| AC35 | Unexpected drop: leader and member auto-resume with the stored token; leader frame includes metadata, latest position and block list; `memberRejoinByGroupId` removed. | `client.rejoin.test.ts` (rewritten), `integration/reconnect.int.test.ts` |
| AC36 | State transitions `active` -> `rejoining` -> `active`/`waiting`; `leaderOnline` toggles; `indicatorOf` table (7.4), every row. | `state.test.ts`, `client.resume.test.ts`, `integration/frozen.int.test.ts` |
| AC37 | `checkTokens()` returns `{ groupId, role, status }` per stored token, deletes per AC31, stores re-signed tokens, resolves `[]` without sending when empty, is never sent on `connect()` (frame log), `REQUEST_IN_PROGRESS` for a concurrent call. | `client.tokens.test.ts`, `integration/tokens.int.test.ts` |
| AC38 | `resumeGroup` leader (with and without overrides) and member (`active` and `waiting`); `TOKEN_NOT_FOUND`; `endGroup` / `leaveGroup` happy paths and local errors. | `client.resume.test.ts` |
| AC39 | A recording logger plus every error's `message`, `details` and `serverMessage` across all new flows: no token, pid, group ID, block-list entry, metadata or position. | `logging.test.ts`, `client.tokens.test.ts` |
| AC40 | Unknown extra claim verifies; `v` claim required; section 4.1 documents item 4's placement and the collision rule. | `token-service.test.ts`, review |
| AC41 | README sections reviewed against sections 4-5; client `readme.test.ts` asserts the new headings and the XSS caveat; server README contains `openssl rand -base64 32` and the rotation steps. | review, `readme.test.ts` |
| AC42 | `lifecycle.int`, `robustness.int`, `handshake.int`, client `rejoin`/`groups`/`close`/`reconnect`/`state` tests updated to the new behavior; all other existing tests pass unchanged. | CI |
| AC43 | `pnpm lint`, `typecheck`, `test`, `build`, `pnpm audit --audit-level=high` exit 0; lockfile unchanged except workspace edits (no new dependency); client keeps no Node-only runtime dependency (the no-DOM/no-Node build typecheck from #3). | CI |

Extra robustness tests (keep #1 H4 and #3 L6 guarantees): a timer firing for a
group already ended or dropped is a no-op; a resume racing a disconnect under a
deferred-store helper; `server.close()` cancels every timer (ManualScheduler
has none left); no unhandled rejections from timer callbacks (the setup hook).

## 11. Implementation chunks (planned commits)

Every commit leaves `pnpm lint/typecheck/test/build` green, carries its tests,
and ends with the `Refs: #5` trailer. When a protocol change alters a server
message the client parses, the same commit updates the client's types and test
fixtures (a type-level change only; client behavior lands in commits 19-23).

1. `feat(protocol): add token claims schema and token limits`
   (tokens.ts, limits, PARTICIPANT_ID_PATTERN, NAMESPACE_PATTERN; AC7/AC40 decode side)
2. `feat(config): load token secrets with production checks`
   (token-secret.ts, main.ts warnings, compose dev secret; AC1-AC3)
3. `feat(config): add session and inactivity limits to apps config`
   (apps-config, env ceilings, refresh env vars; AC4)
4. `feat(server): add hs256 token signing with per-app keys`
   (jwt.ts, token-keys.ts, token-service.ts; AC5 format, AC7, AC8 unit)
5. `feat(server): add injectable scheduler for group timers`
   (scheduler.ts, ManualScheduler helper)
6. `refactor(server): key sessions and notifier by group membership`
   (connectionId, membership, group-scoped pids, owner-checked detach; no behavior change besides new pids)
7. `feat(server): issue participant tokens on create and join`
   (protocol `token` fields and `hello.ok.namespace`; AC5, AC6, AC33 server side)
8. `feat(server): freeze groups when the leader disconnects`
   (store fields, leader.offline, drop at zero, frozen-end timer; AC18, AC21, AC22; lifecycle tests updated)
9. `feat(server): end groups at max session time` (GroupTimers max-session; AC21)
10. `feat(server): add group end and leave with ended-group memory`
    (EndedGroups, group.end, group.left, LEADER_CANNOT_LEAVE; AC29, AC30)
11. `feat(server): resume live groups with participant tokens`
    (group.resume live paths, replaced, token errors; AC9, AC17, AC19, AC20)
12. `feat(server): recreate groups from leader tokens`
    (createIfAbsent, recovery fields, transport payload size; AC23, AC24, AC27, AC28)
13. `feat(server): park members until their leader recreates the group`
    (ParkingLot, group.waiting, park expiry; AC25)
14. `feat(server): enforce leader block lists`
    (setBlockList, blocklist.set, removal on return and recreation; AC26)
15. `feat(server): refresh leader tokens on activity` (TokenRefresher, token.refreshed; AC12, AC13)
16. `feat(server): add rate-limited tokens.check` (classification, re-sign; AC2, AC14-AC16)
17. `test(server): verify tokens never reach logs or disk` (redact paths, privacy and static tests; AC10, AC11)
18. `test(server): recover groups across a server process restart` (child-process test; AC23)
19. `feat(client): add pluggable token storage` (storage.ts, option, lazy localStorage; AC32)
20. `feat(client): store tokens and recovery data per server and app`
    (token-store.ts, capture on create/join/refresh; AC31 storage, AC33, AC34 data)
21. `feat(client): resume groups with stored tokens after a drop`
    (tokenRejoin, waiting, leader status, indicator; AC35, AC36; rejoin tests rewritten)
22. `feat(client): add checkTokens, resumeGroup, endGroup and leaveGroup` (AC31 deletions, AC37, AC38)
23. `feat(client): manage leader block lists` (AC34 API, blocklist.set)
24. `test(client): cover token recovery against the real server` (restart, frozen, tokens; AC23, AC39)
25. `docs: document tokens, secrets, rotation and recovery` (both READMEs; AC41)

## 12. Questions for Gate 2

- **Q-A (AC1/AC3 vs #1 S4). Which environments allow a missing secret or the
  dev secret?** Proposed: fail closed like the dev API key. A missing
  `TOKEN_SECRET` or the dev secret is allowed only when `NODE_ENV` is exactly
  `development` or `test`; unset or any other value is a startup error, and a
  set-but-short secret is an error everywhere. This is stricter than the AC
  wording ("outside production"), and consistent with the decision made after
  #1's security review. Alternative: literal AC wording (only
  `NODE_ENV=production` refuses).
- **Q-B (AC9 vs AC13). Member tokens and the `lat` check.** Proposed: the
  `lat + inactivity + slack` check applies to leader tokens only. Member tokens
  are checked by `gct` (max session) and group liveness, and parked members are
  released after `inactivity + slack` (6.5). Applying AC9's `lat` rule to
  members would lock a member out of a live group 25 minutes after joining,
  because member tokens are never refreshed.
- **Q-C (AC31). `group.ended` with reason `replaced`.** Proposed: the client
  keeps the token, because the newer tab or device holds the same identity, and
  with shared `localStorage` deleting it would wipe the newer tab's token. All
  other `group.ended` reasons delete it as specified.
- **Q-D. Leader `group.leave`.** Proposed: rejected with the new
  `LEADER_CANNOT_LEAVE` (the leader uses `group.end`). Alternative: treat it as
  a voluntary disconnect (freeze).
- **Q-E (AC36). Indicator for an ended group.** Proposed: `none`. In #3 an
  ended group showed `leader_offline` because a leader drop ended the group.
  Now that state is `active` with `leaderOnline: false`.
- Informational (no decision needed unless you object):
  - `hello.ok.participantId` stays the per-connection ID. The group-scoped ID
    in tokens is minted per membership and returned in
    `group.created/joined/resumed`.
  - Per-app HKDF signing keys (1.2).
  - No new dependencies (1.1).
  - `leader_disconnected` is removed from the protocol's `GroupEndedReason`
    (Q13 keeps v1; nothing is released).

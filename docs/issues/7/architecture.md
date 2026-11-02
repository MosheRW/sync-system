# Architecture: #7 Harden token recovery (follow-up to #5)

Spec: `docs/issues/7/spec.md` (AC1-AC25). Path: fast. Branch: `fix/7-token-recovery-hardening`.
Gate 1 decisions D1-D4 are taken as given and not reopened here.

No new dependencies, no protocol change, no env var, no data model change
(there is no database; group state is in memory and the client store format
`v: 1` is unchanged).

## 1. Approach

Eight small, independent fixes. Each planned commit keeps `pnpm lint`,
`typecheck` and `test` green on its own (tests ship with the code they cover).

### L1: required token secrets (AC1-AC3)
- `SyncServerOptions.tokenSecrets` becomes required (`tokenSecrets: TokenSecrets`).
- `createSyncServer` validates at runtime, before creating anything: if
  `options.tokenSecrets` is missing, or `current` is not a `Buffer` of at least
  `MIN_TOKEN_SECRET_BYTES` (32), it throws `ConfigError('tokenSecrets is required: pass the secrets from parseTokenSecrets()')`.
  The message names the field only, never a value. The random fallback and the
  `randomBytes` import leave `server.ts`.
- The random per-process secret moves into the test helpers:
  `apps/sync-server/test/helpers/test-server.ts` (`rest.tokenSecrets ?? { current: randomBytes(32), source: 'random' }`)
  and `packages/client/test/helpers/real-server.ts` (same default). Tests that
  already pass their own secrets are unchanged.
- `main.ts` already passes `parseTokenSecrets()` output: no change, so the Q-A
  rule and its tests are untouched.
- Rejected: keeping the option optional with a warning (still lets a new entry
  point skip Q-A silently).

### A1: per-action error texts (AC19-AC21)
- `apps/sync-server/src/ws/error-messages.ts` gets a fixed table keyed by code and action:

  | Code | Action key | Text |
  |------|------------|------|
  | `RATE_LIMITED` | `position.update` | `Too many position updates` (unchanged) |
  | `RATE_LIMITED` | `tokens.check` | `Too many token checks` |
  | `NOT_LEADER` | `position.update` | `Only the leader can update the position` (unchanged) |
  | `NOT_LEADER` | `group.end` | `Only the leader can end the group` |
  | `NOT_LEADER` | `blocklist.set` | `Only the leader can set the block list` |

  New export `actionErrorMessage(code, action, { reqId?, details? })`, typed so
  `action` must be a key of that code's row set (`as const` table, no free
  strings). `RATE_LIMITED` and `NOT_LEADER` are removed from the generic
  `ERROR_TEXT` table, and `errorMessage()` takes `Exclude<ErrorCode, ActionErrorCode>`,
  so the compiler rejects any future call that sends these codes without
  naming its action (covers the AC21 "any other path" rule). The handshake
  result `code` type in `ws/handshake.ts` is narrowed the same way (it never
  returns these codes).
- `group-service.ts`: the 5 `NOT_LEADER` sites (update, end x2 incl. parked,
  setBlockList x2 incl. parked) and the 2 `RATE_LIMITED` sites use
  `actionErrorMessage`. Codes, `details` and `reqId` handling are unchanged.
- Texts stay fixed: no received value is ever interpolated (AC20).
- Client package (`packages/client/src/errors.ts`) keeps its own local texts;
  it is out of scope (see section 5).

### L2: per-app tokens.check budget (AC4-AC6)
- `limits/constants.ts`: `TOKENS_CHECK_PER_APP_PER_MINUTE = 600` (fixed, D1).
- `GroupService` gets a second `SlidingWindowRateLimiter` (`appCheckLimiter`,
  window `TOKENS_CHECK_WINDOW_MS`) keyed by `app.namespace`.
- Order in `checkTokens`: per-connection limiter first, then per-app limiter,
  then verification. Per-connection first is deliberate: the limiter records
  only accepted events, so a connection over its own limit can never spend the
  app's shared budget (otherwise one socket at the inbound rate, about
  1200/min, could drain the 600/min budget for everyone). The cost is that a
  check refused by the app budget still uses one of that connection's 10, which
  is harmless.
- Over budget: `actionErrorMessage('RATE_LIMITED', 'tokens.check', { details: { retryAfterMs } })`,
  returned before any `verify()` / HMAC or store access (AC5).
- `SlidingWindowRateLimiter.clear()` (new) empties all keys; `GroupService.close()`
  calls `checkLimiter.clear()` and `appCheckLimiter.clear()`. The limiter has
  no timers, so ManualScheduler pending stays 0 (AC6). No new log events; the
  existing `tokens_checked` debug log keeps only namespace and count.
- Memory: at most 600 timestamps per registered app; apps are a fixed set.
- Rejected: global budget (D1); token bucket (the sliding window already exists
  and gives an exact `retryAfterMs`).

### L3: inbound queued-bytes cap (AC7-AC9)
- `limits/constants.ts`: `INBOUND_QUEUE_PAYLOAD_FACTOR = 4` and
  `maxQueuedInboundBytes(ceiling) = INBOUND_QUEUE_PAYLOAD_FACTOR * transportMaxPayload(ceiling)`
  (229 376 bytes at defaults). Not configurable (D2).
- `ConnectionDeps` gets `maxQueuedBytes: number`; `server.ts` passes
  `maxQueuedInboundBytes(env.maxMessageSizeCeiling)`.
- `Connection.onMessage`: compute the frame size (`rawByteLength(data)` helper
  for `Buffer | ArrayBuffer | Buffer[]`). If `!limiter.take() || queueLength >= MAX_QUEUED_MESSAGES || queuedBytes + size > maxQueuedBytes`
  then `closeFlooded()` (same `TOO_MANY_MESSAGES` error and close 4008 as the
  message-count overflow, AC8). Otherwise `queuedBytes += size`, released in
  the same `finally` as `queueLength`. As today, the message being processed
  still counts until it finishes.
- A single legal frame is at most `maxPayload`, so it always fits an empty queue.
- Outbound side, `MAX_BUFFERED_BYTES` default and its validation are untouched (AC9).

### L4: resume timeout is not a stable connection (AC10-AC13)
- `packages/client/src/client.ts`, `#connectionLost`: the stability reset
  (`streakAfterDrop(...) === 0` -> streak and `#runAttempts` to 0) is skipped
  when the drop is the automatic/explicit resume timing out on the client:
  `error.code === 'REQUEST_TIMEOUT' && error.request === 'group.resume' && error.source === 'client'`
  (small private predicate `#isResumeTimeout(error)`). The drop still grows the
  streak and counts toward `maxAttempts` as any failure does.
- Nothing else changes (D3): no give-up-after-N rule, no option validation,
  the token is kept (`#giveUp` never deletes tokens today; AC12 is a test).
- A successful resume, or a drop after `stableAfterMs` for any other reason,
  resets exactly as today (AC13).
- Rejected: measuring stability from resume success (changes AC13 "as today"
  semantics and touches more code).

### L5: cross-tab safety of the token store (AC14-AC18)
`packages/client/src/token-store.ts`:
- `#dirty: Set<string>` becomes `#dirty: Map<string, DirtyMark>` where
  `DirtyMark = { storedToken: string | undefined; storedIat: number | undefined }`
  is the group's **raw stored** entry (from storage, not the merged view) at
  the moment the write failed. Comparison is by token string, not object
  identity (this also resolves A5 as a side effect).
- `#read()` returns both the raw stored entries and the merged view. For each
  dirty group `g` with raw stored entry `S` and in-memory entry `M`:
  1. `S?.token === mark.storedToken` (unchanged, incl. both absent): memory wins (today's behaviour).
  2. mark had a token and `S` is absent (another tab ran `forgetGroup` / `forgetAllGroups`): storage wins (absent), mark dropped.
  3. `S.iat > max(M?.iat, mark.storedIat)` (another tab stored a newer token): storage wins, mark dropped.
  4. Otherwise (changed, but not newer): memory wins.
- `#write(raw, next)` marks failures against the raw stored entries.
- `removeAll()` failure (AC17): after the failed `removeItem`, read the raw
  stored document (best effort) and mark **every** group found there and in
  memory as dirty with its stored token, so the next successful write leaves
  them out unless another tab changed them (rule 2/3). If that read fails too,
  fall back to marking the in-memory groups (today's behaviour), logged by
  error name only.
- Known residual limit (documented, AC18): a token tab A stored for a group
  that had no stored entry, whose write failed, can be written back after
  another tab's `forgetAllGroups` (no tombstones; storing them would change the
  document format). No `storage` event listener (out of scope).
- `packages/client/README.md` (Token storage section): call `forgetAllGroups()`
  with the app's other tabs closed; explain the remaining cross-tab limits
  (last writer wins outside the dirty rules, the residual case above, no live sync).

### A3: frozen member resume test (AC22-AC23)
Test only, in `apps/sync-server/test/frozen.int.test.ts`: leader creates and
sets a position, member joins; leader terminates (group frozen); member
terminates and resumes with its token while the leader is offline -> same
participant ID, same position, `leaderOnline: false`. Leader resumes ->
server position wins (Q14), member gets `leader.online`, then a new leader
update reaches the member as `position.updated`.

### A4: upgrade note (AC24)
Root `README.md`: new "Upgrading" subsection under "Sync server": since #5
the server refuses to start with `MAX_BUFFERED_BYTES` below 45056 (earlier
versions accepted e.g. 32768); fix by unsetting it (default 262144) or setting
>= max(45056, 4 x `MAX_MESSAGE_SIZE_CEILING`). Same commit updates the "Fixed
limits" and "Inbound frames" paragraphs: 600 token checks per app per minute,
and at most 4 x the transport frame limit of queued inbound bytes per
connection (worst case about 224 KiB per socket instead of 32 x 57 KiB).

## 2. Files to create / modify

Server (`apps/sync-server`)
- `src/server.ts`: `tokenSecrets` required; runtime `ConfigError`; drop random fallback; pass `maxQueuedBytes` to `Connection`.
- `src/limits/constants.ts`: add `TOKENS_CHECK_PER_APP_PER_MINUTE`, `INBOUND_QUEUE_PAYLOAD_FACTOR`, `maxQueuedInboundBytes()`.
- `src/limits/rate-limiter.ts`: add `clear()`.
- `src/groups/group-service.ts`: per-app check limiter; per-action error texts; clear limiters in `close()`.
- `src/ws/error-messages.ts`: action text table, `actionErrorMessage()`, `errorMessage()` code type narrowed.
- `src/ws/handshake.ts`: narrow the rejection `code` type (type-only).
- `src/ws/connection.ts`: queued-bytes accounting and cap; `maxQueuedBytes` dep; `rawByteLength` helper.
- `test/helpers/test-server.ts`: default random test secret.
- `test/server-options.test.ts` (new): missing / malformed `tokenSecrets` throws `ConfigError`, no socket bound, message has no secret value.
- `test/error-messages.test.ts` (new): every action text distinct per code, names its action, no `{`/interpolation; generic table lacks the two codes.
- `test/rate-limiter.test.ts`: `clear()` empties all keys.
- `test/limits.int.test.ts`: update RATE_LIMITED position text assertion (exact text).
- `test/position.int.test.ts`: exact NOT_LEADER text for a member update.
- `test/end-leave.int.test.ts`: exact NOT_LEADER text for member `group.end`.
- `test/blocklist.int.test.ts`: exact NOT_LEADER text for member `blocklist.set`.
- `test/parking.int.test.ts`: exact texts for a parked session's `group.end` and `blocklist.set`.
- `test/tokens-check.int.test.ts`: exact text for the per-connection limit; per-app budget (two apps); no `verify()` call when over budget; ManualScheduler pending 0 after close; AC9 20 re-signed tokens still delivered.
- `test/flood.int.test.ts`: byte-cap overflow closes 4008 with one TOO_MANY_MESSAGES; a queue exactly at the cap stays open.
- `test/frozen.int.test.ts`: A3 test.

Client (`packages/client`)
- `src/client.ts`: resume timeout skips the stability reset.
- `src/token-store.ts`: dirty marks with stored token, merge rules, `removeAll()` failure marking.
- `test/helpers/real-server.ts`: default random test secret.
- `test/client.reconnect.test.ts`: L4 tests (AC10, AC11, AC12, AC13 regression).
- `test/token-store.test.ts`: L5 tests with two `TokenStore` instances on one fake storage with injectable write/remove failures.
- `README.md`: `forgetAllGroups` guidance and cross-tab limits.

Docs
- `README.md` (root): upgrade note and updated fixed limits / inbound sizing.
- `docs/issues/7/STATE.md`: phase updates.

## 3. Data model and API contracts
- Data model: none (no DB). Client stored document format unchanged (`v: 1`);
  dirty marks are in memory only.
- Protocol: unchanged (v1). Wire changes are only the `message` text of
  `RATE_LIMITED` (`tokens.check`) and `NOT_LEADER` (`group.end`, `blocklist.set`).
  Codes, `details`, `reqId` are unchanged; clients must not parse `message`.
- New server behaviour: `tokens.check` may return `RATE_LIMITED`
  `{ details: { retryAfterMs } }` "Too many token checks" when the app's 600/min
  budget is used up; a connection whose queued inbound bytes would exceed
  4 x maxPayload gets `TOO_MANY_MESSAGES` and close 4008 (as the count cap).
- Library API (TypeScript): `SyncServerOptions.tokenSecrets` is now required.
  Internal package (`private`), only `main.ts` and test helpers call it.

## 4. Security-sensitive areas
Security-sensitive: yes
- Secrets/config: `createSyncServer` no longer generates a secret; refuses to start without one (`server.ts`).
- Abuse limits on unauthenticated-token input: per-app `tokens.check` budget before HMAC (`group-service.ts`).
- DoS / memory: inbound queued-bytes cap (`connection.ts`, `constants.ts`).
- Client token storage (credentials at rest): cross-tab merge rules and failed-delete handling (`token-store.ts`).
- Client reconnect logic that holds tokens (`client.ts`).
- Error texts: fixed strings only, no received values (`error-messages.ts`).
- No new dependencies, no crypto change, no token format change, no new logs of tokens/IDs.

## 5. Risks and edge cases
- A check refused by the app budget still uses one per-connection slot (accepted, see L2).
- 61 sockets are needed to hit the app budget in an integration test; the test uses an injected `now` (TestClock) and one garbage token per check, so it is cheap. App `maxConnections` defaults allow it.
- Byte cap test needs a store that blocks (same pattern as the existing 32-message test) and frames close to `maxPayload`; the inbound burst (40) is not reached.
- `rawByteLength` must handle `Buffer[]` (fragments) and `ArrayBuffer`, though the server uses the default `nodebuffer`.
- L5 rule 4 (changed but not newer) keeps memory: e.g. another tab wrote an older token; memory is newer, so this is the safe choice.
- L5 residual case (new group, failed write, other tab's `forgetAllGroups`) stays; documented.
- Typing `errorMessage()` to exclude the two codes may need small type-only edits where a code is a variable (`handshake.ts`); no runtime change.
- Client `errors.ts` still has local fallback texts "Too many position updates" / "Only the leader can update the position" for those codes. They are only used when the client builds an error itself; spec A1 and AC21 ("no other error text changes") scope this issue to the server. Flagged as a possible follow-up, not changed here.
- Existing tests that construct the server without secrets go through the helpers, so they keep working; any direct caller would now fail typecheck, which is the point of AC1.

## 6. Test plan (mapped to ACs)
| AC | Test |
|----|------|
| AC1 | `pnpm typecheck` (required field); a `// @ts-expect-error` call without `tokenSecrets` in `server-options.test.ts` |
| AC2 | `server-options.test.ts`: omitted / `{}` / short `current` throws `ConfigError`, message has no secret, nothing listens |
| AC3 | Helpers supply the random secret; `token-secret.test.ts`, `main.test.ts` unchanged and passing |
| AC4, AC5 | `tokens-check.int`: 61 app-a connections x 10 checks -> 601st is `RATE_LIMITED` "Too many token checks" with `retryAfterMs`; app-b check still succeeds; `vi.spyOn(TokenService.prototype, 'verify')` not called for the refused check; budget refills after the window (TestClock) |
| AC6 | `tokens-check.int`: ManualScheduler pending 0 after `close()`; `rate-limiter.test`: `clear()`; log capture has no token text for the refused check |
| AC7, AC8 | `flood.int`: blocking store, 1 small + 3 near-`maxPayload` frames stay open; 4th big frame -> one `TOO_MANY_MESSAGES`, close 4008 |
| AC9 | `env.test` unchanged (validation); `tokens-check.int` re-sign test with 20 previous-secret tokens still gets `tokens.result` |
| AC10, AC11, AC12 | `client.reconnect.test`: FakeWebSocket server answers `hello` but never `group.resume`, fake timers, default options -> `closed` `gave_up` after `maxAttempts`, attempt numbers keep rising, stored token still present |
| AC13 | `client.reconnect.test`: resume succeeds then connection stays `stableAfterMs` -> attempt 1 again; existing reconnect tests pass |
| AC14, AC15 | `token-store.test`: tabs A and B on one storage; A's write fails (dirty); B `forgetGroup` / `forgetAllGroups`; A's next successful write does not restore it |
| AC16 | `token-store.test`: A dirty with older token; B stores higher-`iat` token; A's next write keeps B's |
| AC17 | `token-store.test`: storage holds groups not loaded in A; A `forgetAllGroups` with failing `removeItem`; later successful write omits them |
| AC18 | README text; reviewed by QA (README drift test unaffected) |
| AC19, AC21 | `error-messages.test` (table) + exact-text asserts per row in `limits.int`, `tokens-check.int`, `position.int`, `end-leave.int`, `blocklist.int`, `parking.int` (parked end/blocklist) |
| AC20 | `error-messages.test`: texts are constants; int asserts are exact strings with no IDs |
| AC22, AC23 | `frozen.int` A3 test |
| AC24 | Root README note; reviewed by QA |
| AC25 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm audit --audit-level=high`; lockfile unchanged |

## 7. Implementation chunks (planned commits)
1. `fix(server): require token secrets in createSyncServer` (L1, AC1-AC3: server.ts, both test helpers, server-options.test.ts)
2. `fix(server): name the action in RATE_LIMITED and NOT_LEADER texts` (A1, AC19-AC21: error-messages.ts, handshake.ts types, group-service.ts, error-messages.test.ts, updated int asserts)
3. `fix(server): add a per-app tokens.check budget` (L2, AC4-AC6: constants, rate-limiter clear(), group-service, tests)
4. `fix(server): cap queued inbound bytes per connection` (L3, AC7-AC9: constants, connection.ts, server.ts, flood.int, tokens-check.int AC9)
5. `test(server): cover a member resume into a frozen group` (A3, AC22-AC23)
6. `fix(client): do not count a resume timeout as a stable connection` (L4, AC10-AC13)
7. `fix(client): let newer cross-tab changes win over dirty groups` (L5, AC14-AC16)
8. `fix(client): keep unloaded groups deleted after a failed forgetAllGroups` (L5, AC17)
9. `docs(client): document forgetAllGroups and cross-tab limits` (AC18)
10. `docs(readme): add MAX_BUFFERED_BYTES upgrade note and new limits` (AC24)

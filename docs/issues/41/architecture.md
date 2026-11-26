# Architecture: #41 fix(server): share join-attempt limits across instances through redis

Path: fast. Security-sensitive. One open decision (ADR 0024).

## Repo layout

- Layout: `single` repo, pnpm workspace monorepo (`apps/*`, `packages/*`), no
  submodules (`git submodule status` is empty). No other repo is involved.
- Affected: `apps/sync-server` (checks: `pnpm --filter ./apps/sync-server
  typecheck`, `... test`, and the same with `SYNC_TEST_STORE=redis` and
  `SYNC_TEST_REDIS_URL` set), root `pnpm lint`, `pnpm build`.
- Docs: `docs/operator-guide.md`, `docs/conventions.md`, `.changeset/`.
- Docker impact: none (no new env variable, no image or compose change; the
  ACL example `~<prefix>:*` already covers the new key and the sorted-set
  commands are in `+@read +@write`).

## Decisions

- **ADR 0024** `docs/decisions/0024-join-budget-while-redis-is-unreachable.md`
  (Proposed): what a join attempt gets when the Redis budget step fails.
  Options: (1) fail closed as ADR 0014 (`1001`), (2) fail open to the
  per-instance in-memory budget, (3) fail closed with `RATE_LIMITED`.
  **Recommended: option 1.** Section "Fail behaviour" below covers what the
  engineer builds and tests for each option.

## What the limits really are (findings)

The spec mentions "per code/IP buckets". The code has no such bucket, and the
server reads no client IP (#35 security 7.2, P2-8). The join limits in
`apps/sync-server/src/joins/join-service.ts` `spendJoinAttempt` are:

| Limiter | Key | Budget / window | Where it must live |
| --- | --- | --- | --- |
| `joinLimiter` | `session.connectionId` | 10 / 60 s | A connection lives on one instance for its whole life, so a per-process count is already exact. **Stays in memory.** |
| `appJoinLimiter` | `namespace` | 600 / 60 s | Shared by every connection of the app: this is the code-guessing budget of P2-6 / F22 that multiplies by N. **Moves to Redis.** |

So "the code-guessing budget for group and alphanumeric codes" (AC2) **is**
the per-app join budget: both `group.joinByCode` (6-digit and 8-character
codes) and `group.joinByQr` spend it before any lookup. Moving it covers AC1
and AC2.

Not in scope, noted: `wrongDoorLimiter` (60 wrong door codes per app per
minute, #10 R1b) is also per instance. The spec puts door codes out of scope;
the per-group rotation after 5 failures and the method A pause are global and
still bound door-code guessing. Moving it is harder (its check, compare and
record must stay one atomic block, N2) and is proposed as a follow-up issue
(QUESTIONS).

## Approach

A small async **join budget store**, one implementation per storage kind,
following the existing `LiveGroupsStore` pattern (`groups/live-groups.ts`
memory, `storage/redis/live-groups.ts` Redis, injected through `Storage`).

### Memory (one instance, no Redis): unchanged behaviour

`MemoryJoinBudget` wraps today's `SlidingWindowRateLimiter(now,
JOIN_WINDOW_MS)` keyed by namespace. Same algorithm, same `retryAfterMs`, same
`size` and `clear()`. `JoinService` uses it when no store is injected (as it
does for `approvals`), so the memory path and every existing test stay as
they are.

### Redis: one atomic sliding-window script

Same semantics as `SlidingWindowRateLimiter.tryAcquire` (a sliding log, not a
fixed window, so "same budgets and windows" holds exactly): at most `limit`
accepted attempts per app in any `windowMs`; only accepted attempts are
recorded; a refusal reports `oldest + windowMs - now`, at least 1.

New `JOIN_BUDGET` `LuaScript` in `storage/redis/scripts.ts`:

```
KEYS[1] = <prefix>:v1:lj:<namespace>        (sorted set)
ARGV    = now (ms, server clock), limit, windowMs, member
validate: now finite; limit, windowMs positive safe integers; member matches ^[0-9a-f]{16}$
ZREMRANGEBYSCORE key -inf now - windowMs      (inclusive: a member at exactly now - windowMs is gone, as `time > cutoff`)
n = ZCARD key
if n >= limit:
  oldest = ZRANGE key 0 0 WITHSCORES
  if PTTL key == -1 then PEXPIRE key windowMs end     (defensive: never a key without TTL)
  return {'rate', clamp(ceil(oldest + windowMs - now), 1, windowMs)}
ZADD key now member
PEXPIRE key windowMs
return {'ok'}
```

- **Atomic:** one script; concurrent attempts on any instance serialize in
  Redis, so the 601st attempt in a window is refused whichever instance it
  reaches.
- **Keys always expire:** every write sets `PEXPIRE windowMs` in the same
  script; an emptied sorted set is deleted by Redis; the refusal path repairs
  a missing TTL. At most `limit` (600) members per app.
- **Clock:** the score is the **server clock** (`ctx.now()`, the injected
  scheduler), not Redis `TIME`. Reason: the existing per-app test
  (`join-bruteforce.int.test.ts`, "allows 600 attempts per app per minute")
  also runs on Redis (`SYNC_TEST_STORE=redis`) with a manual clock and asserts
  `retryAfterMs: 60_000` and a reset after `clock.advance(60_000)`. With Redis
  `TIME` that test would have to change, which the spec forbids. The TTL is
  relative (Redis time) and the prune uses the caller's clock, so the key
  still disappears `windowMs` after its last write. Clock skew between
  instances (s ms) shifts each instance's view of the window by s: the global
  budget stays within `limit` per window of any single clock, and
  `retryAfterMs` is clamped to `[1, windowMs]` so a clock-ahead peer can never
  produce a wait over the window. Instances are expected to run NTP (already
  assumed for token times, `MAX_CLOCK_SKEW_MS`).
- **Members:** 8 random bytes, hex (`crypto.randomBytes`), one per attempt,
  so two attempts in the same millisecond on two instances never collide.
  They carry nothing else.
- **Privacy:** the key holds the app namespace only (already part of
  `lg:<ns>` and `lb:<ns>`); no join code, door code, ticket, connection ID,
  IP, name or group ID is stored or logged. Built in `keys.ts` with the
  `NAMESPACE_PATTERN` part check (security C6).
- **No instance fence, no lease:** the budget is app-scoped, not
  group-scoped (like code releases and `RESERVE_LIVE`, security C11 lists
  only group-scoped commits). Called outside any group task, before the lock.
- **Key naming:** `lj` = "limit join", next to `lb` (create budget) and `lg`
  (live groups).

### JoinService change

`spendJoinAttempt` becomes `async`: per-connection check (memory, sync,
first, as today, so one socket cannot drain the app budget), then
`await this.appBudget.tryAcquire(namespace, JOIN_ATTEMPTS_PER_APP_PER_MINUTE)`.
The `RATE_LIMITED` reply, `retryAfterMs` and the once-per-window
`join_app_budget_exhausted` warning (per instance, conventions "Refusal
logs") are unchanged. `joinByCode` / `joinByQr` already `await` right after
it, so the order of the reply, the lookup and the lock is unchanged.
`close()` clears the store (Redis: no-op; stored counters expire by TTL);
`limiterSize` counts the memory store's `size` (Redis: 0).

### Fail behaviour (ADR 0024, user decision)

Build **one** of these, as decided at Gate 2:

- **Option 1 (recommended), fail closed via ADR 0014.** `RedisJoinBudget`
  does not catch. `StorageUnavailableError` from `link.script` reaches
  `ws/connection.ts`, which already logs `storage_unavailable_closed` and
  closes with `1001`. `StorageReplyError` stays `INTERNAL_ERROR` to the
  requester only. Nothing is looked up after a failed budget step. No new
  code beyond not catching; the test pins it.
- **Option 2, fail open to the per-instance budget.** `RedisJoinBudget`
  takes a `MemoryJoinBudget` fallback (same 600 / 60 s, same clock). On
  `StorageUnavailableError` **only** from the budget script: charge the
  fallback and return its result, and `warn` `join_budget_fallback`
  `{namespace}` at most once per window per app (reuse the `warnOnce`
  pattern; namespace only). Any other error propagates. The fallback's
  `size` counts in `limiterSize`; `clear()` clears it. Its entries are never
  copied to Redis.
- **Option 3, fail closed with `RATE_LIMITED`.** `spendJoinAttempt` catches
  `StorageUnavailableError` from the store only and returns
  `RATE_LIMITED` with `retryAfterMs: 1000` for the action; other errors
  propagate.

## Files to create / modify

All under `apps/sync-server/` unless stated.

- Create `src/joins/join-budget.ts`: `JoinBudgetStore` interface
  (`tryAcquire(namespace, limit): Promise<RateResult>`, `clear()`, `size`)
  and `MemoryJoinBudget` (wraps `SlidingWindowRateLimiter`).
- Create `src/storage/redis/join-budget.ts`: `RedisJoinBudget(ctx)`; runs
  `JOIN_BUDGET`, parses the reply strictly (`'ok'` | `'rate', ms` with ms a
  safe integer in `[1, windowMs]`, else 1; anything else throws like
  `RedisLiveGroups`). Option 2 adds the fallback here.
- Modify `src/storage/redis/scripts.ts`: add `JOIN_BUDGET` (constant source,
  every dynamic value in `KEYS`/`ARGV`).
- Modify `src/storage/redis/keys.ts`: `appJoinBudget(namespace)` ->
  `${base}:lj:<namespace>` with the namespace part check.
- Modify `src/storage/storage.ts`: optional `readonly joinBudget?:
  JoinBudgetStore` on `Storage` (memory leaves it unset).
- Modify `src/storage/redis/redis-storage.ts`: `joinBudget: new
  RedisJoinBudget(ctx)`.
- Modify `src/server.ts`: pass `storage.joinBudget` (when set) into the
  `GroupService` deps.
- Modify `src/groups/group-service.ts`: `joinBudget?` in its deps, passed to
  `JoinService` (same spread pattern as `approvals`).
- Modify `src/joins/join-service.ts`: `JoinServiceDeps.joinBudget?`;
  `appJoinLimiter` replaced by the store; `spendJoinAttempt` async; `close`
  and `limiterSize` as above. `joinLimiter` (per connection) unchanged.
- Tests: see the test plan (`test/keys.test.ts`, new
  `test/join-budget.test.ts`, new `test/join-budget.redis.test.ts`).
- Create `.changeset/shared-join-limits.md` (server, `patch`).
- Docs: `docs/operator-guide.md`, `docs/conventions.md` (Docs impact).

Not touched (parallel sessions): `src/storage/redis/pubsub.ts` (#86, PR
#94), the Redis load tests (#87), `test/group-create-limits*.test.ts` and the
operator-guide lines 520-530 (#48, PR #93), `docs/roadmap.md`.

## Data model

Redis only, no schema migration, no document change:
`<prefix>:v1:lj:<namespace>`: sorted set, member = 16 hex chars (random),
score = attempt time (server ms). TTL `JOIN_WINDOW_MS` (60 s) after each
accepted attempt; at most 600 members. Not group-scoped, so not part of the
group's AC24 lifetime set; its TTL (60 s) is far below any group's `E`, so
the "every key bounded by E" privacy test still holds. A prefix flush or a
Redis restart without persistence resets the counter (the budget is then
full again: at worst one extra window, as a process restart today).

Rolling upgrade: an old build counts per instance and a new build counts in
Redis; during a mixed run the old instances keep their own budget. Mixed
versions on one prefix are unsupported anyway (#35 Q-B7, operator guide
"Upgrading"); no special handling.

## Contracts

- Wire protocol: no change. `RATE_LIMITED` with `details.retryAfterMs` and
  the text "Too many join attempts" as today. (Option 3 only: also sent for a
  storage failure of the budget step.)
- HTTP, env, apps config: no change. No new variable.
- Server API: `Storage.joinBudget?` (internal); `SyncServerOptions`
  unchanged (no test-only override: the tests use the real 600 budget).
- Logs: no new event for options 1 and 3. Option 2: `join_budget_fallback`
  (warn, `{event, namespace}` only).

## Risks / edge cases

- **Clock skew** between instances: covered above (prune by caller clock,
  clamp `retryAfterMs`, TTL in Redis time). A unit test pins the clamp.
- **Hot key:** one sorted set per app, one script per join attempt, at most
  600 accepted writes per minute per app plus refusals (each a few
  microseconds). Refusals beyond the per-connection limit never reach Redis
  (the per-connection check is first).
- **Refusals cost Redis calls:** an attacker over the app budget still causes
  one script per attempt, bounded by 10 per connection per minute and the
  connection caps. Same order as today's code lookups.
- **Script errors** (`WRONGTYPE` if something else wrote the key): reply
  error -> `INTERNAL_ERROR` to that request only (C8), under every option.
- **Per-connection order:** the inbound queue handles one message per
  connection at a time, so making the step async adds no race within a
  connection; across connections the script is the serialization point.
- **Existing tests on Redis:** the per-app test in
  `join-bruteforce.int.test.ts` runs unchanged under both stores (that is
  why the server clock is used).

## Security-sensitive areas

Security-sensitive: yes

- Rate limiting of a user-input path that bounds code guessing
  (`group.joinByCode`, `group.joinByQr`): `src/joins/join-service.ts`
  `spendJoinAttempt`.
- New Redis key and Lua script on the request path:
  `src/storage/redis/keys.ts`, `scripts.ts`, `join-budget.ts` (part checks,
  constant script, strict reply parse, TTL on every write).
- Failure mode of a security control while Redis is unavailable (ADR 0024).
- Privacy of stored data: namespace and random members only.

## Implementer model

Implementer model: opus
Reason: security-sensitive rate-limit change with a new Redis script, an open
ADR whose outcome selects the code path, and clock-skew / atomicity edge cases.

## Test plan (mapped to acceptance criteria)

Run every server suite twice: memory (`pnpm --filter ./apps/sync-server
test`) and Redis (`SYNC_TEST_STORE=redis` with `SYNC_TEST_REDIS_URL`).

- **AC6 (single instance unchanged):** no edit to existing tests.
  `join-bruteforce.int.test.ts` (per connection and per app, including
  `retryAfterMs: 60_000`, the one warning, app B's own budget and the reset
  after 60 s) passes in both modes, as do `lifecycle-states.int.test.ts` and
  `rate-limiter.test.ts`.
- **New `test/join-budget.test.ts` (memory unit):** `MemoryJoinBudget` gives
  the same results as `SlidingWindowRateLimiter` for one sequence (accept to
  the limit, refusal with `retryAfterMs`, refusals not recorded, slide after
  the window, `clear`, `size`).
- **New `test/join-budget.redis.test.ts` (`describeRedis`):**
  - *Parity (AC2, AC4):* `RedisJoinBudget` with a manual `now` and a small
    limit (e.g. 3 per 1000 ms, passed to `tryAcquire`) returns exactly what
    `MemoryJoinBudget` returns for the same sequence of times (accepts,
    refusal `retryAfterMs`, refusals not counted, the boundary `time ==
    now - window` is outside, sliding acceptance).
  - *Expiry (AC4):* after each accepted call `PTTL` of `lj:<ns>` is in
    `(0, windowMs]`; with a short window the key is gone after it; a key
    whose TTL was removed by hand gets one again on the next refusal; the
    set never holds more than `limit` members.
  - *Clock skew:* a member written with a later `now` (instance ahead) gives
    a refusal with `retryAfterMs <= windowMs` for an earlier `now`.
  - *Privacy:* the only key written is `<prefix>:v1:lj:app-a`; its members
    match `^[0-9a-f]{16}$`; a dump of the prefix holds no join code, door
    code or connection ID used in the test.
  - *Two instances share the budget (AC1, AC2, AC3):* two servers on one
    prefix (`startTestServer({ redisPrefix })` twice, real clock). 35
    connections on A and 25 on B each send 10 `group.joinByCode` with an
    unknown code: all 600 get `CODE_NOT_FOUND`. Then one more attempt on A
    **and** one on B (fresh connections) each get `RATE_LIMITED` with
    `0 < retryAfterMs <= 60_000`, and the code lookup spy count stays 600.
    `ZCARD lj:app-a` is 600. A second app's attempt still succeeds. Also one
    `group.joinByQr` attempt on B is refused once the budget is spent (both
    actions share it).
  - *Fail behaviour (AC5), for the chosen option:*
    - Option 1: spy on the link's `script` so `JOIN_BUDGET` throws
      `StorageUnavailableError` (as `outage.redis.test.ts` does with
      `COMMIT`); a join attempt closes with `1001`, no lookup runs, and the
      log has `storage_unavailable_closed` (`event`, `type` only; no code
      or connection ID). A `StorageReplyError` from the script gives `INTERNAL_ERROR`
      and the connection stays open. Plus one real outage through
      `TcpProxy` (blocked): the attempt closes with `1001`.
    - Option 2: the same injected failure lets the join go on
      (`CODE_NOT_FOUND`), the fallback refuses the 601st attempt on that
      instance, one `join_budget_fallback` warning per window, and nothing
      is written to `lj:<ns>` during the failure.
    - Option 3: the same injected failure gives `RATE_LIMITED` with
      `retryAfterMs: 1000` and the connection stays open; no lookup runs.
- **`test/keys.test.ts`:** `appJoinBudget(NS)` is `sync:v1:lj:<NS>`; an
  invalid namespace throws `KeyPartError`.
- **Existing Redis privacy tests** (`redis-privacy.redis.test.ts`: every key
  bounded by E, no secret or code stored, no code in logs) pass unchanged
  with the new key present.
- **AC7 (docs):** review of the operator-guide diff (below).
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (both stores),
  `pnpm build`; no new dependency.

## Docs impact

- `docs/operator-guide.md`, "Several instances" section, minimal and outside
  PR #93's hunk (lines 520-530):
  - Replace the paragraph "**The join-attempt budget multiplies by the
    number of instances.** ..." (about line 578) with one sentence: the
    per-app join-attempt budget (and with it the code-guessing budget) is
    shared through Redis by every instance; the per-connection limit is per
    connection; plus, per ADR 0024, what an attempt gets while Redis is
    unreachable.
  - The limits table row "Join attempts per connection and **per app**"
    (about line 571) is now wrong: split it into "per connection: per
    instance (a connection lives on one instance)" and "per app: Global".
  - Also stale, outside the "Several instances" section: line ~496 ("Limits
    stay per instance: ... the join and token-check budgets ...") and the
    "Known limits of 1.0.0" bullet "**Join attempts are limited per
    instance** (issue #41)" (~line 1178). Plan: drop "join" from the first
    and remove the bullet. Both are one-line edits far from #93's hunk. If
    the user wants strictly the multiplication note only, these two are
    dropped and listed as a follow-up (QUESTIONS).
- `docs/conventions.md`, "Sync server storage" table: one row
  "Join-attempt budget (#41)": per app in Redis (`lj:<ns>`, sliding log,
  server clock), per connection in the process; failure behaviour per ADR
  0024. Done in chunk 1 with the ADR acceptance.
- `.changeset/shared-join-limits.md`: server `patch`, one paragraph.
- `docs/roadmap.md`: not edited.

## Implementation chunks

1. `docs(adr): accept 0024 join-budget-while-redis-is-unreachable`
   (ADR status and decision per Gate 2; `docs/conventions.md` row)
2. `refactor(server): put the per-app join budget behind a store`
   (`joins/join-budget.ts` with `MemoryJoinBudget`, `JoinService`,
   `GroupService` deps; memory behaviour unchanged; `test/join-budget.test.ts`)
3. `feat(storage): add the redis join budget script and key`
   (`scripts.ts` `JOIN_BUDGET`, `keys.ts` `appJoinBudget`,
   `storage/redis/join-budget.ts`; `test/keys.test.ts`; parity, expiry,
   skew and privacy parts of `test/join-budget.redis.test.ts`)
4. `fix(server): share the per-app join budget across instances`
   (`storage.ts`, `redis-storage.ts`, `server.ts` wiring; the two-instance
   test)
5. `feat(server): <behaviour per ADR 0024> when the join budget is unreachable`
   (option 1: `test(server): close joins with 1001 when the join budget is unreachable`,
   test only; option 2 or 3: the code plus its test)
6. `docs(server): document the shared join budget`
   (`docs/operator-guide.md` edits above, `.changeset/shared-join-limits.md`)

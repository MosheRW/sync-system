# Architecture: #12 fix(server): limit group creation and live groups per app

Spec: [spec.md](spec.md). Source: advisory M2 in
[`docs/issues/10/security.md`](../10/security.md). Path: fast.

## 1. Repo layout

- Layout: `monorepo` (pnpm workspace, `apps/*` and `packages/*`; no
  submodules, `git submodule status` is empty). One branch, one PR.
- Affected packages and their checks (root `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm build`, `pnpm audit --audit-level=high`):

| Package | Path | Why |
| --- | --- | --- |
| `@sync-system/protocol` | `packages/protocol` | New error code |
| `@sync-system/server` | `apps/sync-server` | Limits, live-group store (memory + Redis) |
| `@sync-system/client` | `packages/client` | Error text and typed details for the new code (the `Record<ClientErrorCode, string>` map requires it) |
| reader | `apps/reader` | One `case` so the new code shows the existing "busy" message |

Redis tests (`*.redis.test.ts`) need a local Redis (GitHub Actions is
billing-blocked; run them with the local Docker CI).

## 2. Decisions

`Decisions: none open as ADRs.` These are limit values and one error name
for one server feature, the same kind of choice #10 (Q5.2) and #35 (Q-B5)
settled at Gate 2 in architecture.md. No new dependency, no project-wide
convention changes. They go to the user as **Decisions for Gate 2**:

### Q-1. Limit values

| Limit | Recommended | Counted |
| --- | --- | --- |
| `group.create` per connection | **6 per minute** (sliding window) | Per connection; forgotten on disconnect |
| `group.create` per app | **120 per minute**, shared by the app's connections | Per instance (like the join budgets) |
| Live groups per app | **10 000** | Global: per process in memory, in Redis across every instance |

Reasoning:
- A connection can hold one group at a time (`ALREADY_IN_GROUP`). The
  per-connection rate only limits create/end churn; it resets on reconnect,
  so like the join budgets it is noise reduction, not a security bound.
- An abandoned group lives about `inactivityLimitMinutes` (20 default, 60
  ceiling). At 120/min one instance's budget holds at most about 2 400 groups
  at the default and 7 200 at the ceiling: below the 10 000 cap, so **one
  instance's create budget alone cannot fill the cap** and deny the app. That
  is why 120 and not more. Groups kept alive by a connected leader are bounded
  by the app's `maxConnections` on top.
- The cap is 1 % of the 10^6 group codes: a mistyped method B code reaches a
  squatter's group with probability at most about 1 %, and `CODES_EXHAUSTED`
  (20 draws) becomes practically impossible (0.01^20).
- Legitimate load: 120 creates per minute per instance covers a burst of 120
  leaders starting at once; the rest get `RATE_LIMITED` with `retryAfterMs`
  (at most 60 s). 10 000 concurrent groups per app is about 10x the default
  per-app connection cap.

Alternatives: per-app 60/min (safer against squatting, tighter for bursts);
300/min with cap 10 000 (one instance could fill the cap at a 60-min
inactivity limit: a cheap way to deny the app all creation); cap 50 000
(5 % code fill, mistyped B codes hit a squatter 1 in 20).

### Q-2. Fixed constants, env ceilings, or per app

1. **Fixed constants in `limits/constants.ts`** (recommended): the same as
   every join, door, QR and `tokens.check` budget ("Fixed, not an app
   setting", #10 Q5.2). Smallest change; no new env variable, `known-vars.ts`
   entry, startup error or config test. Can be made configurable later
   without a breaking change.
2. Env variable for the cap only (`MAX_LIVE_GROUPS_PER_APP`, default
   10 000): lets large multi-instance deployments raise it. Costs a
   `known-vars.ts` entry, env parsing and tests, `docs/startup-errors.md`.
   (The name already passes ADR 0015's `MAX_` family.)
3. Per-app field `maxLiveGroups` with an env ceiling: most flexible, most
   work (apps config schema, ceiling comparison, README field table).

Trade-off: 1 cannot be tuned without a release; 2 and 3 add config surface
for a limit nobody has hit yet.

### Q-3. Error code for the live-group cap

1. **`APP_GROUP_LIMIT`** (recommended), `details: { maxLiveGroups: number }`:
   mirrors `APP_CONNECTION_LIMIT` (an app-wide cap); the `GROUP_*` codes
   (`GROUP_FULL`, `GROUP_LOCKED`, `GROUP_NOT_FOUND`) are about one group,
   so `GROUP_LIMIT_REACHED` reads like "this group is full".
2. `GROUP_LIMIT_REACHED` (the spec's example), same details.
3. Reuse `CODES_EXHAUSTED`: no protocol change, old clients already know it,
   but it says "try again now" and is not distinguishable from a real code
   shortage, so it fails the spirit of AC3.

No `retryAfterMs`: the server cannot know when a group will end.

### Q-4. Recreated groups (`group.resume` after a restart)

1. **Counted, never refused** (recommended): the recreation registers the
   group in the live-group set so the count stays true, but the cap does not
   refuse it: it restores a group that existed, and it is already limited by
   `RECREATIONS_PER_CONNECTION_PER_MINUTE`. The count may then exceed the cap
   until groups end; new creates are refused meanwhile.
2. Counted and refused at the cap with `APP_GROUP_LIMIT`: a restart into a
   full app would lose leaders' groups.
3. Not counted: the cap undercounts after a memory restart.

### Q-5. Refusal logging

**Recommended:** one `warn` per app per minute when the app's create budget
is used up (`group_create_app_budget_exhausted`) and when the cap refuses
(`app_group_limit_reached`), with `namespace` only, the same throttle as
`warnAppBudget` in `join-service.ts`. No group code (none is drawn), no group
ID or ref, no connection ID. Per-connection refusals are not logged.

## 3. Approach

All three checks run in `group.create`, after the existing cheap
validation, in this order, and **before** `joins.initialCodes` draws a code:

1. `busy` -> size checks -> display name (unchanged).
2. Per-connection create rate: `createLimiter.tryAcquire(session.connectionId, GROUP_CREATES_PER_CONNECTION_PER_MINUTE)`;
   refused: `RATE_LIMITED` for `group.create` with `details.retryAfterMs`.
3. Per-app create rate: `appCreateLimiter.tryAcquire(app.namespace, GROUP_CREATES_PER_APP_PER_MINUTE)`;
   refused: the same `RATE_LIMITED` shape, plus the throttled warning.
   Checked after step 2, so one socket over its own limit never spends the
   app's budget (the join pattern, `join-service.ts` `budget()`).
4. Inside the new group's lock (`createLocked`), first:
   `liveGroups.reserve(namespace, groupId, expiresAt, MAX_LIVE_GROUPS_PER_APP)`
   where `expiresAt = groupExpiry(namespace, now)` (the same end bound as the
   code claims). `false`: `APP_GROUP_LIMIT` with `details.maxLiveGroups`,
   nothing drawn, nothing stored.
5. `initialCodes` (unchanged). If it fails (`CODES_EXHAUSTED`,
   `JOIN_METHOD_NOT_ALLOWED`) or `store.create` throws, the reservation is
   released (next to the existing `releaseCodes`).

Steps 2 and 3 use `tryAcquire` (charged on pass), so a create refused later by
the cap or by codes still counts against the rates. That is intended: a full
app must not be hammered at full speed.

The limiters are `SlidingWindowRateLimiter`s in `GroupService` (window
`GROUP_CREATE_WINDOW_MS = 60_000`), synchronous and in-process like
`recreateLimiter`. The per-connection key is forgotten in `disconnect()`;
both are cleared in the shutdown `clear()` next to `recreateLimiter.clear()`.

### 3.1 Live-group store (new, both storages)

A new storage part `liveGroups: LiveGroupsStore` on `Storage`:

```ts
/** Live groups per app (#12): the cap's count. Never logged. */
export interface LiveGroupsStore {
  /** Adds `groupId` unless the app holds `cap` or more live groups; true if held. Idempotent. */
  reserve(namespace: string, groupId: string, expiresAt: number, cap: number): Promise<boolean>;
  /** Adds `groupId` whatever the count (recreation, Q-4). */
  register(namespace: string, groupId: string, expiresAt: number): Promise<void>;
  /** Removes `groupId` (group ended, or its create failed). */
  release(namespace: string, groupId: string): Promise<void>;
  /** Forgets local state (server shutdown). */
  clear(): void;
}
```

- **Memory** (`MemoryLiveGroups`, `src/groups/live-groups.ts`):
  `Map<namespace, Map<groupId, expiresAt>>`; every method body is synchronous
  (check-and-add atomic in-process, like `CodeIndex`); `reserve` first drops
  entries past `expiresAt` (parity with Redis; in memory the max-session timer
  ends them anyway); an app's map is deleted when empty, so the number of keys
  is bounded by apps with live groups.
- **Redis** (`RedisLiveGroups`, `src/storage/redis/live-groups.ts`): one
  sorted set per app, key `<base>:lg:<namespace>` (`RedisKeys.appLive(namespace)`,
  namespace checked against `NAMESPACE_PATTERN`), member = group ID (checked
  against `GROUP_ID_PATTERN`), score = `expiresAt`. A new constant Lua script
  `RESERVE_LIVE` in `scripts.ts` (KEYS: the set; ARGV: group ID, now,
  expiresAt, cap; register passes cap `-1` meaning no cap):
  `ZREMRANGEBYSCORE key -inf (now` -> if `ZSCORE` member exists: update score,
  return 1 -> if cap >= 0 and `ZCARD >= cap`: return 0 -> `ZADD` -> set the
  key's `PEXPIREAT` to the largest score (only ever extended). One script:
  atomic across instances. Mirrors `RedisCodeIndex.claim`: a fresh reservation
  registers `work.current()?.onAbandon(...)` that `ZREM`s it if the task or
  its commit fails (best effort; the score bounds it anyway). `release`
  inside a running unit of work adds a commit step `plan.zrem(key, groupId)`
  (like `RedisCodeIndex.release`), else runs its own unfenced plan.
- Groups that leave Redis without an `endGroup` (TTL expiry after an outage,
  a crashed instance) are pruned by score at the next reserve: drift is
  bounded by the group's end bound, never permanent.
- `GroupService.endGroup` calls `liveGroups.release(namespace, groupId)`
  right after `store.delete`. Not in `forgetGroup` (that also runs for the
  cluster `forget` op, which only drops local state on other instances).
- `recreate` calls `liveGroups.register(...)` after `createIfAbsent` returned
  `created` (Q-4 option 1), and nothing on `exists`.
- The orphan sweep ends groups through `endGroup`, so it releases too.

Rejected: counting from the code index (groups with only method D or C have
no group code, and Redis code keys cannot be counted per app); counting from
the existing global `keys.live()` set (members `ns:gid` of every app, no
per-app count without a scan); an `INCR`/`DECR` counter (drifts for ever on a
crash between create and end; the sorted set self-heals by score); checking
the cap inside the commit script (changes the commit script for every write;
the reserve-then-commit pattern of codes already exists).

## 4. Files to create / modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/errors.ts` | Add `APP_GROUP_LIMIT` with a doc comment (per Q-3). |
| `packages/protocol/test/codes.test.ts` | Covered by the existing key = value loop; add one explicit assertion. |
| `apps/sync-server/src/limits/constants.ts` | `GROUP_CREATES_PER_CONNECTION_PER_MINUTE = 6`, `GROUP_CREATES_PER_APP_PER_MINUTE = 120`, `GROUP_CREATE_WINDOW_MS = 60_000`, `MAX_LIVE_GROUPS_PER_APP = 10_000` (per Q-1, Q-2), documented like the join constants. |
| `apps/sync-server/src/groups/live-groups.ts` (new) | `LiveGroupsStore` interface and `MemoryLiveGroups`. |
| `apps/sync-server/src/storage/redis/live-groups.ts` (new) | `RedisLiveGroups`. |
| `apps/sync-server/src/storage/redis/keys.ts` | `appLive(namespace)` -> `<base>:lg:<ns>`. |
| `apps/sync-server/src/storage/redis/scripts.ts` | `RESERVE_LIVE` Lua script (constant string, all values in KEYS/ARGV). |
| `apps/sync-server/src/storage/storage.ts` | `liveGroups` on `Storage`; `memoryStorage` wires `MemoryLiveGroups`. |
| `apps/sync-server/src/storage/redis/redis-storage.ts` | Wires `RedisLiveGroups(ctx, work)`. |
| `apps/sync-server/src/server.ts` | Pass `storage.liveGroups` into `GroupServiceDeps`; optional test-only `groupLimits?: { perConnection?, perApp?, maxLiveGroups? }` on `SyncServerOptions` (defaults: the constants), same pattern as `endedGroupsCap` / `replayCap` ("Tests lower it"). |
| `apps/sync-server/src/groups/group-service.ts` | Two limiters, the checks in `create`/`createLocked`, release on failure and in `endGroup`, `register` in `recreate`, forget in `disconnect`, clear on shutdown, throttled warnings. |
| `apps/sync-server/src/ws/error-messages.ts` | Fixed text for `APP_GROUP_LIMIT`, e.g. `'The app has too many live groups; try later'`. |
| `packages/client/src/errors.ts` | `MESSAGES` text and `KnownDetails.APP_GROUP_LIMIT: { maxLiveGroups?: number }`. |
| `apps/reader/src/group/errors.ts` | `case 'APP_GROUP_LIMIT':` next to `CODES_EXHAUSTED` -> `errBusy`. `RATE_LIMITED` on create already maps to `errRateLimited` with the wait. |
| Tests (section 7) | New `group-create-limits.int.test.ts`, contract `liveGroupsContract` in `test/contracts/state.ts`, run from `storage-contracts.test.ts` and `redis-storage-contracts.redis.test.ts`; a Redis multi-instance case; small additions to `keys.test.ts`, `error-messages.test.ts`, client `errors.test.ts`, reader `join`/error test. |
| `README.md`, `packages/client/README.md` | Docs chunk (section 6). |

## 5. Contracts

### 5.1 Wire (protocol stays version 1)

`group.create` gains two refusals; its success reply is unchanged.

| Refusal | Frame |
| --- | --- |
| Per-connection or per-app create rate | `{type: 'error', reqId, code: 'RATE_LIMITED', message, details: {retryAfterMs: number}}` (same shape as `tokens.check` / join refusals) |
| Live-group cap | `{type: 'error', reqId, code: 'APP_GROUP_LIMIT', message, details: {maxLiveGroups: number}}` |

The connection stays open; no group, code, token or timer is created.
Precedent for adding codes without a version bump: #10 and #13. An older
client that receives `APP_GROUP_LIMIT` fails its `z.enum(ErrorCode)` parse
and rejects the request as `INVALID_SERVER_MESSAGE`; acceptable because
server and clients ship from this repo, and it is listed under Upgrading.

### 5.2 Redis data

New key per app: `<prefix>:v1:lg:<namespace>`, a sorted set of group IDs
scored by their end bound (ms), with a `PEXPIREAT` at the largest score. No
user data (group IDs are already key parts). Commands: `ZREMRANGEBYSCORE`,
`ZSCORE`, `ZCARD`, `ZADD`, `ZREM`, `PEXPIREAT`, `PTTL`/`PEXPIRETIME` inside
the script: all covered by the README's ACL (`+@read +@write +@scripting`).
No migration: the key is created on the first create after the upgrade;
groups that existed before the upgrade are not counted until they end (the
count undercounts for at most one max session). Documented in Upgrading.

`Docker impact: none.`

## 6. Docs impact

- `README.md`:
  - New "Group creation limits" rows (or a small table under "Fixed join
    limits", renamed "Fixed join and creation limits"): 6 creates per
    connection per minute, 120 per app per minute, 10 000 live groups per app,
    the error codes, and the reasoning of Q-1 in two sentences.
  - "Limits with several instances" table: create rate per connection and per
    app = per instance; live groups per app = global. Note that N instances
    allow N x 120 creates per minute, so 2+ instances can reach the cap.
  - Replace the "Group-code squatting ... Tracked in issue #12" bullet with
    the remaining residual (at most 1 % fill; a flood across instances can
    fill the cap and refuse creation in that app until groups end).
  - Errors list in "Protocol (v1) in brief": add `APP_GROUP_LIMIT`.
  - "Upgrading": live groups created before the upgrade are not counted; old
    clients see `APP_GROUP_LIMIT` as an invalid server message.
- `packages/client/README.md`: errors table row for `APP_GROUP_LIMIT`; note
  that `createGroup()` can now reject with `RATE_LIMITED` (`retryAfterMs`).
- `docs/conventions.md`: one row under "Sync server" recording the Gate 2
  choices (Q-1 to Q-5) with a link to this file.

## 7. Test plan

Server tests use `TestClock`/manual scheduler and `groupLimits` lowered (for
example per-connection 2, per-app 3, cap 2) so no test creates thousands of
groups; one test checks the real constants' values.

| AC | Test |
| --- | --- |
| AC1 per-connection rate | int: one client creates, ends, creates ... until refused: `RATE_LIMITED`, `details.retryAfterMs > 0`; the code index size and `liveGroups` are unchanged by the refused create (inject a `codeRandom` that counts calls: zero draws); after the window passes, create works; a reconnect resets it. |
| AC2 per-app rate | int: several clients of app-a exceed the per-app budget: `RATE_LIMITED` with `retryAfterMs`, zero draws; a connection already over its own rate does not spend the app budget. |
| AC3 live-group cap | int: fill the cap with abandoned groups (create, disconnect): the next create gets `APP_GROUP_LIMIT` with `maxLiveGroups`, distinct from `RATE_LIMITED`, zero draws, no group stored; after one group ends (`group.end`), a create works again; a create failing with `CODES_EXHAUSTED` releases its slot. |
| AC3 storage parity | `liveGroupsContract` for memory and Redis: reserve to the cap, refuse at the cap, idempotent re-reserve, release frees a slot, `register` ignores the cap, expired entries pruned, per-app isolation. |
| AC3 across instances | `.redis` test with two instances on one prefix: the cap counts groups of both; concurrent creates on both instances at cap - 1 admit exactly one. |
| AC4 isolation | int: app-a at its per-app rate and at its cap; app-b creates normally (both rates and cap). |
| AC5 no codes in logs | `LogCapture` over every refusal path: no 6-digit or alphanumeric code, no group ID or ref, no connection ID; the throttled warning appears once per minute per app with `namespace` only. |
| AC6 README | Docs chunk; QA reviews. |
| AC7 coverage | The rows above, plus Q-4: a recreation at the cap succeeds and is counted. `keys.test.ts`: `appLive` rejects a bad namespace. |
| AC8 checks | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Redis tests locally; no `package.json` dependency change. |

Existing tests must keep passing with the real constants (some create up to
13 groups per app in one server, below 120 per minute); any test that
exceeds a limit gets a lowered or raised `groupLimits` rather than a changed
constant.

## 8. Risks / edge cases

- **Self-DoS of an app through the cap**: with several instances, N x 120
  creates per minute can fill 10 000 slots and refuse all creation in that
  app until groups end. Accepted residual (documented); a global Redis create
  limiter is the follow-up direction (#41 tracks the same for joins).
- **Reservation leaks**: a crash between reserve and commit leaves a slot
  until its score passes (at most the max session plus slack). Memory: the
  failure paths release synchronously.
- **Order matters**: the reserve must come before `initialCodes`, and every
  return path after a successful reserve that stores no group must release.
- **Fenced or unreachable Redis**: `reserve` throws like other storage calls;
  the existing handling (1001 / `INTERNAL_ERROR`) applies; no reservation
  survives an abandoned task beyond its score.
- **Clock**: the score uses the server clock like code-claim TTLs and ended
  entries; instances must keep clocks in sync (already required).
- **Rate charged on later refusal**: intended (section 3).

## 9. Security

Security-sensitive: yes

- Abuse limits on a message handler that accepts anonymous input
  (`group.create`, public API key): order of checks, no code drawn before
  refusal, per-app isolation (`group-service.ts`).
- New Redis key family and Lua script: key parts checked in `keys.ts`,
  constant script with `KEYS`/`ARGV` only (`keys.ts`, `scripts.ts`,
  `storage/redis/live-groups.ts`).
- Logging of refusals: namespace only (`group-service.ts`).
- New wire error code and details (`packages/protocol/src/errors.ts`).

## 10. Implementer model

Implementer model: opus
Security-sensitive abuse limits, a new storage part with a Redis Lua script
and unit-of-work integration across instances, a wire error code, and more
than 3 files.

## 11. Implementation chunks

1. `feat(protocol): add APP_GROUP_LIMIT error code` (protocol, server
   `error-messages.ts`, client `errors.ts`, reader `errors.ts`, their tests)
2. `feat(storage): add live-group store for memory and redis` (interface,
   memory, Redis, key, script, `Storage` wiring, contract tests, multi-instance
   test)
3. `fix(server): limit group creation rate per connection and per app`
   (constants, limiters, `groupLimits` option, refusals, warnings, int tests)
4. `fix(server): cap live groups per app` (reserve/release/register in
   `group-service.ts`, int tests incl. isolation and logs)
5. `docs(server): document group creation limits` (README, client README,
   `docs/conventions.md` Gate 2 row)

Chunk names follow the recommendations; if the user picks other options at
Gate 2, the engineer adjusts them (Q-3 option 3 drops chunk 1; Q-2 option 2
or 3 adds a config chunk with `known-vars.ts` and `docs/startup-errors.md`).

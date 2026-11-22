# Architecture: #12 fix(server): limit group creation and live groups per app

Spec: [spec.md](spec.md). Source: advisory M2 in
[`docs/issues/10/security.md`](../10/security.md). Path: fast.
Security plan review: [security.md](security.md) (round 1: FAIL, H1).

## Revision 1 (after security plan review round 1)

What changed, and why:

- **H1 fixed (Q-1, sections 3, 3.1, 8).** Round 0 said one instance's
  120/min create budget could not fill the 10 000 cap, because an abandoned
  group lives about `inactivityLimitMinutes`. That was wrong: a leader return
  (`group.resume`, not rate limited) plus one leader action resets inactivity,
  so a script that keeps its leader tokens holds every group until
  `maxSessionMinutes` (180 default, 480 at the default ceiling). At 120/min
  one instance fills the cap in about 84 minutes and creation in the app is
  then refused for up to 3 h (8 h) **after the attack stops**.
  The per-instance per-app limiter is replaced by a **global per-app create
  budget** (a token bucket) checked in the same Redis script as the cap
  (in-process with memory storage). Its refill rate is **derived from the
  app's `maxSessionMinutes`** so that all creates that can still be live at
  any moment stay at or below half the cap, for any number of instances and
  with any keep-alive. The cap cannot be filled by creates at all; a flood
  can only keep the app's budget empty while it runs, and creation comes
  back seconds after it stops. Closes H1 and M3.
- **Q-1 numbers corrected**, alternatives shown with corrected numbers
  (per-instance derived rate; accepting the DoS).
- **M2:** the join-method set is resolved before the reserve (pure check),
  `JOIN_METHOD_NOT_ALLOWED` can no longer follow a reservation; a "stored or
  released" guard wraps everything after the reserve; tests for every
  failure path after it.
- **L1:** `endInvalid` also removes the group from the app's live set.
- **L2:** `reserve` validates its numbers; `register` is a separate script
  mode, never a cap value; `groupLimits` is validated.
- **L4, M1:** documented (README residuals); L4 is mostly closed by the
  global budget, since every live group starts with a create.
- **R1-R11** of security.md mapped to chunks (section 9).

## 1. Repo layout

- Layout: `monorepo` (pnpm workspace, `apps/*` and `packages/*`; no
  submodules, `git submodule status` is empty). One branch, one PR.
- Affected packages and their checks (root `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm build`, `pnpm audit --audit-level=high`):

| Package | Path | Why |
| --- | --- | --- |
| `@sync-system/protocol` | `packages/protocol` | New error code |
| `@sync-system/server` | `apps/sync-server` | Limits, live-group store and create budget (memory + Redis) |
| `@sync-system/client` | `packages/client` | Error text and typed details for the new code (the `Record<ClientErrorCode, string>` map requires it) |
| reader | `apps/reader` | One `case` so the new code shows the existing "busy" message |

Redis tests (`*.redis.test.ts`) need a local Redis (GitHub Actions is
billing-blocked; run them with the local Docker CI).

## 2. Decisions

`Decisions: none open as ADRs.` These are limit values and one error name
for one server feature, the same kind of choice #10 (Q5.2) and #35 (Q-B5)
settled at Gate 2 in architecture.md. No new dependency, no project-wide
convention changes. They go to the user as **Decisions for Gate 2**.

### Q-1. Limits and how the per-app budget is enforced (revised for H1)

Notation: `L(app) = maxSessionMinutes(app) + END_TTL_SLACK_MS` (5 s), the
longest a group can be live; `cap = 10 000`; `burst = 120`.

**Option A (recommended): global per-app token bucket, rate derived from max session.**

| Limit | Value | Counted |
| --- | --- | --- |
| `group.create` per connection | **6 per minute** (sliding window) | Per connection, in process; forgotten on disconnect |
| `group.create` per app, burst | **120** creates at once | **Global**: in Redis across every instance (one process with memory storage) |
| `group.create` per app, sustained | **`min(120, (cap/2 - burst) / L(app))` per minute** | Global, refilled continuously |
| Live groups per app | **10 000** | Global |

Sustained rate by `maxSessionMinutes`:

| `maxSessionMinutes` | Sustained creates/min | First create after the budget empties | Full burst back after |
| --- | --- | --- | --- |
| 1 to 40 | 120 (the upper bound) | 0.5 s | 1 min |
| 60 | 81.2 | 0.7 s | 1.5 min |
| **180 (default)** | **27.1** | **2.2 s** | **4.4 min** |
| 480 (default ceiling) | 10.2 | 5.9 s | 11.8 min |
| 10 080 (an operator ceiling of one week) | 0.48 | 124 s | 4.1 h |

Why it closes H1: every live group was created (or recreated, Q-4) within
the last `L(app)`. The bucket admits at most `burst + rate x L(app)` creates
in any window of that length, which is `<= cap/2 = 5 000` by construction.
So, whatever the keep-alive, the number of instances or the number of
sockets, creates alone hold at most 5 000 live groups: **the cap is never
reached by creates**. It stays as the backstop for recreations after an
epoch change (L3) and clock skew.

What an attacker can still do (residual, M1): keep the app's bucket empty
while the script runs (20+ sockets at 6/min each). Legitimate creates in that
app then get `RATE_LIMITED` with `retryAfterMs` (at most 2.2 s at the
default, 5.9 s at 480 min) on every instance, **only while the attack runs**;
the bucket starts refilling the moment it stops. Mitigation: per-IP limits
at the reverse proxy (README). Other apps are unaffected (AC4).

Trade-off for legitimate load: a sustained 27 new groups per minute per app
at the default max session (1 600 per hour), 10 per minute at 480 min; a
burst of 120 leaders starting at once is fine. An app that needs more
concurrent groups than about 5 000 needs a larger cap (the rate scales with
it; see Q-2).

Squatting (the M2 of #10 goal): creates hold at most 5 000 groups = 0.5 % of
the 10^6 group codes, so a mistyped method B code reaches a squatter with
probability at most about 0.5 % (1 % at the cap), and `CODES_EXHAUSTED`
(20 draws) is practically impossible (0.01^20).

**Option B: the same derived rate, but per instance (in-process limiter).**
No budget key in Redis, but each instance has its own 5 000: two instances
with keep-alive reach the cap after about 10 000 / (2 x 27.1) = 184 minutes at
the default, three after about 123 minutes, and creation in the app is then
refused for up to max session (3 h, 8 h at 480) after the attack stops.
Safe only for single-instance deployments (H1 for N = 1, M3 stays).

**Option C: keep 120/min per instance and accept the DoS.** With keep-alive
(one leader return plus one leader action per group every < 20 min), one
client on one instance fills the cap in about 10 000 / 120 = 84 minutes;
N instances in about 84 / N minutes. Then **one client can block group
creation in the app for up to max session (3 h default, 8 h at the default
ceiling) after it stops**. Needs the user's explicit acceptance recorded in
STATE.md (R1).

Rejected: a sustained window of `maxSessionMinutes` length with cap/2 creates
(security's example): the same bound, but once spent it stays spent for a
full max session after the attack, and spending it needs no keep-alive at
all. The bucket has the same bound and recovers in seconds. A cap of at
least `2 x 120 x 480 = 115 200` (11.5 % code fill, a mistyped B code hits a
squatter about 1 in 9): defeats the squatting goal. Rate-limiting leader
returns: penalises flaky networks and still leaves N instances.

### Q-2. Fixed constants, env ceilings, or per app

1. **Fixed constants in `limits/constants.ts`** (recommended): the same as
   every join, door, QR and `tokens.check` budget ("Fixed, not an app
   setting", #10 Q5.2). Smallest change; no new env variable, `known-vars.ts`
   entry, startup error or config test. The sustained rate is still per app,
   because it is derived from the app's `maxSessionMinutes`. Can be made
   configurable later without a breaking change.
2. Env variable for the cap only (`MAX_LIVE_GROUPS_PER_APP`, default
   10 000): lets large multi-instance deployments raise it; the sustained
   rate scales with it automatically. Costs a `known-vars.ts` entry, env
   parsing and tests, `docs/startup-errors.md`. (The name already passes
   ADR 0015's `MAX_` family.)
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

No `retryAfterMs`: the server cannot know when a group will end. With
option A of Q-1 this code is rare (recreations after an epoch change), but
AC3 still needs it.

### Q-4. Recreated groups (`group.resume` after a restart)

1. **Counted, never refused, not charged to the budget** (recommended): the
   recreation registers the group in the live-group set (`register`, a
   separate script mode) so the count stays true; it restores a group that
   existed and is already limited by `RECREATIONS_PER_CONNECTION_PER_MINUTE`.
   The count may then exceed the cap until groups end; new creates are
   refused meanwhile. Bound (L3): only tokens from before an epoch change,
   inside their `lat` window, once per restart; the groups age out by max
   session.
2. Counted and refused at the cap with `APP_GROUP_LIMIT`: a restart into a
   full app would lose leaders' groups.
3. Not counted: the cap undercounts after a memory restart.

### Q-5. Refusal logging

**Recommended:** one `warn` per app per minute (per instance) when the app's
create budget is empty (`group_create_app_budget_exhausted`) and when the
cap refuses (`app_group_limit_reached`), with `namespace` only, the same
throttle as `warnAppBudget` in `join-service.ts`. No group code (none is
drawn), no group ID or ref, no connection ID, no count. Per-connection
refusals are not logged.

## 3. Approach

The checks run in `group.create` in this order (R2). Nothing before the
reserve stores state or draws a code:

1. `busy` -> size checks -> display name (unchanged).
2. Per-connection create rate:
   `createLimiter.tryAcquire(session.connectionId, perConnection)`; refused:
   `RATE_LIMITED` for `group.create` with `details.retryAfterMs`. In process,
   checked first, so a socket over its own limit never spends the app's
   budget (the join pattern, `join-service.ts` `budget()`).
3. **Method resolution** (moved out of `initialCodes`, M2):
   `resolveGroupMethods(app.joinMethods, message.joinMethods)`; refused:
   `JOIN_METHOD_NOT_ALLOWED`. A pure check, before the lock and before the
   reserve.
4. Under the new group's lock (`createLocked`), first:
   `liveGroups.reserve(namespace, groupId, { now, expiresAt, burst, refillPerMinute, cap })`
   with `expiresAt = groupExpiry(namespace, now)` and
   `refillPerMinute = appCreateRefillPerMinute(app.maxSessionMinutes)` (or the
   `groupLimits` override). One atomic step: budget, then cap, then add.
   - `{ ok: false, reason: 'rate', retryAfterMs }`: `RATE_LIMITED` with
     `details.retryAfterMs`, plus the throttled warning.
   - `{ ok: false, reason: 'cap' }`: `APP_GROUP_LIMIT` with
     `details.maxLiveGroups`, plus the throttled warning.
   - Either refusal: nothing drawn, nothing stored, no budget charged for a
     cap refusal.
5. **Stored-or-released guard** (R4): from a successful reserve until
   `store.create` resolves, one `try`/`finally` with a `stored` flag; if the
   group was not stored (an error return such as `CODES_EXHAUSTED`, a throw
   from `initialCodes`/`issueCodeSet`/Redis, a throwing `store.create`),
   `finally` calls `liveGroups.release(namespace, groupId)` next to the
   existing `releaseCodes`. With Redis, the reserve also registers
   `work.current()?.onAbandon(ZREM)`, so an abandoned commit drops the slot.
6. `initialCodes(app, groupId, methods)` now takes the resolved methods and
   can only fail with `CODES_EXHAUSTED`.

A create that passes the budget and then fails at codes or storage keeps its
budget charge (no refund): a full or failing app must not be hammered at
full speed. A cap refusal does not charge: no group was created.

The per-connection limiter is a `SlidingWindowRateLimiter` in `GroupService`
(window `GROUP_CREATE_WINDOW_MS = 60_000`), synchronous and in-process like
`recreateLimiter`; its key is forgotten in `disconnect()` and it and the
warning throttle are cleared on shutdown next to `recreateLimiter.clear()`
(R10). There is no in-process per-app limiter any more: the per-app budget
lives in the live-group store.

The derived rate (pure, in `limits/constants.ts`):

```ts
/** Sustained group.create rate per app (#12 H1): burst + rate x L <= cap / 2. */
export function appCreateRefillPerMinute(maxSessionMinutes: number): number {
  const lifetimeMinutes = maxSessionMinutes + END_TTL_SLACK_MS / MINUTE_MS;
  const derived = (MAX_LIVE_GROUPS_PER_APP / 2 - GROUP_CREATE_BURST_PER_APP) / lifetimeMinutes;
  return Math.min(GROUP_CREATES_PER_APP_PER_MINUTE, derived);
}
```

A static check (or a unit test) asserts `MAX_LIVE_GROUPS_PER_APP / 2 >
GROUP_CREATE_BURST_PER_APP`, so the rate is always positive.

### 3.1 Live-group store with create budget (new, both storages)

A new storage part `liveGroups: LiveGroupsStore` on `Storage`:

```ts
/** Per-app create budget and limits (#12). Values validated by `reserve`. */
export interface CreateBudget {
  now: number;
  expiresAt: number;
  /** Bucket size, safe integer >= 1. */
  burst: number;
  /** Refill per minute, finite and > 0. */
  refillPerMinute: number;
  /** Live-group cap, safe integer >= 1. */
  cap: number;
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'rate'; retryAfterMs: number }
  | { ok: false; reason: 'cap' };

/** Live groups per app (#12): the cap's count and the create budget. Never logged. */
export interface LiveGroupsStore {
  /** Charges the app's budget and adds `groupId` unless the budget is empty or the app is at the cap. Throws on invalid numbers. Idempotent for a held ID (no charge). */
  reserve(namespace: string, groupId: string, budget: CreateBudget): Promise<ReserveResult>;
  /** Adds `groupId` without budget or cap (recreation, Q-4). */
  register(namespace: string, groupId: string, expiresAt: number): Promise<void>;
  /** Removes `groupId` (group ended, invalid, or its create failed). */
  release(namespace: string, groupId: string): Promise<void>;
  /** Forgets local state (server shutdown). */
  clear(): void;
}
```

The bucket: `tokens` (a float) and `at` (ms). Refill:
`tokens = min(burst, tokens + max(0, now - at) x refillPerMinute / 60 000)`;
a missing bucket is full. Refused when `tokens < 1`, with
`retryAfterMs = ceil((1 - tokens) x 60 000 / refillPerMinute)`. Charge:
`tokens -= 1`, `at = max(at, now)` (never moves back on clock skew).

- **Memory** (`MemoryLiveGroups`, `src/groups/live-groups.ts`): with memory
  storage there is one process, so "global" and "per process" are the same.
  `Map<namespace, { live: Map<groupId, expiresAt>, bucket }>`; every method
  body is synchronous (check, charge and add atomic in-process, like
  `CodeIndex`); `reserve` first drops entries past `expiresAt`; an app's
  entry is deleted when its live map is empty and its bucket is full, so the
  number of keys is bounded by apps with live groups or recent creates. A
  restart loses the bucket and the set (both start empty/full); recreations
  register (Q-4).
- **Redis** (`RedisLiveGroups`, `src/storage/redis/live-groups.ts`), two
  keys per app, both built by `RedisKeys` with the namespace checked against
  `NAMESPACE_PATTERN`:
  - `appLive(ns)` -> `<base>:lg:<ns>`: sorted set, member = group ID (checked
    against `GROUP_ID_PATTERN` before the call), score = `expiresAt`.
  - `appCreateBudget(ns)` -> `<base>:lb:<ns>`: hash `{ t: tokens, a: at }`.
  - A new constant Lua script `RESERVE_LIVE` in `scripts.ts`. KEYS: the set,
    the bucket. ARGV: mode (`reserve` | `register`), member, now, expiresAt,
    and for `reserve` cap, burst, refill per ms. Steps (R5):
    1. Every number via `tonumber`; `nil`, or for `reserve` cap/burst not an
       integer >= 1 or refill not > 0: `redis.error_reply`.
    2. `ZREMRANGEBYSCORE set -inf (now` (prune).
    3. Member already present: raise its score to `expiresAt` if higher,
       extend the TTL, return ok (no charge).
    4. Mode `register`: `ZADD`, extend the TTL, return ok.
    5. Refill the bucket; `tokens < 1`: return `{rate, retryAfterMs}`
       without writing.
    6. `ZCARD >= cap`: return `cap` without charging.
    7. Charge (`HSET t a`), `PEXPIRE` the bucket to the time it takes to be
       full again plus 1 s (a missing bucket is full, so expiry is exact),
       `ZADD`, extend the set's TTL.
    The set's TTL is only ever extended to its largest score: read with
    `PEXPIRETIME` (handles -1 no expiry and -2 missing) and `PEXPIREAT` only
    when larger.
  - Mirrors `RedisCodeIndex.claim`: a fresh reservation registers
    `work.current()?.onAbandon(...)` that `ZREM`s it if the task or its
    commit fails (best effort; the score bounds it anyway; the budget charge
    is not refunded). `release` inside a running unit of work adds a commit
    step `plan.zrem(key, groupId)` (like `RedisCodeIndex.release`), else
    runs its own unfenced plan.
- `reserve` (both storages) throws before any call if `cap` or `burst` is
  not a safe integer >= 1 or `refillPerMinute` is not finite and > 0 (R7).
  `register` never takes a cap.
- `GroupService.endGroup` releases in the same commit as `store.delete` (the
  `plan.zrem` step). Not in `forgetGroup` (that also runs for the cluster
  `forget` op, which only drops local state on other instances) (R6).
- `RedisEndedGroups.endInvalid` adds `plan.zrem(keys.appLive(namespace), groupId)`
  to its writes (L1, R6). The memory sweeper has no invalid documents.
- `recreate` calls `liveGroups.register(...)` only after `createIfAbsent`
  returned `created`, with `expiresAt = groupExpiry(namespace, claims.gct)`;
  a failed recreation commit undoes it through `onAbandon`; nothing on
  `exists` (R8).
- Groups that leave Redis without an `endGroup` (TTL expiry after an outage,
  a crashed instance) are pruned by score at the next reserve: drift is
  bounded by the group's end bound, never permanent.

Rejected: counting from the code index (groups with only method D or C have
no group code, and Redis code keys cannot be counted per app); counting from
the global `keys.live()` set (members `ns:gid` of every app, no per-app count
without a scan); an `INCR`/`DECR` counter (drifts for ever on a crash; the
sorted set self-heals by score); checking the cap inside the commit script
(changes the commit script for every write); a separate budget script before
the lock (two round trips, and a cap refusal would still charge).

## 4. Files to create / modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/errors.ts` | Add `APP_GROUP_LIMIT` with a doc comment (per Q-3). |
| `packages/protocol/test/codes.test.ts` | Covered by the existing key = value loop; add one explicit assertion. |
| `apps/sync-server/src/limits/constants.ts` | `GROUP_CREATES_PER_CONNECTION_PER_MINUTE = 6`, `GROUP_CREATE_WINDOW_MS = 60_000`, `GROUP_CREATE_BURST_PER_APP = 120`, `GROUP_CREATES_PER_APP_PER_MINUTE = 120` (upper bound of the sustained rate), `MAX_LIVE_GROUPS_PER_APP = 10_000`, and `appCreateRefillPerMinute(maxSessionMinutes)` (section 3), documented like the join constants. |
| `apps/sync-server/src/groups/live-groups.ts` (new) | `LiveGroupsStore`, `CreateBudget`, `ReserveResult`, the shared validation and bucket arithmetic, `MemoryLiveGroups`. |
| `apps/sync-server/src/storage/redis/live-groups.ts` (new) | `RedisLiveGroups`. |
| `apps/sync-server/src/storage/redis/keys.ts` | `appLive(ns)` -> `<base>:lg:<ns>`, `appCreateBudget(ns)` -> `<base>:lb:<ns>`. |
| `apps/sync-server/src/storage/redis/scripts.ts` | `RESERVE_LIVE` Lua script (constant string, all values in KEYS/ARGV). |
| `apps/sync-server/src/storage/redis/ended.ts` | `endInvalid`: `ZREM` from `appLive(namespace)` in the same plan (L1). |
| `apps/sync-server/src/storage/storage.ts` | `liveGroups` on `Storage`; `memoryStorage` wires `MemoryLiveGroups`. |
| `apps/sync-server/src/storage/redis/redis-storage.ts` | Wires `RedisLiveGroups(ctx, work)`. |
| `apps/sync-server/src/server.ts` | Pass `storage.liveGroups` into `GroupServiceDeps`; optional test-only `groupLimits?: { perConnection?, appBurst?, appRefillPerMinute?, maxLiveGroups? }` on `SyncServerOptions` (defaults: the constants and the derived rate), same pattern as `endedGroupsCap` / `replayCap`. `createSyncServer` throws if a given value is not a positive safe integer (`appRefillPerMinute`: finite and > 0). Not read from env, the apps file or any client input; `main.ts` does not pass it (R7). |
| `apps/sync-server/src/joins/join-service.ts` | `initialCodes(app, groupId, methods)` takes resolved methods; only `CODES_EXHAUSTED` remains as a failure. |
| `apps/sync-server/src/groups/group-service.ts` | Per-connection limiter, method resolution before the lock, `reserve` with budget in `createLocked`, the stored-or-released guard, release in `endGroup`, `register` in `recreate`, forget in `disconnect`, clear on shutdown, throttled warnings. |
| `apps/sync-server/src/ws/error-messages.ts` | Fixed text for `APP_GROUP_LIMIT`, e.g. `'The app has too many live groups; try later'`. |
| `packages/client/src/errors.ts` | `MESSAGES` text and `KnownDetails.APP_GROUP_LIMIT: { maxLiveGroups?: number }` (tolerant parsing). |
| `apps/reader/src/group/errors.ts` | `case 'APP_GROUP_LIMIT':` next to `CODES_EXHAUSTED` -> `errBusy`. `RATE_LIMITED` on create already maps to `errRateLimited` with the wait. |
| Tests (section 7) | New `group-create-limits.int.test.ts`, `live-groups.test.ts` (bucket arithmetic, validation, the H1 simulation), contract `liveGroupsContract` in `test/contracts/state.ts` run from `storage-contracts.test.ts` and `redis-storage-contracts.redis.test.ts`; a Redis multi-instance case; additions to `constants` tests, `keys.test.ts`, the `endInvalid` Redis test, `error-messages.test.ts`, client `errors.test.ts`, reader error test. |
| `README.md`, `packages/client/README.md`, `docs/conventions.md` | Docs chunk (section 6). |

## 5. Contracts

### 5.1 Wire (protocol stays version 1)

`group.create` gains two refusals; its success reply is unchanged.

| Refusal | Frame |
| --- | --- |
| Per-connection rate, or the app's create budget is empty | `{type: 'error', reqId, code: 'RATE_LIMITED', message, details: {retryAfterMs: number}}` (same shape as `tokens.check` / join refusals) |
| Live-group cap | `{type: 'error', reqId, code: 'APP_GROUP_LIMIT', message, details: {maxLiveGroups: number}}` (the configured constant, never the current count) |

Fixed message texts from `error-messages.ts`. The connection stays open; no
group, code, token or timer is created (R3). Precedent for adding codes
without a version bump: #10 and #13. An older client that receives
`APP_GROUP_LIMIT` fails its `z.enum(ErrorCode)` parse and rejects the request
as `INVALID_SERVER_MESSAGE`; acceptable because server and clients ship from
this repo, and it is listed under Upgrading.

### 5.2 Redis data

Two new keys per app, no user data (namespaces and group IDs are already key
parts):

- `<prefix>:v1:lg:<namespace>`: sorted set of group IDs scored by their end
  bound (ms), `PEXPIREAT` at the largest score.
- `<prefix>:v1:lb:<namespace>`: hash `{t, a}` (tokens, last charge ms),
  `PEXPIRE` at the time it is full again.

Commands: `ZREMRANGEBYSCORE`, `ZSCORE`, `ZCARD`, `ZADD`, `ZREM`, `HMGET`,
`HSET`, `PEXPIRE`, `PEXPIREAT`, `PEXPIRETIME` inside the script: all
covered by the README's ACL (`+@read +@write +@scripting`); `PEXPIRETIME`
needs Redis 7, within the README's minimum (7.2) and already used by the
existing scripts. No migration: the keys are created on the first create
after the upgrade; groups that existed before the upgrade are not counted
until they end (undercount for at most one max session). Documented in
Upgrading.

`Docker impact: none.`

## 6. Docs impact

- `README.md`:
  - "Fixed join limits" renamed "Fixed join and creation limits", with rows:
    6 creates per connection per minute; per app a burst of 120 and a
    sustained rate derived from `maxSessionMinutes` (the table of Q-1, the
    formula in one line); 10 000 live groups per app; the error codes; why
    (creates can hold at most half the cap, so the cap cannot be filled by
    creates).
  - "Limits with several instances" table: create rate per connection = per
    instance; per-app create budget and live groups per app = global.
  - Residuals, replacing the "Group-code squatting ... Tracked in issue #12"
    bullet (R11): creates hold at most 0.5 % of group codes (1 % at the
    cap); a single client can keep an app's create budget empty while it
    runs (`RATE_LIMITED` on every instance, back within seconds after it
    stops); per-IP limits at the reverse proxy are the operator's
    mitigation (M1); the cap and the budget are global while connections
    are per instance, and raising `MAX_SESSION_MINUTES_CEILING` lowers the
    sustained create rate of apps that use the longer sessions (L4).
  - Errors list in "Protocol (v1) in brief": add `APP_GROUP_LIMIT`.
  - "Upgrading": live groups created before the upgrade are not counted;
    old clients see `APP_GROUP_LIMIT` as an invalid server message.
- `packages/client/README.md`: errors table row for `APP_GROUP_LIMIT`; note
  that `createGroup()` can now reject with `RATE_LIMITED` (`retryAfterMs`).
- `docs/conventions.md`: one row under "Sync server" recording the Gate 2
  choices (Q-1 to Q-5) with a link to this file.
- No `package.json` change (no new dependency).

## 7. Test plan

Server tests use `TestClock`/manual scheduler and lowered `groupLimits`
(for example per-connection 2, app burst 3, refill 1/min, cap 2) so no test
creates thousands of groups; one test checks the real constants' values.

| AC / control | Test |
| --- | --- |
| R1 (H1) inequality | Unit: for `maxSessionMinutes` in {1, 40, 41, 180, 480, 10 080}, `appCreateRefillPerMinute(m) > 0`, `<= 120`, and `GROUP_CREATE_BURST_PER_APP + rate x (m + END_TTL_SLACK_MS/60 000) <= MAX_LIVE_GROUPS_PER_APP / 2`. Values at 180 and 480 match the README (27.1, 10.2). |
| R1 (H1) simulation | Unit on `MemoryLiveGroups` with the real constants and a simulated clock, for `maxSessionMinutes` 180 and 480: reserve as fast as the bucket allows for `2 x L` simulated minutes and never release (worst-case keep-alive): the live count never exceeds `cap / 2` and no reserve returns `cap`. |
| AC1 per-connection rate | int: one client creates, ends, creates ... until refused: `RATE_LIMITED`, `details.retryAfterMs > 0`; the code index size and live count are unchanged by the refused create (a `codeRandom` that counts calls: zero draws); after the window passes, create works; a reconnect resets it. |
| AC2 per-app budget | int: several clients of app-a exceed the burst: `RATE_LIMITED` with `retryAfterMs`, zero draws, live count unchanged; after `retryAfterMs` one more create works (refill); a connection already over its own rate does not spend the app budget. |
| AC2 across instances | `.redis`: two instances on one prefix share the app's budget: burst 3 split over both admits exactly 3. |
| AC3 live-group cap | int (cap 2, large burst): fill the cap with abandoned groups (create, disconnect): the next create gets `APP_GROUP_LIMIT` with `maxLiveGroups`, distinct from `RATE_LIMITED`, zero draws, no group stored, budget not charged; after one group ends (`group.end`), a create works again. |
| R4 (M2) failure paths | int: after a successful reserve the live count is unchanged afterwards for `CODES_EXHAUSTED`, a throwing `store.create` (store stub) and, in `.redis`, an abandoned commit (fenced or failing commit). A disallowed `joinMethods` returns `JOIN_METHOD_NOT_ALLOWED` with zero `reserve` calls (spy) and an unchanged budget. |
| R6 / L1 | `.redis`: `endInvalid` of a counted group removes it from `appLive`; `forgetGroup` does not; `endGroup` removes it in the delete's commit. |
| R7 / L2 | Unit: `reserve` throws for cap/burst 0, -1, 1.5, `NaN`, `Infinity` and refill 0, -1, `NaN`; the script returns an error reply for a non-number ARGV; `createSyncServer` throws for an invalid `groupLimits`; `main.ts` builds no `groupLimits` (grep-style assertion or review). |
| AC3 storage parity | `liveGroupsContract` for memory and Redis: reserve to the cap, refuse at the cap without charging, budget empties and refills with the right `retryAfterMs`, idempotent re-reserve without charge, release frees a slot, `register` ignores budget and cap, expired entries pruned, per-app isolation, TTLs set and only extended (Redis). |
| AC3 across instances | `.redis`: the cap counts groups of both instances; concurrent reserves on both at cap - 1 admit exactly one. |
| R8 / Q-4 | int: a recreation at the cap succeeds, is counted, does not charge the budget, and the next create is refused with `APP_GROUP_LIMIT`. |
| AC4 isolation | int: app-a with an empty budget and at its cap; app-b creates normally. |
| AC5 / R9 logs | `LogCapture` over every refusal path: no 6-digit or alphanumeric code, no group ID or ref, no connection ID, no count; each warning appears once per minute per app with `namespace` only; none for per-connection refusals. |
| R10 | Unit: `disconnect()` forgets the per-connection key; shutdown clears the limiter and the throttle. |
| `keys.test.ts` | `appLive` and `appCreateBudget` reject a bad namespace. |
| AC6 README | Docs chunk; QA reviews. |
| AC8 checks | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Redis tests locally; no `package.json` dependency change. |

Existing tests must keep passing with the real constants: some create up to
13 groups per app in one server, below the burst of 120; any test that
exceeds a limit gets a raised `groupLimits` rather than a changed constant.

## 8. Risks / edge cases

- **App-wide create DoS while a flood runs** (residual, M1): a client with
  20+ sockets keeps an app's budget empty; legitimate creates get
  `RATE_LIMITED` with a wait of at most 2.2 s (default) to 5.9 s (480 min)
  per token, on every instance, and the budget refills as soon as the flood
  stops. It no longer outlasts the attack: creates cannot fill the cap (H1
  closed), whatever the keep-alive or the number of instances (M3 closed).
  Operator mitigation: per-IP limits at the reverse proxy.
- **Legitimate load above the sustained rate**: an app that needs more than
  about 27 new groups per minute for hours (default max session) is
  throttled. Fix by raising the cap (Q-2 option 2 or 3, follow-up); the rate
  scales with it.
- **Long operator ceilings**: a `MAX_SESSION_MINUTES_CEILING` of a week
  gives apps that use it 0.48 creates per minute. Documented.
- **Cap reached after an epoch change**: recreations (Q-4) can push the
  count over the cap for at most one max session after a Redis data loss or
  a memory restart; new creates get `APP_GROUP_LIMIT` meanwhile. Not
  attacker-triggerable (L3).
- **Reservation leaks**: every path after a reserve that stores no group
  releases (guard, section 3 step 5); a crash between reserve and commit
  leaves a slot until its score passes (at most max session plus slack).
- **Fenced or unreachable Redis**: `reserve` throws like other storage calls;
  the existing handling (1001 / `INTERNAL_ERROR`) applies; `onAbandon`
  drops the slot.
- **Clock**: scores and the bucket use the server clock like code-claim TTLs
  and ended entries; the bucket's `at` never moves back, so skew cannot
  mint tokens beyond the skew itself; instances must keep clocks in sync
  (already required).
- **Rate charged on later failure**: intended (section 3).

## 9. Security

Security-sensitive: yes

- Abuse limits on a message handler that accepts anonymous input
  (`group.create`, public API key): order of checks, no code drawn before
  refusal, per-app isolation, global per-app budget (`group-service.ts`,
  `groups/live-groups.ts`).
- New Redis key families and a Lua script: key parts checked in `keys.ts`,
  constant script with `KEYS`/`ARGV` only, numbers validated
  (`keys.ts`, `scripts.ts`, `storage/redis/live-groups.ts`).
- `endInvalid` writes (`storage/redis/ended.ts`).
- Logging of refusals: namespace only (`group-service.ts`).
- New wire error code and details (`packages/protocol/src/errors.ts`).

Findings of [security.md](security.md) round 1 and where they are handled:

| Finding / control | Handling | Chunk |
| --- | --- | --- |
| H1, R1 | Global per-app token bucket with derived rate (Q-1 option A); inequality and simulation tests | 2, 3, 4 |
| M1 | README residual, per-IP limits at the proxy | 5 |
| M2, R4 | Method resolution before reserve; stored-or-released guard; failure-path tests | 3, 4 |
| M3 | Closed by the global budget (option A) | 2, 4 |
| L1, R6 | `endInvalid` ZREM; release in `endGroup`'s commit; not in `forgetGroup` | 2, 4 |
| L2, R7 | `reserve` validation; `register` as a separate mode; `groupLimits` validated, not wired in `main.ts` | 2, 3 |
| L3, R8 | `register` only on `created`, undone on abandon; test at the cap | 4 |
| L4 | README; mostly closed, since every live group needs a create | 5 |
| L5 | No action (aggregate timing only) | - |
| R2 | Section 3 order (method resolution moved before the lock; it is pure) | 3, 4 |
| R3 | Section 5.1 | 1, 4 |
| R5 | Section 3.1 script steps | 2 |
| R9 | Q-5, `LogCapture` tests | 4 |
| R10 | Section 3 | 3 |
| R11 | Section 6 | 5 |

## 10. Implementer model

Implementer model: opus
Security-sensitive abuse limits, a new storage part with a Lua script that
combines a token bucket and a cap atomically across instances, unit-of-work
and abandon handling, a wire error code, and more than 3 files.

## 11. Implementation chunks

1. `feat(protocol): add APP_GROUP_LIMIT error code` (protocol, server
   `error-messages.ts`, client `errors.ts`, reader `errors.ts`, their tests)
2. `feat(storage): add live-group store with per-app create budget`
   (interface, validation, bucket arithmetic, memory, Redis, keys, script,
   `endInvalid` ZREM, `Storage` wiring, contract tests, multi-instance
   tests)
3. `fix(server): limit group creation rate per connection` (constants and
   `appCreateRefillPerMinute` with the H1 inequality and simulation tests,
   per-connection limiter, validated `groupLimits`, method resolution moved
   before the lock and `initialCodes` signature, int tests)
4. `fix(server): enforce per-app create budget and live-group cap`
   (`reserve` in `createLocked`, stored-or-released guard, release in
   `endGroup`, `register` in `recreate`, throttled warnings, int tests incl.
   failure paths, isolation and logs)
5. `docs(server): document group creation limits` (README, client README,
   `docs/conventions.md` Gate 2 row)

Chunk names follow the recommendations; if the user picks other options at
Gate 2, the engineer adjusts them: Q-1 option B drops the budget hash and
Redis budget from chunk 2 and adds an in-process per-app limiter in chunk 3;
option C additionally uses a flat 120/min and records the user's acceptance
in STATE.md; Q-3 option 3 drops chunk 1; Q-2 option 2 or 3 adds a config
chunk with `known-vars.ts` and `docs/startup-errors.md`.

# Architecture: #35 Redis storage with restart survival and several instances (PRD item 9a)

Spec: [`spec.md`](spec.md) (AC1-AC32; AC33+ belong to #36 and #37).
Gate 1 decisions: [`STATE.md`](STATE.md). Path: full. No UI change, no designer phase.

## 0. Summary

- **Delivered as two PRs on this issue** (section 1.1):
  - **PR 1** (this branch, this draft PR): Redis store, restart survival, server-side
    block lists after a restart, Redis config and startup errors, failure behaviour,
    store connectivity state, compose override, CI with Redis. One instance only,
    documented in the README until PR 2 (AC6 interim, as the spec allows).
  - **PR 2** (branch `feat/35-redis-multi-instance` from `main` after PR 1 merges):
    several instances on one Redis: fenced per-group lease lock, cross-instance
    effects over pub/sub, attachment registry and orphan sweep, method B approvals and
    parked members across instances, the two-instance compose example. Its plan is
    outlined in section 12 and detailed in a revision of this file before PR 2 starts
    (its own Gate 2 pass).
- **Design in one line:** one JSON document per group in Redis, written in one
  `MULTI`/`EXEC` at the end of each locked group task (unit of work, ADR 0011), with
  session effects flushed only after the commit; timers as a due-time sorted set with
  lease claiming (ADR 0013); a store "epoch" replaces the process-start fence for
  recovery; an attachment sweep at startup applies a fresh grace after a restart (Q9).
- **ADRs (Proposed):** [0010](../../decisions/0010-redis-client-and-supported-servers.md)
  Redis client and servers, [0011](../../decisions/0011-group-atomicity-with-redis.md)
  atomicity, [0012](../../decisions/0012-cross-instance-event-delivery.md) cross-instance
  delivery (PR 2), [0013](../../decisions/0013-persistent-group-timers.md) timers,
  [0014](../../decisions/0014-behaviour-while-redis-is-unreachable.md) behaviour while
  Redis is down.
- **Protocol change: none** in PR 1 or PR 2 (with ADR 0014 option 1). The meaning of
  close code `1001` widens in the docs to "going away or temporarily unavailable".
  If the user picks ADR 0014 option 2 instead, a new error code
  `STORAGE_UNAVAILABLE` is a protocol addition and must land before the 9c freeze.
- Security-sensitive: yes (section 10). Implementer model: opus (section 11).

## 1. Approach

### 1.1 Two PRs, and why

9a has 32 criteria and combines two different problems: making state durable and
consistent against one Redis (restart survival, failures), and making it consistent
across processes (distributed locking, delivery, timer ownership, failover). Each is a
large, risky change on the core of the server (about 4,000 lines of group logic); in
one PR the review would mix storage bugs with distribution bugs and the security
review would face both at once.

Split:

| PR | ACs | Why this cut |
| -- | --- | ------------ |
| PR 1 | AC1-AC5, AC6 (interim: README "one instance only"), AC7 (all bullets except pending approvals), AC8-AC15, AC22 (per-instance limits stay as they are; README says so), AC24-AC28, AC29 (store contract suite + restart tests), AC30, AC31, AC32 (Redis settings, restart, lifetime) | Everything a single instance needs. It builds every foundation PR 2 needs (unit of work, effect outbox, timer backend, async state interfaces, key layout) so PR 2 adds, not rewrites. |
| PR 2 | AC6, AC7 (pending approvals), AC16-AC21, AC22 (tests across instances), AC23, AC29 (several-instance tests), AC32 (several instances) | Distribution only. |

Pending approvals (AC7 bullet 5) move to PR 2: on one instance they can never survive a
restart usefully, because the joiner's socket dies with the process and AC20 says the
joiner then sends a new request. Gate 2 question Q-A5.

No single-instance guard is built (Q8). Until PR 2 lands, running two instances on one
Redis is unsupported and the README says so in bold.

### 1.2 Key decisions

1. **Unit of work per locked task (ADR 0011).** The Redis store reads a group's keys
   once per locked task into a task-scoped cache (`AsyncLocalStorage`), applies every
   `GroupStore` call to the cache with the same logic as `InMemoryGroupStore`, buffers
   timer and side-key changes, and commits once in `MULTI`/`EXEC` when the task
   returns. A failed commit writes nothing (AC26: never half-updated).
2. **Effect outbox (both stores).** Inside a locked task, `deliver`, `broadcast`,
   `deliverLater`, the `replaced`/`removed`/`ended` detaches and socket closes are
   queued in order and flushed after the commit. On a failed commit they are dropped and
   the group's local sessions are closed with `1001` (ADR 0014). One code path for both
   stores; on the in-memory store the commit cannot fail and the per-socket order is
   unchanged (AC1).
3. **Persistent timers (ADR 0013).** `GroupTimers` dispatches by kind through a
   backend: `setTimeout` in memory; a due sorted set with lease claiming in Redis.
4. **Async state interfaces.** `CodeIndex`, `EndedGroups` and `DoorGuard` become
   interfaces with a memory implementation (today's classes, wrapped in promises where
   needed) and a Redis implementation that joins the unit of work.
5. **Store epoch replaces the process-start fence.** `#13 6.9` uses
   `processStartedAt`: "a group not in memory whose token was issued by this process has
   ended". With Redis the store outlives the process, so the fence moves to the store:
   `<prefix>:v1:epoch` holds the time the keyspace was first used. A group missing from
   Redis whose token's `iat` is at or after the epoch has ended. If Redis comes back
   empty (flush, new server), the epoch key is gone; the next miss sets a new epoch
   (`SET NX`), so older tokens become `recoverable` and the #5/#13 recreation rules apply
   unchanged (AC14). Memory mode: the epoch is the process start, as today.
6. **Startup sweep (PR 1) with a restart grace (Q9).** Before listening, after the
   past-due timers ran (AC12), every live group's attachments from the previous process
   are treated as disconnected **now**: a leader online at shutdown goes offline with a
   full `disconnectGraceSeconds` from now (AC11), members leave `participantIds` and are
   marked disconnected in the roster, an empty group is held (the existing hold rule).
   A pause or hold that was already running keeps its deadline unless that deadline is
   earlier than `now + disconnectGraceSeconds`, in which case it moves to that time
   (Gate 2 Q-A3). PR 2 turns this into the per-instance orphan sweep.
7. **A clean stop in Redis mode does not run the disconnect rules.** `close()` closes
   the sockets with `1001` but leaves the stored attachments, so the restart grace counts
   from when the server is back (AC11), not from the stop. (Memory mode: unchanged.)
8. **Fail fast while Redis is down (ADR 0014).** No offline queue, a command timeout,
   `1001` closes, 503 at the upgrade, and an in-memory replay queue of disconnects.

### 1.3 Alternatives rejected

- **Redis behind the existing store calls, one command per call.** Fails AC26 (a drop
  between two of the up to eight calls of one operation leaves a half-updated group).
- **Optimistic concurrency or group ownership** for PR 2: see ADR 0011 options 2 and 3.
- **Hashes per group with one field per record field.** Partial updates save bytes but
  the record is read whole on almost every operation, and a JSON document matches the
  in-memory record one to one (zod-validated on read).
- **Redis hash-field TTLs (`HEXPIRE`) for codes.** Needs Redis 7.4; one key per code
  with `PXAT` works on 7.2 (ADR 0010 floor).
- **A single-instance guard in PR 1.** Q8: not built.

## 2. Repo layout

- Layout: **monorepo** (pnpm workspace, `apps/*` and `packages/*`; no submodules:
  `git submodule status` is empty; `pnpm-workspace.yaml`; no turbo or nx).
- Touched: `apps/sync-server` (all code), root `compose.yaml` neighbour
  `compose.redis.yaml` (new), `.github/workflows/ci.yml`, `README.md`,
  `docs/conventions.md`, `docs/decisions/`.
- Not touched: `packages/protocol`, `packages/client`, `packages/react`, `apps/reader`
  (their suites must pass unchanged, AC1).
- Checks: root `pnpm audit --audit-level=high`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm build`; `docker compose config` and
  `docker compose -f compose.yaml -f compose.redis.yaml config`.
- No other repo needs changes; no linked issue.

## 3. Configuration (AC2-AC5, AC28)

New env variables, parsed in `parseEnv` and reported with every other problem in one
`Config error: <message>` (AC3). Messages name the variable only, never a value, URL,
host, user or password.

| Variable | Default | Rule |
| -------- | ------- | ---- |
| `REDIS_URL` | unset (memory store) | `redis://` or `rediss://` only; a host; optional port 1-65535; optional user and password; path empty or `/<db>` with db 0-15; no query string or fragment (rejected, so no option is ever silently ignored). Parsed with `new URL`; an unparseable value gives `REDIS_URL is not a valid redis:// or rediss:// URL`. Never stored in `ServerEnv` as a string that gets logged: it lives in a separate `RedisSettings` object, like the token secret. |
| `REDIS_KEY_PREFIX` | `sync` | `^[a-z0-9][a-z0-9_-]{0,31}$`. Keys are `<prefix>:v1:...`. Checked even when `REDIS_URL` is unset, so a typo is caught before Redis is turned on. |
| `REDIS_CONNECT_TIMEOUT_SECONDS` | `10` | Integer 1-120: the bound for the startup connection (AC4) and each reconnect attempt. |
| `REDIS_COMMAND_TIMEOUT_MS` | `2000` | Integer 100-30000: a command or commit not answered in time counts as "unreachable" (AC26). |

Startup (`main.ts`, after config, before `listen`), only when `REDIS_URL` is set:

1. `await import('@redis/client')` (ADR 0010; never imported otherwise, AC28).
2. Connect with `socket.connectTimeout`, `disableOfflineQueue: true`, a reconnect
   strategy of `min(2^n * 100 ms, 5 s)` with jitter, and an `error` listener that logs
   `{event: 'redis_error', err: safeErr(err)}` at most once per 30 s (AC25).
3. Bounded by `REDIS_CONNECT_TIMEOUT_SECONDS`: on failure, `Startup error: <message>`
   and exit 1 (AC4). The cause is classified from the error code only:
   - `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, a timeout:
     `Redis is unreachable (REDIS_URL)`;
   - `WRONGPASS`, `NOAUTH`, `NOPERM`: `Redis authentication failed (REDIS_URL)`;
   - TLS codes (`ERR_TLS_*`, `CERT_*`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
     `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_SSL_*`): `Redis TLS handshake failed (REDIS_URL)`;
   - anything else: `Redis connection failed (REDIS_URL)`.
4. `INFO server`: `redis_version` below 7.2.0 gives
   `Startup error: Redis 7.2 or later is required` (Valkey reports 7.2.x).
5. `INFO memory`: if `maxmemory_policy` is not `noeviction`, a startup **warning**
   `redis_eviction_policy` (Redis may silently evict live groups). Not an error (managed
   Redis may not let the operator change it). Gate 2 Q-A6.
6. A warning `redis_no_password` when `NODE_ENV=production` and the URL has no password.
7. Epoch init, past-due timers, startup sweep (sections 4.5, 6, 7). A Redis failure
   during these is `Startup error: Redis connection failed (REDIS_URL)`.

## 4. Redis data model (PR 1; PR 2 additions marked)

### 4.1 Keys

`P` = `<REDIS_KEY_PREFIX>:v1`. `ns` = app namespace (`^[a-z0-9][a-z0-9_-]*$`), `gid` =
43-char base64url group ID, `ref` = the existing hashed group ref (32 hex chars). None
of these contain `:`, so keys are unambiguous. Two prefixes never share a key (AC5).

| Key | Type | Content | TTL (`PXAT`) |
| --- | ---- | ------- | ------------ |
| `P:epoch` | string | epoch ms when this keyspace started | none (deployment metadata, no group or personal data) |
| `P:g:<ns>:<gid>` | string | group document JSON `{v:1, record, door?}` (`record` = every `GroupRecord` field: block list, roster, codes, vice, lock, pause, term, ...; `door` = `DoorGuard` state) | the group's end bound `E` (4.2) |
| `P:c:<ns>:g:<groupCode>` | string | `gid` holding the 6-digit group code | `E` of the holder |
| `P:c:<ns>:a:<alphaCode>` | string | `gid` holding the alphanumeric code | `E` of the holder |
| `P:t:<ns>:<gid>` | hash | timer kind -> `{at, data}` JSON | `E` |
| `P:due` | sorted set | member `<ns>:<gid>:<kind>`, score = due ms (or lease end) | shared; `PEXPIRE ... GT` to the latest `E` on every add |
| `P:live` | sorted set | member `<ns>:<gid>`, score = `E` (index of live groups for the startup sweep) | shared; `PEXPIRE ... GT` as above |
| `P:e:<ref>` | string | ended-group entry `{ns, guardUntil?}` | the group's max-session deadline (as in memory) |
| `P:e:plain`, `P:e:guarded` | sorted sets | `ref` by insertion sequence (eviction order, #13 6.9 layer 3) | shared; `PEXPIRE ... GT` |
| `P:e:gns` | hash | `ns -> guarded count` | shared; `PEXPIRE ... GT` |
| `P:e:closed` | hash | `ns -> recovery closed until` | shared; `PEXPIRE ... GT` |
| `P:e:seq` | string | insertion counter | shared; `PEXPIRE ... GT` |
| PR 2: `P:lock:<ns>:<gid>` | string | lease token | 10 s, renewed |
| PR 2: `P:inst:<id>` | string | liveness of an instance | 15 s, renewed every 5 s |
| PR 2: `P:inst:<id>:groups` | set | `<ns>:<gid>` with attachments on that instance | `PEXPIRE ... GT` |
| PR 2: `P:ap:<ns>:<gid>:<requestId>` | string | pending approval `{displayName?, deadline, owner}` | the request deadline (AC20) |
| PR 2: `P:ap:<ns>:<gid>` | sorted set | request IDs by deadline | latest request deadline |
| PR 2: `P:pk:<ns>:<gid>` | hash | parked `pid -> instanceId` | the parking bound |
| PR 2: channel `P:ch:<instanceId>` | pub/sub | effects for that instance (ADR 0012) | n/a |

The group document also holds, from PR 2, the attachment registry `att: {pid ->
instanceId}`, outside `GroupRecord` (memory mode never needs it).

Nothing in Redis holds a token, the token secret, a QR ticket key, an API key or a
codes-blob key (AC8). QR tickets stay stateless.

### 4.2 Lifetimes (AC24)

- `E` = `createdAt + app.maxSessionMinutes` (recomputed from the current app config on
  every commit) **plus `END_TTL_SLACK_MS` = 5 s**, so the max-session timer can still
  read the document, notify the participants (`group.ended max_session`) and write the
  ended entry before Redis drops the key. Gate 2 Q-A2 (AC24 says "no later than the
  group's latest possible end"; with a timer that fires on a 1 s poll the latest
  possible end is the deadline plus that bound).
- The ended entry lives until the max-session deadline; its guard is at most that.
- Every key of a group (document, codes, timers, `due` and `live` members, PR 2 lock,
  approvals, parking) is deleted in the same commit that ends the group. Codes are
  deleted only if they still point at this group (compare in Lua).
- Shared index keys get `PEXPIRE ... GT` so an idle deployment's keyspace disappears.
- No key holds a display name except inside a group document (roster) or a pending
  approval (PR 2); both go with the group. The README tells operators to run Redis
  without RDB/AOF persistence unless they need groups to survive a Redis restart
  (privacy: names of possible minors).

### 4.3 Document validation

The document is parsed with a zod schema (`v: 1`). A document that fails the schema
(another program wrote under the prefix, or a future version) is logged as
`{event: 'store_document_invalid'}` with no key and no content, and the operation
fails with `INTERNAL_ERROR` (never treated as missing, so it can never trigger a
recreation that overwrites it).

### 4.4 Atomic steps outside the unit of work

- **Code claims** (`claim`, `claimFullSet`, `initialCodes`, `restoreCodes`) run at draw
  time, possibly before the group exists. A Lua script sets every code key of the set
  only if each is free or already this group's (`R14` all-or-none), with `PXAT`
  of the group's `E`. A claim the commit later abandons is released (compare-and-delete)
  and is bounded by its TTL anyway.
- **`create`** writes the new document directly (`SET ... NX PXAT`), plus `live`
  member and timers, in one `MULTI`: a fresh 256-bit ID cannot be held by anyone.
- **`createIfAbsent`** (recreation): `SET NX` inside the unit of work's commit; `exists`
  is detected by the commit script, so two concurrent recreations create one group.
- **Ended groups** `remember`: one Lua script that does the #13 6.9 layer 3 eviction
  (plain first, then expired guards, then the busiest namespace with a closure),
  identical order to `EndedGroups` (shared test suite).

### 4.5 Epoch

- Startup: `SET P:epoch <now> NX`, then `GET`. The service keeps the value.
- On a store miss in `classifyToken` (resume, tokens.check), the epoch is read again in
  the same round trip as the document (`MGET`). If it is missing (Redis came back
  empty), `SET NX <now>` and use the result; the cached value moves forward, and the
  `TokenService` iat floor moves with it.
- `endGroup`'s guard and `issuedInThisProcess` use the epoch instead of
  `processStartedAt`. Memory mode passes `processStartedAt` as the epoch (no change).

## 5. Store interfaces (code shape)

```
src/storage/
  storage.ts            Storage bundle: { kind, groups, codes, ended, doors, timers, epoch, uow, status }
  memory/               today's classes behind the interfaces (InMemoryGroupStore moves here, re-exported)
  redis/connect.ts      dynamic import, connect, classify startup errors, INFO checks, status events
  redis/keys.ts         every key builder (one place; tests assert the prefix on all of them)
  redis/document.ts     zod schema of the group document
  redis/unit-of-work.ts task-scoped cache + buffered writes + MULTI/EXEC commit
  redis/group-store.ts  GroupStore on the unit of work
  redis/codes.ts        CodeIndex in Redis (Lua claim / release)
  redis/ended.ts        EndedGroups in Redis (Lua remember)
  redis/doors.ts        DoorGuard state in the group document
  redis/timers.ts       TimerBackend: due set, poller, lease claim (Lua)
  redis/epoch.ts        epoch service
  redis/scripts.ts      the Lua scripts (defineScript)
src/groups/effects.ts   effect outbox (per locked task)
src/groups/group-lock.ts GroupLock interface; LocalGroupLock (KeyedLock + unit of work); PR 2: RedisGroupLock
```

- `GroupStore` keeps its methods (contract unchanged). `CodeIndex`, `EndedGroups`,
  `DoorGuard` get interfaces whose methods return promises; callers already run in async
  code under the lock.
- `GroupTimers.armKind(key, kind, at, task)` becomes `arm(key, kind, at, data?)` with a
  handler table registered once by `GroupService`, `LifecycleService` and `JoinService`.
- `SyncServerOptions` gets `storage?: Storage` (default: memory). `store?` stays for
  the existing tests (wrapped into a memory `Storage`).
- `SyncServer` gets `storage(): StorageStatus` =
  `{kind: 'memory'} | {kind: 'redis', state: 'connected' | 'unreachable'}` (AC27). No
  HTTP endpoint and no `/health` change in 9a.
- Existing in-memory limiters, `ParkingLot`, `TokenRefresher`, `ConnectionCounter`
  stay process-local (AC22; Q12).

## 6. Timers (AC7, AC12; ADR 0013)

Kinds and what fires them, unchanged in meaning: `maxSession`, `frozenEnd`,
`keepAlivePrompt`, `keepAliveDeadline`, `grace` (data `{term, at}`), `doorPauseEnd`.
Not persisted (process-local): token refresh, parking expiry, per-connection limits.

Redis backend:

- Arm and clear are buffered in the unit of work and committed with the state they
  guard (`HSET P:t:...`, `ZADD P:due`).
- Poller per instance: local wake-up at the earliest known due time
  (`scheduler.at`), plus a 1 s safety poll (`TIMER_POLL_MS`). Claim:
  `ZRANGEBYSCORE P:due -inf now LIMIT 0 64`, then per member a Lua lease
  (`score <= now` -> `score = now + TIMER_LEASE_MS` (30 s)). The handler runs under the
  group lock with the data from the hash; the commit removes the member if the score is
  still the lease (a re-arm inside the handler replaced it otherwise).
- The handlers stay idempotent: they re-read the record and re-check the deadline
  (today's lazy-timer rule), so a second firing after a lost lease does nothing.
- Startup: the first poll runs before the startup sweep and before `listen`, so every
  deadline that passed while the server was down takes effect once (AC12), with the
  same handler as if it had been up (events go to nobody: no one is connected yet).

## 7. Restart survival (AC9-AC15)

Order at startup (Redis mode): connect and checks -> epoch -> past-due timers ->
startup sweep -> `listen`.

- **Startup sweep** (section 1.2 item 6): pages through `P:live` (`ZRANGE ... BYSCORE`
  from now, 100 at a time, pruning members past `E`); per group, under the group lock:
  - leader online in the record: the `leaderOffline` path with `now` as the time
    (grace `now + disconnectGraceSeconds`, members get nothing: none connected);
  - each member in `participantIds`: the member-disconnect path (removed from
    `participantIds`, roster entry disconnected; no overflow eviction beyond today's);
  - the group empties: the hold, with the deadline rule of Q-A3;
  - pending approvals: none in PR 1 (they are process-local until PR 2).
- **AC9** member resume: the record is in Redis -> `classifyToken` gives `live` ->
  `memberResume` (no parking, current position in `group.joined`).
- **AC10** leader resume: `live` -> `leaderReturn` (no recreation, no recovery marking,
  no new term, codes kept). `recoveredAt` stays undefined for a group created before the
  restart.
- **AC11** a leader online at shutdown hands off only after a full
  `disconnectGraceSeconds` from the sweep.
- **AC12** past-due timers at startup (section 6).
- **AC13** an ended group stays ended: the ended entry is in Redis; and a missing group
  with a token from this epoch is `ended` (section 4.5).
- **AC14** Redis empty: new epoch, recreation by token exactly as today (#5, #13 rules
  and tests reused against Redis).
- **AC15** server-side block list: `blockList` is in the document, so a removed or
  blocked member's resume gets `PARTICIPANT_BLOCKED` before the leader returns. The
  leader's list on resume still only adds IDs (`blockListUnion`).
- The parking lot is only used when a group is missing from Redis (AC14 path).

## 8. Failure while running (AC26, AC27; ADR 0014)

- Client events `ready` -> `connected`; `error`/`end`/`reconnecting` -> `unreachable`.
  Status changes are logged once each (`redis_unreachable`, `redis_connected`), no URL.
- A command or commit that fails (connection error, timeout from
  `REDIS_COMMAND_TIMEOUT_MS`, `LOADING`, `READONLY`, `MASTERDOWN`, `BUSY`) is raised as
  `StorageUnavailableError`.
- Inside a locked task: nothing was committed; the outbox is dropped; every local
  session of that group is closed with `1001`; the requester's connection is closed
  with `1001` (in `connection.ts`, `StorageUnavailableError` is caught before the
  `INTERNAL_ERROR` path).
- Outside a group (tokens.check, a create that fails): the connection is closed `1001`.
- While `unreachable`: upgrades get HTTP 503 (existing `refuse(socket, 503)`); timers
  are not polled; disconnects that could not be written go to a replay queue
  (`groupKey -> pids`, bounded by the local session count) replayed under the group
  lock on `ready`, then a poll runs at once.
- Never a fallback to memory; the process stays up.
- Code claims made just before a failure are released when possible, else they expire
  with their TTL.

## 9. Contracts

- **Wire protocol:** no change in PR 1 or PR 2 (ADR 0014 option 1). The docs widen the
  meaning of close `1001`. `PROTOCOL_VERSION` stays 1.
- **HTTP:** no change (`/health` body unchanged, AC27; `/ready` is #36). Upgrades may
  answer 503 while Redis is unreachable (same status as at the connection cap).
- **Server API (`createSyncServer`)**: additive `storage` option and `storage()` method;
  `store` option kept.
- **Logs (new events, no URL, host, key, code, name or ID):** `redis_connected`,
  `redis_unreachable`, `redis_error` (safeErr only), `redis_eviction_policy`,
  `redis_no_password`, `store_document_invalid`, `startup_sweep` (counts only),
  `timer_claimed` (debug, groupRef only).
- **Data model:** see section 4. Versioned (`v1` in every key and `v: 1` in the
  document). Migration checklist: no existing data (new store); a later format change
  uses a new key version (`v2`) and a reader for `v1` (expand, migrate, contract);
  rollback = unset `REDIS_URL` (groups fall back to token recovery, as after a restart
  today).

## 10. Security-sensitive areas

Security-sensitive: yes

- **New runtime dependency** `@redis/client` (ADR 0010): exact pin, audit, dynamic import.
- **Secrets and config**: `REDIS_URL` carries a password: never in `ServerEnv` logs,
  `Config error` or `Startup error` messages, or `safeErr` output (AC3, AC4, AC25).
  Tests assert the password, host and user never appear on stderr or in logs.
- **Personal data in Redis**: display names (possibly of minors), participant IDs,
  codes, positions in the group document; TTLs and delete-on-end (AC24); no persistence
  advice; never logged (AC25). Hashed refs only for ended groups.
- **Recovery and authorization**: the epoch fence (section 4.5) replaces the process
  fence of #13 6.9 (RC17, RC18): a mistake here could let a token recreate an ended
  group or refuse a live one. The block list now holds across restarts (AC15).
- **Concurrency**: the unit of work and, in PR 2, the fenced lock carry every "exactly
  one wins" guarantee (#5 AC27, #10 R11/R14, #13 RC1-RC21).
- **Data from Redis is input**: zod-validated on read (section 4.3).
- **Redis exposure**: compose binds no host port; the dev password is public and marked
  dev-only; README: password, `rediss://`, private network, no persistence,
  `noeviction`.
- **Denial of service**: the ended-groups cap moves to Redis with the same eviction and
  closure rules; Redis outages close sockets rather than queue work (bounded replay
  queue).

## 11. Implementer model

Implementer model: opus
Reason: security-sensitive, a new runtime dependency, five ADRs, and concurrency and
recovery invariants (#13 6.9, RC1-RC21) across about 30 files: far beyond a pattern
copy.

## 12. PR 2 outline (several instances; detailed in a revision before it starts)

Branch `feat/35-redis-multi-instance` from `main` after PR 1 merges; draft PR with
`Closes #35`.

- **Lock (AC18):** `RedisGroupLock` = local `KeyedLock` + Redis lease
  (`SET NX PX 10000`, renew every 3 s, compare-and-delete release, wait with jitter up
  to 5 s then `StorageUnavailableError`); the commit script checks the lease token
  (fencing, ADR 0011).
- **Instances:** random 128-bit instance ID per process; liveness key renewed every
  5 s (TTL 15 s); clean stop deletes it (AC21: others sweep at once).
- **Attachment registry:** `att` in the group document, written in the same commit as
  attach and detach; `P:inst:<id>:groups` lists groups with attachments per instance.
  `GroupService` reads the registry where it read local sessions: `owned()` (M4),
  `anyoneAttached` (RC19), the successor's `isOpen()` (handoff), `sessionOf` for
  delivery.
- **Orphan sweep (AC21):** every 5 s an instance scans for dead instance IDs (liveness
  key gone) and runs the startup-sweep rules for their attachments (grace from now:
  a leader on a stopped instance gets the normal grace, not an instant handoff).
- **Effects (AC17; ADR 0012):** the outbox groups effects by owning instance; local
  ones applied directly, remote ones published as one message per instance per commit
  on `P:ch:<id>`; the receiver applies them to its sessions (deliver, detach with
  `replaced`/`removed` + close 4004, group end). Subscriber reconnect: close local
  group sessions with `1001` (resync).
- **Approvals across instances (AC20):** pending requests in `P:ap:*` with `PXAT`
  at the deadline; the approving instance does the whole store-side admission under the
  lock and sends an `attach` effect with the `group.joined` frame to the joiner's
  instance; if that session is gone, the receiver runs the member-disconnect rules for
  the new pid. Timeout via a timer kind `approvalTimeout`. Leader `join.decided`
  unchanged.
- **Parked members across instances:** `P:pk:*` registry; a recreation publishes
  `admitParked` to the instances holding parked sessions.
- **Codes (AC16):** already global from PR 1; concurrency test with two instances and a
  forced-collision `codeRandom`.
- **Timers (AC19):** already lease-claimed from PR 1; test that a timer armed on a
  killed instance fires on the other.
- **Compose (AC23):** `compose.multi.yaml` (dev only): two `sync-server` services,
  Redis, and an `nginx` load balancer (pinned digest, WebSocket upgrade, no sticky
  sessions) on `127.0.0.1:8080`.
- **Tests (AC16-AC22, AC29):** two or three in-process servers on one Redis prefix;
  concurrency tests (last slot, two leader resumes, take-back vs handoff,
  create-if-absent), delivery under 1 s (AC17 bound on a local run), kill an instance
  (terminate its sockets and stop renewing liveness), per-instance caps.
- **Docs:** README "Several instances" replaces "one instance only".

## 13. Files (PR 1)

### 13.1 Create

| Path | What |
| ---- | ---- |
| `apps/sync-server/src/storage/storage.ts` | `Storage` bundle and `StorageStatus` types; `memoryStorage()` |
| `apps/sync-server/src/storage/memory/*.ts` | memory implementations behind the new interfaces (existing classes moved or wrapped) |
| `apps/sync-server/src/storage/redis/connect.ts` | dynamic import, connect, startup error classification, INFO checks, status events |
| `apps/sync-server/src/storage/redis/keys.ts` | key builders (section 4.1) |
| `apps/sync-server/src/storage/redis/document.ts` | zod schema of the group document |
| `apps/sync-server/src/storage/redis/unit-of-work.ts` | task cache, buffered writes, commit |
| `apps/sync-server/src/storage/redis/group-store.ts` | `GroupStore` on the unit of work |
| `apps/sync-server/src/storage/redis/codes.ts` | Redis code index |
| `apps/sync-server/src/storage/redis/ended.ts` | Redis ended groups |
| `apps/sync-server/src/storage/redis/doors.ts` | door state in the document |
| `apps/sync-server/src/storage/redis/timers.ts` | due set, poller, lease claim |
| `apps/sync-server/src/storage/redis/epoch.ts` | epoch service |
| `apps/sync-server/src/storage/redis/scripts.ts` | Lua scripts |
| `apps/sync-server/src/storage/errors.ts` | `StorageUnavailableError` |
| `apps/sync-server/src/config/redis.ts` | `REDIS_*` parsing (`RedisSettings`, kept out of `ServerEnv`) |
| `apps/sync-server/src/groups/effects.ts` | effect outbox |
| `apps/sync-server/src/groups/group-lock.ts` | `GroupLock` interface, local implementation |
| `apps/sync-server/src/groups/startup-sweep.ts` | restart sweep (section 7) |
| `apps/sync-server/test/contracts/*.ts` | shared contract suites: group store, code index, ended groups, door guard, timer backend |
| `apps/sync-server/test/helpers/redis.ts` | `SYNC_TEST_REDIS_URL`, random prefix per test, cleanup by `SCAN` + `UNLINK`, key and TTL inspection |
| `apps/sync-server/test/helpers/tcp-proxy.ts` | in-process TCP proxy to cut and restore Redis (AC26) |
| `apps/sync-server/test/*.redis.test.ts` | Redis suites (section 15) |
| `apps/sync-server/test/redis-required.test.ts` | fails when `CI=true` and `SYNC_TEST_REDIS_URL` is unset (AC31: never silently skipped) |
| `compose.redis.yaml` | override: `redis` service + `REDIS_URL` on `sync-server` (AC30) |

### 13.2 Modify

| Path | Change |
| ---- | ------ |
| `apps/sync-server/package.json` | `"@redis/client": "6.3.1"` (exact) |
| `pnpm-lock.yaml` | lockfile |
| `apps/sync-server/src/config/env.ts` | collect `REDIS_*` problems with the rest |
| `apps/sync-server/src/main.ts` | build the storage, `Startup error` for Redis, pass `RedisSettings` |
| `apps/sync-server/src/server.ts` | `storage` option, `storage()` status, startup recovery before listen, Redis-mode `close()`, 503 while unreachable |
| `apps/sync-server/src/ws/upgrade.ts` | refuse with 503 while storage is unreachable |
| `apps/sync-server/src/ws/connection.ts` | `StorageUnavailableError` -> close `1001` |
| `apps/sync-server/src/groups/group-service.ts` | lock via `GroupLock`, effects via outbox, async state interfaces, timer dispatch, epoch |
| `apps/sync-server/src/groups/group-timers.ts` | kind dispatch over a backend |
| `apps/sync-server/src/groups/ended-groups.ts` | interface + memory implementation |
| `apps/sync-server/src/groups/resume.ts` | `processStartedAt` renamed to the epoch (same rule) |
| `apps/sync-server/src/groups/notifier.ts` | outbox-aware delivery (local only in PR 1) |
| `apps/sync-server/src/groups/in-memory-group-store.ts` | unchanged logic; reused by the unit of work's cache operations (extract the pure record operations) |
| `apps/sync-server/src/joins/code-index.ts`, `door-guard.ts`, `join-service.ts` | interfaces, async calls, `doorPauseEnd` timer kind |
| `apps/sync-server/src/lifecycle/lifecycle-service.ts`, `leader-controls.ts` | timer kinds, effects via outbox |
| `apps/sync-server/src/tokens/token-service.ts` | iat floor follows the epoch |
| `apps/sync-server/src/limits/constants.ts` | `TIMER_POLL_MS`, `TIMER_LEASE_MS`, `END_TTL_SLACK_MS`, `REDIS_ERROR_LOG_INTERVAL_MS` |
| `apps/sync-server/test/no-disk.test.ts` | still no `fs` outside the apps loader; title updated (Redis is opt-in) |
| `apps/sync-server/test/main.test.ts`, `env.test.ts` | Redis config and startup error cases |
| `apps/sync-server/test/in-memory-group-store.test.ts` and the unit suites of the moved classes | run the shared contract suites |
| `apps/sync-server/test/repo-hygiene.test.ts` | compose override: digest-pinned Redis image, no host port, password set; CI service pinned |
| `.github/workflows/ci.yml` | `check` job: `services.redis` pinned by digest with a password, `SYNC_TEST_REDIS_URL` env |
| `README.md` | section 14 |
| `docs/conventions.md` | ADR rows (accept chunk) |

## 14. Docs impact

- `README.md` (Sync server):
  - env table: the four `REDIS_*` rows;
  - new "Storage (Redis)" section: turning it on, URL forms, TLS, prefix sharing,
    supported servers (Redis 7.2+, Valkey), `noeviction`, no persistence advice, what
    survives a restart (AC7, AC9-AC15), data lifetime (AC24), behaviour while Redis is
    down (ADR 0014), **"one instance only until the several-instances release"** (PR 1),
    per-instance connection and rate limits (AC22), clock sync;
  - "Run with Docker Compose": the `compose.redis.yaml` override;
  - "Recovery and tokens": recovery by token is now only needed without Redis or after
    Redis lost its data (AC14); the #13 accepted risk is closed with Redis (AC13);
  - "Protocol (v1) in brief": `1001` also means "temporarily unavailable".
  - "Startup errors": the Redis `Startup error` messages.
- `docs/conventions.md`: rows for ADRs 0010, 0011, 0013, 0014 (and 0012, accepted now,
  applied in PR 2); commit scope `storage` added.
- Full public docs are #37 (9c).

## 15. Test plan (PR 1)

Runner: Vitest per package. Redis suites are `apps/sync-server/test/*.redis.test.ts`
and run when `SYNC_TEST_REDIS_URL` is set, each with a random prefix and full cleanup.
`redis-required.test.ts` fails the run when `CI=true` and the variable is unset, so
they are never silently skipped (AC31).

| AC | Test |
| -- | ---- |
| AC1 | All existing suites unchanged and green (protocol, server, client, react, reader); a test that `@redis/client` is not loaded by a memory server (module cache check). |
| AC2 | `redis-connect.redis.test.ts`: `redis://` with user and password, `redis://:pass@`, `rediss://` (URL parse and TLS option only; TLS handshake is covered by the failure case). |
| AC3 | `env.test.ts`: each invalid value of each `REDIS_*` variable, combined with another config error, one message, exit 1; message names the variable; stderr never contains the URL, host, user or password. |
| AC4 | `main.test.ts`: unreachable port (fast refusal), a black-hole address with a 1 s timeout, wrong password against the test Redis, TLS against a plain port; exit 1 with the right `Startup error`; no URL, host or password on stderr. Redis below 7.2 by a stubbed INFO reply. |
| AC5 | Two servers with prefixes `a` and `b` on one Redis: a group of `a` is unknown to `b` (code join and resume); key scan shows only own-prefix keys. |
| AC7 | Contract suites on Redis; a restart test per bullet (record fields, code index, ended record, door failure count and pause, timer deadlines). |
| AC8 | Scan every key and value after a full flow: no token, secret, ticket key or API key substring. |
| AC9, AC10 | Restart: close server 1 (Redis mode leaves attachments), start server 2 on the same prefix and token secret; member resume rejoins at once with the position; leader resume keeps lead, `recreated: false`, same codes, same term. |
| AC11 | Manual clock: restart with the leader online at shutdown; no handoff before `disconnectGraceSeconds` after start; handoff after it if a member is back. |
| AC12 | Manual clock: advance past max session, keep-alive deadline (escalated and not), grace, hold, frozen end, door pause while server is down; at start each takes effect once, same outcome as the in-memory tests; a second start fires nothing. |
| AC13 | End a group, restart, resume and tokens.check get `ended`; no recreation. |
| AC14 | Flush Redis (the test's prefix) with the server running and with a restart: the #5 and #13 recreation tests rerun against Redis. |
| AC15 | Block a member, restart, member resume refused with `PARTICIPANT_BLOCKED` before the leader returns; leader resume list only adds. |
| AC22 | Existing caps and limit suites green in Redis mode (limits are per instance). |
| AC24 | After create, join, timers, door failures: every key of the group has a TTL `<= E` (and the ended entry `<=` the max-session deadline); after end, no key of the group remains (scan by group ID and by hashed ref). |
| AC25 | Log capture through a Redis outage and recovery: no URL, host, password, key name with a group ID or code, display name, participant ID, code or position. |
| AC26 | TCP proxy cut: requests close `1001`, the group document is byte-identical before and after a failed multi-write operation (forced failure on the commit), upgrades get 503, `storage()` says `unreachable`; restore: service resumes, queued disconnects replayed, timers run. Also: never a fallback to memory (a create during the outage leaves nothing in memory). |
| AC27 | `storage()` for memory, Redis connected, Redis unreachable. |
| AC28 | `pnpm audit` in CI; the exact pin checked by `repo-hygiene.test.ts`. |
| AC29 | Shared contract suites run on memory and Redis (group store, code index, ended groups with the eviction and closure order, door guard, timer backend). Restart tests on a real Redis. |
| AC30 | `repo-hygiene.test.ts`: override file pins the Redis image by digest, sets a password, publishes no host port (or loopback only); default `compose.yaml` unchanged; `docker compose ... config` in QA. |
| AC31 | CI `check` job with the Redis service; QA runs it locally (below). |
| AC32 | `repo-hygiene.test.ts` extends the README checks: every `REDIS_*` variable in the env table, the "one instance only" line (PR 1). |

Effect-outbox ordering (AC1 guard): a new unit test asserts that effects are flushed
in queue order after the task and dropped on a failed commit.

**Local CI run (QA, as for #31; Actions is blocked by billing):**

```
docker network create ci-35
docker run -d --name ci-35-redis --network ci-35 \
  redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335 \
  redis-server --requirepass ci-only-redis-password --save "" --appendonly no
docker run --rm --network ci-35 -e CI=true \
  -e SYNC_TEST_REDIS_URL=redis://:ci-only-redis-password@ci-35-redis:6379 \
  -v "$PWD":/src:ro node:24 bash -c 'git clone /src /w && cd /w && corepack enable && \
  pnpm install --frozen-lockfile && pnpm audit --audit-level=high && pnpm lint && \
  pnpm typecheck && pnpm test && pnpm build'
# e2e job as for #31 (unchanged, memory store)
docker rm -f ci-35-redis && docker network rm ci-35
```

`ci.yml` gets the same: a `services.redis` entry with the pinned image, the command
flags above and `SYNC_TEST_REDIS_URL`/`CI` in the test step's env (a CI-only password,
not a secret).

## 16. Risks and edge cases

- **Behaviour drift on the in-memory path** from the outbox and async interfaces:
  guarded by the full existing suites (about 1,150 server tests) running unchanged.
- **Order of effects** inside a task (broadcast now vs queued): queue order preserved;
  the reply still follows the flush.
- **Restart re-basing of a running grace** (Q-A3) is a product rule; without it a
  group whose leader dropped shortly before a restart would end `empty` at startup.
- **Handoff deadlines that passed while down** find no connected successor: the group
  stays paused (frozen bound), as documented; members who return get the paused group.
- **TTL slack** of 5 s (Q-A2).
- **Clock jumps** between restarts: deadlines are absolute epoch ms, as today.
- **Large groups**: a 64 KiB document per write on a busy group (position updates write
  the whole document). At 10 updates/s per group that is about 640 KiB/s per group to
  Redis. Acceptable for v1; a later optimisation can store the position in its own key
  (noted, not done).
- **Eviction policy** other than `noeviction`: warning only (Q-A6).
- **A second instance on PR 1**: without the PR 2 lock two instances can interleave
  commits on one group and miss each other's events; the README forbids it until PR 2.
- **Redis flush while running**: detected on the next miss (epoch), no restart needed.
- **Redis restart with persistence**: groups survive (document, timers); the instances
  see an outage and recover as in section 8.

## 17. Implementation chunks (PR 1, all in this repo, on `feat/35-redis-docs-release`)

1. `docs(adr): accept 0010-0014 for redis storage` (Status Accepted with the Gate 2
   choices, `docs/conventions.md` rows, scope `storage`)
2. `build(server): add @redis/client 6.3.1`
3. `feat(server): validate redis settings with the other config errors` (AC3, AC5 prefix)
4. `refactor(server): queue group effects in a per-lock outbox` (no behaviour change)
5. `refactor(server): dispatch group timers by kind through a backend` (no behaviour change)
6. `refactor(server): put codes, ended groups and door state behind async interfaces` (no behaviour change)
7. `feat(storage): connect to redis with startup checks and a status` (AC4, AC27, AC28)
8. `feat(storage): add the redis group store with a unit of work` (AC7, AC24, AC29 contract suite)
9. `feat(storage): keep codes, ended groups and door state in redis` (AC7, AC13)
10. `feat(storage): keep group timers in redis with lease claiming` (AC7, AC12)
11. `feat(server): survive a restart with redis` (epoch, startup sweep, Redis-mode close; AC9-AC15)
12. `feat(server): close sessions and refuse upgrades while redis is down` (AC26)
13. `test(server): cover restart, lifetimes, prefixes and log privacy on redis` (AC5, AC8, AC24, AC25)
14. `build(compose): add an optional redis override` (AC30)
15. `ci: run the redis-backed tests against a pinned redis service` (AC31)
16. `docs(server): document redis storage and the one-instance limit` (AC6 interim, AC32)

Each chunk keeps `pnpm lint`, `pnpm typecheck` and `pnpm test` green.

## 18. Gate 2 questions (recommendation first)

- **Q-A1. Two PRs** (section 1.1). Recommended: yes, PR 1 single-instance restart
  survival, PR 2 several instances, PR 2 re-planned in a revision of this file.
- **Q-A2. TTL slack** of 5 s past the max-session deadline (section 4.2), so the
  max-session end can notify and record. Recommended: yes. Alternative: TTL exactly at
  the deadline; then a group can vanish a moment before its timer, and its members get
  no `group.ended max_session` (they learn it on their next resume).
- **Q-A3. Restart grace for running pauses** (section 1.2 item 6): a grace or hold that
  was running at shutdown ends no earlier than `disconnectGraceSeconds` after the server
  is back. Recommended: yes (a restart is never counted against anyone). Alternative:
  keep the stored deadline (a group may end `empty` at startup).
- **Q-A4. PR 1 body.** The draft PR says `Closes #35` as instructed; with two PRs it
  should say `Refs #35` so merging PR 1 doesn't close the issue, and PR 2 carries
  `Closes #35`. Recommended: change PR 1 to `Refs #35` in the first engineer chunk.
- **Q-A5. Pending approvals in Redis move to PR 2** (section 1.1). Recommended: yes.
- **Q-A6. Eviction policy other than `noeviction`**: warning (recommended) or startup
  error.
- **ADRs 0010-0014**: one decision each (recommended options: 0010 `@redis/client`
  6.3.1; 0011 unit of work + fenced lease lock; 0012 one channel per instance;
  0013 due set with lease claiming; 0014 close `1001` + 503, no new error code).

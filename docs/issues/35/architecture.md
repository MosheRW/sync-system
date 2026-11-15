# Architecture: #35 Redis storage with restart survival and several instances (PRD item 9a)

Spec: [`spec.md`](spec.md) (AC1-AC32; AC33+ belong to #36 and #37).
Gate 1 decisions: [`STATE.md`](STATE.md). Path: full. No UI change, no designer phase.

> **Status (2026-11-12, PR 2 plan revision).** PR 1 (#38) merged as `46f4af3`.
> Sections 1-11 and 13-18 describe **PR 1 (merged)** and stay as history; its
> deviations from this plan are listed in [`STATE.md`](STATE.md) ("Deviations from
> plan"). **Section 12 is the detailed PR 2 plan** (several instances), with its own
> Gate 2 questions in 12.22.

## 0. Summary

- **Delivered as two PRs on this issue** (section 1.1):
  - **PR 1** (#38, branch `feat/35-redis-docs-release`, **merged** 2026-11-12 as
    `46f4af3`, `Refs #35`): Redis store, restart survival, server-side block lists
    after a restart, Redis config and startup errors, failure behaviour, store
    connectivity state, compose override, CI with Redis. One instance only,
    documented in the README until PR 2 (AC6 interim, as the spec allows).
  - **PR 2** (branch `feat/35-redis-multi-instance`, draft PR with `Closes #35`):
    several instances on one Redis: fenced per-group lease lock, instance liveness
    with self-fencing, attachment registry and orphan sweep, cross-instance effects
    over pub/sub published inside the commit, method B approvals and parked members
    across instances, the two-instance compose example. **Planned in section 12.**
- **Design in one line (PR 1):** one JSON document per group in Redis, written in one
  atomic commit (a Lua `COMMIT` script, PR 1 deviation) at the end of each locked
  group task (unit of work, ADR 0011), with session effects flushed only after the
  commit; timers as a due-time sorted set with lease claiming (ADR 0013); a store
  "epoch" replaces the process-start fence for recovery; an attachment sweep at
  startup applies a fresh grace after a restart (Q9).
- **Design in one line (PR 2):** every group task also holds a Redis lease checked by
  the commit (fence); participants are reached through an attachment registry, and
  remote effects are published per instance inside the same commit; instances that
  stop renewing their liveness close their own sessions before peers sweep them.
- **ADRs (Accepted at Gate 2, 2026-11-12):**
  [0010](../../decisions/0010-redis-client-and-supported-servers.md) Redis client and
  servers, [0011](../../decisions/0011-group-atomicity-with-redis.md) atomicity (lease
  lock applied in PR 2), [0012](../../decisions/0012-cross-instance-event-delivery.md)
  cross-instance delivery (applied in PR 2),
  [0013](../../decisions/0013-persistent-group-timers.md) timers,
  [0014](../../decisions/0014-behaviour-while-redis-is-unreachable.md) behaviour while
  Redis is down (option 1). PR 2 opens no new ADR (12.0, 12.22 Q-B2).
- **Protocol change: none** in PR 1 or PR 2. The meaning of close code `1001` widens
  in the docs to "going away or temporarily unavailable".
- Security-sensitive: yes (PR 1: section 10; PR 2: 12.19). Implementer model: opus
  (PR 1: section 11; PR 2: 12.20).

## 1. Approach (PR 1, merged)

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

## 2. Repo layout (PR 1, merged; PR 2: 12.2)

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

## 3. Configuration (AC2-AC5, AC28) (PR 1, merged)

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

## 4. Redis data model (PR 1, merged; PR 2 additions: 12.3)

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
| PR 2 (superseded by 12.3): `P:lock:<ns>:<gid>` | string | lease token | 10 s, renewed |
| PR 2: `P:inst:<id>` | string | liveness of an instance | 15 s, renewed every 5 s |
| PR 2: `P:inst:<id>:groups` | set | `<ns>:<gid>` with attachments on that instance | `PEXPIRE ... GT` |
| PR 2: `P:ap:<ns>:<gid>:<requestId>` | string | pending approval `{displayName?, deadline, owner}` | the request deadline (AC20) |
| PR 2: `P:ap:<ns>:<gid>` | sorted set | request IDs by deadline | latest request deadline |
| PR 2: `P:pk:<ns>:<gid>` | hash | parked `pid -> instanceId` | the parking bound |
| PR 2: channel `P:ch:<instanceId>` | pub/sub | effects for that instance (ADR 0012) | n/a |

PR 2 (12.3, 12.6) keeps the attachment registry in its own key `P:a:<ns>:<gid>`, not in
the group document (rollback-safe; Gate 2 Q-B2).

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

## 5. Store interfaces (code shape) (PR 1, merged)

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

## 6. Timers (AC7, AC12; ADR 0013) (PR 1, merged)

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

## 7. Restart survival (AC9-AC15) (PR 1, merged)

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

## 8. Failure while running (AC26, AC27; ADR 0014) (PR 1, merged)

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

## 9. Contracts (PR 1, merged; PR 2: 12.13)

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

## 10. Security-sensitive areas (PR 1, merged; PR 2: 12.19)

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

## 11. Implementer model (PR 1, merged; PR 2: 12.20)

Implementer model: opus
Reason: security-sensitive, a new runtime dependency, five ADRs, and concurrency and
recovery invariants (#13 6.9, RC1-RC21) across about 30 files: far beyond a pattern
copy.

## 12. PR 2: several instances (detailed plan, own Gate 2)

Revised 2026-11-12 after PR 1 (#38) merged as `46f4af3`. This section replaces the
outline that was here. It builds on the code as merged, including the PR 1
deviations recorded in [`STATE.md`](STATE.md): the commit is one Lua `COMMIT` op
interpreter (`storage/redis/scripts.ts`), the position lives in its own key
`P:p:<ns>:<gid>`, expiries travel as TTLs relative to Redis `TIME`, and the
disconnect replay queue is a bounded, deduplicated set of groups.

### 12.0 Scope

- **Branch** `feat/35-redis-multi-instance` (from `main` at `0be498e`), one draft PR to
  `main` with `Closes #35`.
- **ACs closed by PR 2:** AC6, AC7 (pending method B approvals, Q-A5), AC16, AC17,
  AC18, AC19, AC20, AC21, AC23 (the 8 deferred in PR 1), plus the several-instance
  parts of AC22 (tests across instances), AC29 (two or more in-process servers on one
  Redis), AC31 (CI) and AC32 (README "Several instances").
- **Follow-up #39** (security round 2, L4): proposed as its own chunk (12.21 chunk 1),
  pending the user's answer to Q-B1. The PR body says `Refs #39` until then.
- **Decisions:** none open. PR 2 applies accepted ADRs
  [0011](../../decisions/0011-group-atomicity-with-redis.md) (the fenced lease lock)
  and [0012](../../decisions/0012-cross-instance-event-delivery.md) (a channel per
  instance plus an attachment registry). The refinements in 12.1 stay inside those
  decisions. Gate 2 still confirms them (Q-B2). No new ADR is needed.
- **Protocol change: none.** No new env variable, no HTTP change.
- **Security controls C1-C10 stay mandatory**. P2-3, P2-4, P2-6, P2-7 and P2-8 are
  settled in 12.19.

### 12.1 Approach

One locked group task, on any instance (memory mode is unchanged):

1. **Local queue.** `KeyedLock` per group, so an instance runs one task per group at a
   time and only that task polls Redis (ADR 0011).
2. **Lease.** `SET P:lock:<ns>:<gid> <token> NX PX 10000`, renewed every 3 s while the
   task runs (12.4).
3. **Preload.** One `MGET` of the document, the position and the attachment registry
   (12.6). From here on the registry is the truth for "who is attached where".
4. **Task.** It runs as today against the unit of work's cache. Participants are
   reached through **recipients** (12.6): a local recipient queues closures in the
   local outbox, as PR 1 does. A remote recipient queues a structured **remote effect**
   for its instance.
5. **Commit.** The `COMMIT` script checks the lease first (`eq P:lock... token`), then
   the PR 1 checks (C7), then writes state, registry, timers and approvals. Last, it
   `PUBLISH`es **one message per remote instance** with that commit's remote effects
   (12.7). State, registry and notifications land in one atomic step.
6. **Local flush.** The local outbox runs (PR 1).
7. **Release.** Compare-and-delete of the lease.

Receivers apply remote effects to their own sessions through the group's **local
queue only** (no lease, no unit of work). So a received effect never interleaves with
a local task of the same group (12.7).

Instances register a liveness key and **fence themselves** before anyone else may
treat them as dead (12.5). A periodic **orphan sweep** runs the PR 1 restart-sweep
rules for the attachments of dead instances (12.8).

Refinements of the accepted ADRs (Q-B2), each a detail inside the decision:

| ADR text | PR 2 plan | Why |
| -------- | --------- | --- |
| 0012: "an attachment registry in the group document" | Its own key `P:a:<ns>:<gid>`, read in the same `MGET` and written in the same `COMMIT` | Same atomicity. A PR 1 build never reads it (rollback-safe, 12.18), and a position update doesn't rewrite it. |
| 0012: "after a commit, the outbox ... published" | `PUBLISH` runs inside the `COMMIT` script | No gap between "stored" and "sent" if the process dies in between. The commit order (serialized by the lease) is also the publish order for every receiver. |
| 0011: "wait ... up to a bound (5 s), then the request fails as storage unavailable" | It fails as **busy**: only the requester's connection closes with `1001`, the group's other sessions stay | Nothing was stored and nothing is stale, so a resync of the whole group isn't needed. This also keeps the C8 / P2-7 property: one client can't make a whole group drop. |

Alternatives rejected:

- **Publish after the commit, from the outbox.** It leaves a crash window where
  events are lost. Two instances publishing on separate connections can also reorder
  events for one receiver.
- **Receivers apply effects directly, outside the local queue.** This races with a
  local task of the same group. For example, PR 1's L1 rollback could reattach a
  session that a remote `detach` had just removed.
- **One hash per group for pending approvals.** Redis 7.2 has no per-field expiry
  (`HEXPIRE` is 7.4, the ADR 0010 floor is 7.2), so AC20's "expires in Redis after the
  approval timeout" needs one key per request.
- **A registry of live groups scanned every 5 s by every instance** (instead of
  per-instance group sets). Its cost is O(groups) per tick per instance.

### 12.2 Repo layout

- Layout: **monorepo** (pnpm workspace, `apps/*`, `packages/*`; no submodules:
  `git submodule status` is empty; `pnpm-workspace.yaml`; no turbo or nx). One
  issue, one branch, one PR.
- Touched: `apps/sync-server` (code and tests), `compose.multi.yaml` (new),
  `config/nginx-multi.conf` (new), `.github/workflows/ci.yml`, `README.md`,
  `docs/conventions.md`.
- Not touched: `packages/protocol`, `packages/client`, `packages/react`,
  `apps/reader` (their suites must pass unchanged).
- Checks: root `pnpm audit --audit-level=high`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test` (with `CI=true` and `SYNC_TEST_REDIS_URL`), `pnpm build`; the sync-server
  suite once more with `SYNC_TEST_STORE=redis`; `docker compose config` for
  `compose.yaml`, `+ compose.redis.yaml`, `+ compose.redis.yaml + compose.multi.yaml`.
- No other repo, no linked issue.

### 12.3 Redis data model additions

`P` = `<REDIS_KEY_PREFIX>:v1`. Every key is built in `keys.ts`, and each part is
checked against its format (C6). New part checks:

- instance ID: `^[0-9a-f]{32}$`
- request ID: the protocol's `JOIN_REQUEST_ID_PATTERN`
- participant ID: `PARTICIPANT_ID_PATTERN`

This replaces the PR 2 rows of the section 4.1 table.

| Key | Type | Content | Lifetime |
| --- | ---- | ------- | -------- |
| `P:lock:<ns>:<gid>` | string | lease token (16 random bytes, hex) | `PX 10000`, renewed every 3 s; deleted on release |
| `P:a:<ns>:<gid>` | string | attachment registry JSON `{v:1, a:{<pid>:{i:<instanceId>, t:<attachId>}}}` | TTL `E`, like the document; deleted with the group; written only when it changes |
| `P:inst:<id>` | string | liveness of an instance (`1`) | `PX 15000`, renewed every 5 s (`XX`); deleted on a clean stop |
| `P:insts` | sorted set | instance IDs, score = liveness deadline (Redis time) | shared; expiry moved to now + 24 h on each registration (`extend`) |
| `P:ig:<id>` | set | `<ns>:<gid>` of groups with an attachment on instance `<id>` | `extend` to the latest `E` of its groups; deleted when its instance has been swept |
| `P:ap:<ns>:<gid>:<rid>` | string | pending method B request `{i, n?, d}` (owner instance, chosen display name, deadline) | `PX` to the request deadline (never past `E`); deleted when settled and with the group (AC20) |
| `P:aq:<ns>:<gid>` | sorted set | members `<rid>.<instanceId>` (request ID and the joiner's instance, so a timeout after the request key expired still reaches that instance), score = deadline (oldest first) | `extend` to the latest pending deadline (never past `E`); deleted with the group |
| `P:pk:<ns>:<gid>` | set | instance IDs holding a parked member of a missing group (no personal data) | `extend` to the latest parking bound; deleted by the recreation commit |
| `P:seq` | string | the last commit sequence (Gate 2 Q-B10, 12.7): an integer, `max(last + 1, Redis time in microseconds)`, so it never goes back even after the key expired | shared; `PX` 24 h, set again by every commit that publishes |
| `P:q:<ns>:<gid>` | hash | per receiving instance ID: the sequence of the group's last commit that published to it (its high-water mark, Q-B10) | `keep` to `E`, like the document; deleted with the group |
| channel `P:ch:<id>` | pub/sub | remote effects for instance `<id>` (12.7) | n/a |

- `attachId`: 16 random bytes, base64url (22 characters), new on every attach. It lives
  in `Session.membership.attachId` and in the registry. It is never sent to clients or
  logged.
- **Ends (AC24).** The commit that ends a group deletes `P:a`, `P:q`, `P:aq` and every
  `P:ap:<rid>` of the group. Each instance's set `P:ig:*` drops the group in the same
  commit (`srem`). `endInvalid` does the same (12.21 chunk 1).
- **Invariant**, kept by every commit: a pid has a registry entry if and only if it is
  connected in the record (in `participantIds`, or the online leader).
- **Never in Redis** (AC8, unchanged): tokens, the token secret, QR ticket keys, API
  keys. New in Redis, all inside the trust zone (P2-5): the chosen display name of a
  pending joiner (until settled or deadline), and serialized server frames in transit
  on the channels. Channel messages are not stored by Redis.
- **`COMMIT` script** (`scripts.ts`) gets four write ops and a sequence:
  - `sadd` and `srem`, for `P:ig:*`;
  - `pub`, which publishes `{"v":1,"s":<seq>,"effects":<payload>}` on a channel name
    passed in the spec. The name is built in `keys.ts`. Every `pub` comes after every
    other write (the script refuses a write after a publish);
  - `hw`, which sets one field of `P:q:<ns>:<gid>` to the commit's sequence;
  - with a sequence key in the spec (only when the commit publishes), the script first
    takes the next sequence from `P:seq` (Q-B10) and returns it.

  The script still returns `{'abort', reason}` on the first failed check, before any
  write or publish.
- **`PRELOAD` script** (Q-B10): one read for a task's own group: `MGET` of the
  document, position and registry, plus `HGET P:q:<ns>:<gid> <own instance ID>`.
- **New constant scripts**, each in `scripts.ts`, with `KEYS`/`ARGV` only (C6):
  - `LEASE_RENEW`: `PEXPIRE` if the value matches.
  - `LEASE_RELEASE`: compare-and-delete.
  - `INSTANCE_REGISTER`: `SET NX PX`, `ZADD`, `extend`.
  - `INSTANCE_HEARTBEAT`: `SET XX PX` (nil means fenced), `ZADD XX`.
  - `DEAD_INSTANCES`: `ZRANGEBYSCORE ... -inf now LIMIT`, keeping only IDs whose
    liveness key is gone.
  - `FORGET_INSTANCE`: `DEL P:ig:<id>` and `ZREM P:insts`, only while the liveness
    key is still absent.

  All use Redis `TIME`, so instance clocks never decide liveness.

### 12.4 Group lease lock (AC18, P2-7)

`GroupLock` gets an optional `LeaseSource`. Memory mode has none and is unchanged.
The Redis storage passes `RedisLeaseSource` (`storage/redis/lease-lock.ts`).

- **Acquire.** Inside the local `KeyedLock`: `SET ... NX PX GROUP_LEASE_MS` (10 000).
  On a miss, retry with full-jitter backoff `rand(0, min(100, 5 * 2^n))` ms. After
  `GROUP_LOCK_WAIT_MS` (5 000) since the first try, throw `StorageBusyError`. The task
  never started, so nothing is written or queued.
- **Renew.** Every `GROUP_LEASE_RENEW_MS` (3 000), `LEASE_RENEW`. A `0` reply or a
  failed renewal marks the lease lost. Renewals stop after `GROUP_LEASE_MAX_HOLD_MS`
  (30 000): a task that long is a bug, and the fence then refuses its commit.
- **Fence.** The unit of work adds `eq(lockKey, token, 'lease')` as the **first** check
  of every commit. On abort `lease`, `LeaseLostError` is raised (a subclass of
  `StorageUnavailableError`): nothing was written or published. The group's local
  sessions are closed with `1001`, because this instance's view of the group may be
  stale (ADR 0014 path).
- **Release.** `LEASE_RELEASE` after the commit and the local flush. A failure is
  ignored, and the lease expires.
- **Who takes it.** Everything that runs through `GroupLock.run`:
  - client requests, disconnects and timers;
  - sweeps and the replay queue;
  - the receiver-side `admitParked` and `disconnectStale` (12.7);
  - `RedisWorkSource.within` when it runs outside a task (`endInvalid`, tests).

  The receiver-side local ops (`deliver`, `detach`, `admit`, `settle`, `refresh`,
  `forget`) use `GroupLock.runLocal`: the local queue only.
- **Busy.** `StorageBusyError` closes only the requester's connection with `1001`
  (`ws/connection.ts`, next to the `StorageUnavailableError` branch). A disconnect
  that hits busy goes to the replay queue. A timer that hits busy runs again after its
  timer lease (ADR 0013).
- **P2-7: no client waits inside a lease.** Every `await` inside a group task is a
  Redis command, bounded by `REDIS_COMMAND_TIMEOUT_MS`, or local computation. Frames
  to clients go through outboxes after the commit. The engineer lists the awaits of
  every task entry point in the PR (review aid). A test holds a commit past a short
  test lease and checks that the other instance takes over and the late commit aborts.

### 12.5 Instances: identity, liveness, self-fencing (AC21, P2-3)

New `storage/redis/instance.ts`.

- **ID.** 16 random bytes, hex. A new one at every process start and after every
  self-fence; an ID is never reused. Logs carry only
  `instanceRef = sha256(id).slice(0, 8)` (P2-4).
- **Register** (`INSTANCE_REGISTER`) before the subscriber subscribes and before the
  startup sweep.
- **Heartbeat** every `INSTANCE_HEARTBEAT_MS` (5 000) with `INSTANCE_HEARTBEAT`
  (`PX INSTANCE_LIVENESS_MS`, 15 000). Each tick also refreshes the **live-instance
  cache** (`ZRANGEBYSCORE P:insts now +inf`) and drains the replay queue when
  connected (as built, a replay also admits parked members).
- **Self-fence (P2-3).** Triggers:
  - (a) a heartbeat answers "fenced": the key was gone, so others may already have
    swept us;
  - (b) no heartbeat has succeeded for `INSTANCE_SELF_FENCE_MS` (10 000), measured on
    the monotonic clock from the **send** time of the last successful heartbeat.

  Then, in this order:
  1. state `unreachable` (upgrades get 503);
  2. every local session that is in a group, parked or pending gets `1001`;
  3. the local registry, parking, pending joiners and refreshers are cleared;
  4. the old channel is unsubscribed.

  As built, the sessions close quietly (no disconnect rules, C13: the peers' sweep
  applies them) and the disconnect replay queue is cleared too. Storage stays
  `unreachable` while fenced.

  When Redis answers again, the instance re-registers under a **new** ID, subscribes to
  the new channel and turns `connected`.
- **Why the margin holds.** A successful renewal sets `PX 15000` when Redis receives
  it, which is no earlier than our send time. So the key lives until at least send +
  15 s, and we close by send + 10 s. Others act only once the key is gone (Redis time).
  That leaves at least 5 s for event-loop lag and clock-rate drift. The group lease
  fence stays as the second line: even a late write cannot land.
- **Clean stop** (`close()`):
  1. sockets close with `1001`, with no disconnect rules (PR 1, AC11);
  2. `DEL P:inst:<id>`;
  3. unsubscribe, then close both links.

  The registry entries stay for the sweep: another instance sweeps within one sweep
  tick (at most 5 s), or the next start does.
- **Behaviour change vs PR 1** (Q-B5): a Redis outage longer than 10 s now closes
  every group session of the instance with `1001`, even with one instance. Clients
  resume when Redis is back (ADR 0014 semantics, earlier).
- Timings are fixed constants in `limits/constants.ts`, not env. `redisStorage`
  accepts test-only overrides (`timings`) so tests run in about 1 s.

### 12.6 Attachment registry and recipients

- **Registry** (`storage/redis/attachments.ts`): read in the preload `MGET` and
  validated with zod (C1). An invalid registry fails closed: `StorageInvalidError`,
  as for the document. A missing registry with connected pids (a PR 1 document) means
  "attached to an unknown dead instance": the startup sweep handles it (12.8). Writes
  are buffered in the unit of work:
  - `set(pid, {i, t})` on attach;
  - `delete(pid)` on detach.

  The commit writes `P:a` only if it changed, and does `sadd`/`srem` on `P:ig:<i>`
  when an instance's first or last attachment in the group comes or goes.
- **Recipients** (`groups/recipients.ts`). This is a refactor first (chunk 2, no
  behaviour change). Every place that holds a `Session` taken from the notifier gets a
  `Recipient` instead:
  - `sessionOf` and `leaderOf` in `group-service.ts`, `lifecycle-service.ts`,
    `leader-controls.ts` and `join-service.ts`;
  - the owner check in `leader-guard.ts`;
  - `toMembers` and `endGroup`.

  ```ts
  interface Recipient {
    readonly pid: string;
    isOpen(): boolean;                         // local: socket open; remote: instance in the live cache
    send(text: string, later: boolean): void;  // later = after the session's pending replies
    detach(reason: 'replaced' | 'removed' | 'ended', text?: string, close?: 4004): void;
    refresh(at: number): void;                 // start the leader token refresher where the leader is
  }
  ```

  The three detach sites (`replaceOwner`, `detachRemoved`, `endGroup`) collapse into
  `Recipient.detach`. `LocalRecipient` wraps today's code exactly: `touch`,
  `unregister`, `membership = undefined`, and an outbox closure with
  `afterPending(deliver; close)`. `RemoteRecipient` deletes the registry entry and
  queues the matching remote effect.
- **Resolution** (`ClusterNotifier`, Redis mode). `get(key)` inside a task reads the
  task's registry:
  - an entry for this instance whose `t` equals the local session's
    `membership.attachId` gives that `LocalRecipient`;
  - an entry for another instance gives a `RemoteRecipient`;
  - anything else gives `undefined`. A local session the registry no longer names is
    not the owner (M4, even before the remote `detach` arrives).

  `owned(session)` keeps its local fast path and is re-checked against the registry
  under the lease, where it decides. Outside a task, only local sessions resolve.
  Memory mode uses `LocalNotifier` as today.

### 12.7 Cross-instance effects over pub/sub (AC17, P2-4, ADR 0012)

- **Connections.** Each instance has a command link (PR 1) and a **subscriber link**:
  `connect.ts` duplicates the client with the same URL, TLS (C10), timeouts and
  password handling (C9). The subscriber link has its own `error` listener with
  rate-limited `safeErr` logging and its own state events. It subscribes only to its
  own `P:ch:<id>`; channel names hold no group ID or code.
- **Sending.** At plan time, the unit of work groups the task's remote effects by
  instance, in queue order. It adds one `pub` op per instance. If a payload would pass
  `PUBSUB_MESSAGE_MAX_BYTES` (1 MiB), it adds several ordered `pub` ops; they stay
  ordered because one script runs atomically. An effect for an instance missing from
  the live cache is dropped (the sweep handles its attachments).
  - *As built:* a commit that publishes takes the next sequence from `P:seq` and sets
    the receiving instances' fields of `P:q:<ns>:<gid>` to it (Q-B10, below). Every
    group effect comes from a group task, so a remote effect outside a task is dropped
    with a debug log instead of a plain `PUBLISH`.
  - A single frame above `PUBSUB_FRAME_MAX_CHARS` is not sent
    (`remote_effect_too_large {op}`, error).
- **Message contract** (`storage/redis/pubsub.ts`). This is the only input accepted on
  the channel; it is parsed after a byte-length check (at most 1 MiB, else dropped):

  ```ts
  const ns = z.string().regex(NAMESPACE_PATTERN);
  const gid = z.string().regex(GROUP_ID_PATTERN);
  const pid = z.string().regex(PARTICIPANT_ID_PATTERN);
  const att = z.string().regex(/^[A-Za-z0-9_-]{22}$/);          // attachId
  const rid = z.string().regex(JOIN_REQUEST_ID_PATTERN);
  const frame = z.string().min(2).max(PUBSUB_FRAME_MAX_CHARS);  // 131 072: a serialized ServerMessage
  const effect = z.discriminatedUnion('op', [
    z.object({ op: z.literal('deliver'), ns, gid, pid, att, text: frame, later: z.boolean() }).strict(),
    z.object({ op: z.literal('detach'), ns, gid, pid, att,
      reason: z.enum(['replaced', 'removed', 'ended']), text: frame.optional(),
      close: z.literal(4004).optional() }).strict(),
    z.object({ op: z.literal('admit'), ns, gid, pid, att, rid, text: frame }).strict(),   // approved joiner
    z.object({ op: z.literal('settle'), ns, gid, rid, text: frame }).strict(),            // deny, timeout, group gone
    z.object({ op: z.literal('refresh'), ns, gid, pid, att, at: z.number().int().nonnegative() }).strict(),
    z.object({ op: z.literal('admitParked'), ns, gid }).strict(),
    z.object({ op: z.literal('forget'), ns, gid }).strict(),                              // group ended: drop local per-group state
  ]);
  // s: the publishing commit's sequence (Gate 2 Q-B10), from P:seq.
  const s = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  export const remoteMessage = z.object({ v: z.literal(1), s, effects: z.array(effect).min(1).max(512) }).strict();
  ```

  On the wire: `{"v":1,"s":<seq>,"effects":[...]}`, written by the `COMMIT` script.

- **Receiving.** Messages are applied in arrival order. Each effect runs through
  `GroupLock.runLocal(ns, gid)` and is checked against **local** state before anything
  happens (P2-4). Anything that doesn't match is dropped, with a debug log
  `remote_effect_dropped {op}`. An invalid message is dropped whole with
  `pubsub_message_invalid` (warn, no content).

  | Effect | Applied when | What it does |
  | ------ | ------------ | ------------ |
  | `deliver` | a local session owns `ns:gid:pid` and its `membership.attachId === att` | `deliver(text)`, after pending replies if `later` |
  | `detach` | same match | `unregister`, `membership = undefined`, then `afterPending(deliver text?; close 4004?)`, exactly as `LocalRecipient.detach` |
  | `admit` | a local session waits on `rid` for `gid` (`pendingJoin`) and is open | clear `pendingJoin`, attach with `{gid, pid, attachId: att}`, deliver `text` (`group.joined`). Otherwise `disconnectStale(ns, gid, pid, att)`: a leased task that runs the member-disconnect rules only if the registry entry still has `t === att` |
  | `settle` | a local session waits on `rid` | clear `pendingJoin`, deliver `text` after pending replies |
  | `refresh` | same match as `deliver` | start the token refresher for the leader here |
  | `admitParked` | any local parked session for the group | a leased task: today's `admitParked` for the local parked sessions |
  | `forget` | always | drop local per-group limiter, controls and refresher state |

- **Order (AC17).** Commits of a group are serialized by the lease, and publishes are
  part of the commits. Redis keeps the order of one connection's messages, and the
  receiver applies them in order through the local queue. So every recipient sees a
  group's events in commit order.
- **Order against the instance's own frames (Gate 2 Q-B10, as built).** Dropping an
  older effect would lose events (a remote frame of an earlier commit can be the only
  copy), so the order is enforced instead:
  1. Every commit that publishes takes a sequence from `P:seq` inside `COMMIT`:
     `max(last + 1, Redis time in microseconds)`, so it only grows, even if the key
     expired. Each message carries it as `s`, and the commit sets each receiving
     instance's field of the group's high-water hash `P:q:<ns>:<gid>` to it.
  2. A task first reads its group with `PRELOAD`, which includes its own instance's
     high-water mark. It then waits until its instance received every message up to
     that mark (at most `PUBSUB_BARRIER_MS`, 1 s), and the group's received effects
     are applied first (the group's inbox is drained before the task runs). Only then
     does the task run and flush its own frames.
  3. A message with `s` below the highest one received is stale and dropped
     (`pubsub_message_stale`, debug). A message 1 s of Redis time
     (`PUBSUB_SEQUENCE_REWIND_MAX`) or more below it means the sequence went back
     (`P:seq` lost while Redis time is behind, or a forged `s`): the link is
     replaced and resyncs (`cause: regressed`), as below (fix round 2, security S1).
  4. A link that does not reach the mark within the bound is lagging
     (`pubsub_barrier_timeout`, warn): it is replaced and resyncs, as below.

  Frames to members are sent at once (`later: false`); frames to the leader keep the
  single-instance "after pending replies" rule.
- **At-most-once (ADR 0012 rule).** When the subscriber link drops (as built: at once,
  not only when it comes back), is found stalled by its probe, or lags past the
  barrier, the instance closes every local session that is in a group, parked or
  pending with `1001` (`pubsub_link_lost {cause}`, then `pubsub_resync {sessions}`).
  While the link is down, storage reports `unreachable` (503 on upgrades). When a new
  link has subscribed, it reads `P:seq` as its baseline: everything published before
  is behind it. The last received sequence is set to that baseline, also when it is
  lower than before (security S1). The read goes over the command link and can
  overtake messages still on their way, so a PING on the subscriber link follows it:
  its reply comes after every message published before the read, which apply
  normally meanwhile, and only then is the baseline in place (QA round 1 window).
  From a self-fence (the old channel is left) and from every new subscription until
  its baseline is in place, storage reports `unreachable` and tasks wait for the
  baseline (security S3). Clients resume and read the current state.

### 12.8 Orphan sweep and stops (AC21, AC11 kept, AC12 kept)

- **Per-group sweep.** `sweepGroup(ns, gid)` generalizes PR 1's `sweepAfterRestart`
  and runs under the lease. Every connected pid whose registry entry is missing or
  names an instance not in the live set is disconnected with today's rules, and its
  entry is deleted:
  - the leader goes through `leaderOffline`, with the grace counted from now (AC21: the
    normal grace, not an instant handoff);
  - a member is removed and marked disconnected in the roster;
  - an empty group is held.

  The Q-A3 floor stays as in PR 1, and as built it applies only to groups no live
  instance attends (a single-instance restart). A peer dying in a running cluster is
  not a restart: its participants can resume on a live instance, and its leader gets
  the normal grace from the sweep. Nobody is told who left, beyond the usual
  `leader.offline` and roster frames, which reach the participants still attached on
  other instances.
- **Periodic.** Every `ORPHAN_SWEEP_MS` (5 000, ±1 000 jitter):
  1. `DEAD_INSTANCES`;
  2. for each dead ID, `SSCAN P:ig:<id>` (cursor, `COUNT 100`; not a pattern scan) and
     `sweepGroup` for each group;
  3. then `FORGET_INSTANCE`.

  It is idempotent, so concurrent sweepers on several instances only repeat no-ops.
- **Startup** (before `listen`): connect, epoch, register, subscribe, `runDue` (AC12),
  one dead-instance sweep, then the **legacy pass** over `P:live`. The legacy pass is
  PR 1's page-through, with a pre-check outside the lease. It takes the lease only for
  groups with a connected pid that has no live registry entry. That covers groups
  written by PR 1 (no `P:a`) and a single-instance restart, which gives the AC11 grace
  from when the server is back. An invalid document still ends only that group (PR 1,
  QA round 1 decision), now under the lease.
- **Resume before the sweep.** A participant whose old instance died resumes on another
  instance before the sweep runs: `replaceOwner` finds a `RemoteRecipient` for an
  instance not in the live set, so it only overwrites the registry (no publish). A
  leader resuming this way keeps the lead with no grace.

### 12.9 Method B approvals across instances (AC7, AC20)

- **Interface.** `joins/approval-store.ts`. `ApprovalQueue` (memory) moves behind it
  unchanged: its per-request scheduler timers keep today's exact timing, which protects
  AC1. `RedisApprovals` (`storage/redis/approvals.ts`) joins the unit of work:
  - it reads `P:aq` and then the request keys in the task; missing keys are expired and
    pruned in the commit;
  - it caps at `MAX_PENDING_APPROVALS_PER_GROUP` over live entries;
  - writes, deletes and the deadline timer go into the commit.
- **Joiner state** stays on the joiner's instance: `session.pendingJoin`, plus a local
  map `rid -> Session`.
- **Request** (joiner on B): a leased task on B writes `P:ap:<rid>` `{i: B, n?, d}` and
  `P:aq`, and arms the timer kind **`approvalDue`** at the earliest pending deadline
  (new in `TIMER_KINDS`). The leader, wherever it is, gets `join.requested` through its
  recipient.
- **Approve on A.** The request is read and deleted in A's commit (exactly once:
  lease plus fence).
  - Joiner local to A: as today. The `isOpen` and `busy` re-check gives
    `REQUEST_NOT_FOUND` when the joiner is gone.
  - Joiner on B, B not live: `REQUEST_NOT_FOUND` (settled `disconnected`). As built,
    B's liveness is read from Redis here (C12), not from the live cache.
  - Joiner on B, B live: A runs the store-side admission (size, block list, roster) and
    writes the registry entry `{i: B, t: new attachId}`. The same commit publishes
    `admit` with the `group.joined` frame. The leader gets
    `join.decided {outcome: 'admitted'}` (or `group_full`). If B then finds no waiting
    session, `disconnectStale` removes the member with the normal rules (Q-B3).
- **Deny, timeout, group end.** `settle` goes to the joiner's instance (or runs locally)
  with `JOIN_DENIED`, `APPROVAL_TIMEOUT` or `GROUP_ENDED`. The `approvalDue` handler
  settles every request with `d <= now` and re-arms for the next. The commit that ends
  a group deletes every request of the group, and each joiner gets `GROUP_ENDED`.
- **Joiner leaves or cancels on B.** A leased task deletes the request, and the leader
  gets `join.withdrawn` (`cancelled` or `disconnected`). If Redis is down, the request
  expires at its deadline (`PX`), and an approve after that finds nothing.
- **Leader returns.** The pending list is read from Redis and re-sent (today's
  `onLeaderReturn`).
- **AC20 "a joiner whose socket was lost sends a new request".** Unchanged client
  behaviour. The old request is withdrawn or expires; a new one gets a new `rid`.

### 12.10 Parked members across instances

Parking only happens when a group is missing from Redis (AC14 path).

- **Park on B.** As today, plus `SADD P:pk:<ns>:<gid> B` and `extend` to the parking
  bound. This is a direct step, since there is no group to lock; if Redis is down the
  session gets `1001`.
- **Recreation on A.** Inside the recreation commit (C7 checks unchanged), A reads
  `P:pk`, deletes it, and publishes `admitParked` to every other live instance listed.
  A's own parked sessions are admitted as today.
- **Receivers** admit their parked sessions in a leased task, in local arrival order.
  Across instances, the order of admission follows message arrival, not park time
  (12.18).

### 12.11 Codes, timers and limits (AC16, AC19, AC22, P2-6)

- **Codes (AC16).** Already global in PR 1: Lua `CLAIM`, all or none, plus
  compare-and-delete releases. No change. Tests with two instances and a forced
  colliding `codeRandom`.
- **Timers (AC19).** Already lease-claimed in PR 1. Handlers now also hold the group
  lease. A timer claimed by an instance that dies fires again after `TIMER_LEASE_MS`
  (30 s) on another instance. `approvalDue` is the only new kind.
- **Limits (AC22, Q12).** Connection caps, app connection caps, inbound rates, join
  attempts (per connection and per app), `tokens.check`, QR issue and recreation
  limits stay **per instance**. Door-code failures and method A pauses are **global**:
  they live in the document. Each leader's update rate is enforced on the leader's own
  instance.
- **P2-6.** The README states that the code-guessing budget (join attempts per app per
  minute) **multiplies by the number of instances**. The global door-failure rotation
  and pause still bound guessing of door codes. Q-B6 proposes a follow-up issue for a
  Redis-backed join-attempt limiter.

### 12.12 Failure while running (ADR 0014, several instances)

| Event | Effect |
| ----- | ------ |
| Command link down or stalled | PR 1 rules: `1001` for the group on failed commits, 503 on upgrades, replay queue. After 10 s without a heartbeat: self-fence (12.5). |
| Subscriber link dropped, stalled or lagging past the 1 s barrier (Q-B10) | resync at once: local group sessions get `1001`; storage `unreachable` (503) until a new link has subscribed (12.7) |
| Lease lost (`LeaseLostError`) | nothing written or published; the group's local sessions get `1001` |
| Lease wait over 5 s (`StorageBusyError`) | the requester gets `1001`; disconnects are replayed; timers retry after their lease |
| Invalid pub/sub message | dropped, `pubsub_message_invalid` |
| A peer instance dies | its attachments are swept within about 20 s (15 s liveness + up to 5 s tick); its timers fire again within 30 s |

### 12.13 Contracts

- **Wire protocol:** no change; `PROTOCOL_VERSION` stays 1.
- **HTTP:** no change.
- **Env and config:** no new variable. All instances on one prefix must share
  `TOKEN_SECRET` (and the previous keyring), the apps config and the env ceilings
  (README; Q-B9).
- **Server API:** `redisStorage` gains test-only options: `timings` overrides
  (including `sweepMs` and `timerLeaseMs`), `monotonic` (the self-fence clock) and
  `beforeCommit` (a hook before every group commit). `SyncServer` is unchanged.
- **Redis data:** 12.3. **Pub/sub:** 12.7, `v: 1` as shipped: `{v: 1, s, effects}`,
  with `s` the commit sequence (Q-B10). A future change uses `v: 2`, and receivers
  drop versions they don't know.
- **Logs** (new events; no URL, host, key, code, name, participant ID or full
  instance ID):
  - `instance_registered {instanceRef}`; `instance_fenced {instanceRef, cause}` (the
    field is `cause`, since a repo test forbids a log field named `reason`);
    `fence_error {err}` (error, a fence step failed);
  - `orphan_sweep {instances, groups, invalid}`; `orphan_sweep_failed {err}` (warn);
  - `pubsub_resync {sessions}`; `pubsub_link_lost {cause}` (warn; `dropped`,
    `stalled`, `lagging`, `regressed`, `subscribe_failed` or `baseline_failed`);
    `pubsub_barrier_timeout` (warn, Q-B10); `pubsub_message_stale` (debug, Q-B10);
    `pubsub_message_invalid` (warn);
  - `remote_effect_dropped {op}` (debug); `remote_effect_too_large {op}` (error);
  - `group_lock_busy {groupRef}` (debug); `group_lease_lost {groupRef}` (warn);
    `group_lease_hold_cap {groupRef}` (warn, renewals stopped at the 30 s hold cap).

### 12.14 `compose.multi.yaml` (AC23, P2-8)

Dev only, used as a third file:

```
docker compose -f compose.yaml -f compose.redis.yaml -f compose.multi.yaml up --build
```

- `sync-server`: `ports: !reset []` (no host port).
- `sync-server-2`: `extends` `sync-server` from `compose.yaml`, with the same
  `REDIS_URL`, `REDIS_KEY_PREFIX` and `depends_on: redis healthy` as
  `compose.redis.yaml`, `ports: !reset []`, the same image (no second build).
- `lb`: `nginxinc/nginx-unprivileged:<stable>-alpine@sha256:<digest>` (Q-B8). The
  engineer pins the current stable alpine digest, checked with
  `docker buildx imagetools inspect`. It runs as uid 101 on port 8080 with
  `ports: ['127.0.0.1:8080:8080']` (loopback only), `read_only: true`, `tmpfs: /tmp`,
  `cap_drop: [ALL]` and `no-new-privileges`. It mounts `./config/nginx-multi.conf`
  read-only and waits for both servers to be healthy.
- `config/nginx-multi.conf`:
  - `upstream` with both servers, round robin (no `ip_hash`, `hash` or `sticky`);
    as built, with a shared `zone` so every nginx worker uses one rotation, and
    `proxy_connect_timeout 2s` so a stopped instance is skipped quickly;
  - WebSocket upgrade (`proxy_http_version 1.1`, `Upgrade` and `Connection` from a
    `map`);
  - `proxy_read_timeout 120s` (above the 30 s heartbeat);
  - `access_log off`.
- Redis stays as in `compose.redis.yaml`: no host port, `--save ""`,
  `--appendonly no`, `noeviction`, tmpfs `/data` (C3), and the dev password, accepted
  only with `NODE_ENV=development` or `test` (C5).
- The reader is unchanged: `ws://127.0.0.1:8080/ws` now reaches the load balancer.

### 12.15 Files

Create (all under `apps/sync-server/` unless rooted):

| Path | What |
| ---- | ---- |
| `src/storage/redis/lease-lock.ts` | `RedisLeaseSource`: acquire, renew, release, hold cap |
| `src/storage/redis/instance.ts` | instance ID, register, heartbeat, self-fence, live cache, dead list, forget |
| `src/storage/redis/attachments.ts` | registry schema, read in the preload, buffered writes, `P:ig` steps |
| `src/storage/redis/pubsub.ts` | subscriber link, `remoteMessage` zod schema, encode and split, dispatch |
| `src/storage/redis/approvals.ts` | `RedisApprovals` on the unit of work |
| `src/storage/redis/parking.ts` | `P:pk` add, read and delete |
| `src/groups/recipients.ts` | `Recipient`, `LocalRecipient`, `RemoteRecipient` |
| `src/groups/cluster-notifier.ts` | registry-based resolution (Redis mode) over `LocalNotifier` |
| `src/groups/remote-effects.ts` | effect types (shared with `pubsub.ts`) and the receiver-side apply |
| `src/joins/approval-store.ts` | `ApprovalStore` interface plus the memory adapter around `ApprovalQueue` |
| `test/helpers/cluster.ts` | N in-process servers on one prefix (own links, shared secret and apps), per-instance TCP proxy to partition one, short `timings` |
| `test/pubsub-schema.test.ts` | contract unit tests (every op; rejects extra fields, bad patterns, oversize text and payload, `v: 2`) |
| `test/recipients.test.ts` | local recipient keeps today's order (send, detach, close) |
| `test/lease-lock.redis.test.ts` | acquire, wait bound, renew, hold cap, release, fence abort |
| `test/instance.redis.test.ts` | register, heartbeat, fenced reply, self-fence by silence, new ID |
| `test/multi-*.redis.test.ts` | the several-instance suites (12.17) |
| `test/multi-process.redis.test.ts` | two server processes, `SIGKILL` one (AC21) |
| `test/ended-invalid-codes.redis.test.ts` | #39 (chunk 1) |
| `compose.multi.yaml` (root) | two instances plus load balancer |
| `config/nginx-multi.conf` (root) | load balancer config |

Modify:

| Path | Change |
| ---- | ------ |
| `src/storage/redis/keys.ts` | new keys and part checks (12.3) |
| `src/storage/redis/scripts.ts` | `COMMIT` ops `sadd`, `srem`, `pub`; new scripts (12.3) |
| `src/storage/redis/unit-of-work.ts` | preload `MGET` with `P:a`; lease check first; registry, approvals and parking steps; `pub` ops |
| `src/storage/redis/redis-storage.ts` | instance, lease source, pub/sub, approvals; startup order (12.8); periodic sweep; `close()` forgets the instance |
| `src/storage/redis/connect.ts` | subscriber link (duplicate with the same options and redaction) |
| `src/storage/redis/ended.ts` | `endInvalid`: code keys (#39) and the new group keys, under the lease |
| `src/storage/errors.ts` | `StorageBusyError`, `LeaseLostError` |
| `src/storage/storage.ts` | `Storage` gets `lease?`, `cluster?`, `approvals`, `parking?` |
| `src/groups/group-lock.ts` | `LeaseSource`, `runLocal` |
| `src/groups/notifier.ts` | interface returns recipients; `LocalNotifier` unchanged inside |
| `src/groups/session.ts` | `Membership.attachId` |
| `src/groups/group-service.ts` | recipients; registry-based `owned`; `sweepGroup` (generalized sweep); `disconnectStale`; remote parking; refresher via recipient; busy and lease-lost paths |
| `src/groups/group-timers.ts` | kind `approvalDue` |
| `src/joins/join-service.ts`, `src/joins/approval-queue.ts` | `ApprovalStore`; joiner references (local session or `{instance, rid}`) |
| `src/lifecycle/lifecycle-service.ts`, `leader-controls.ts`, `leader-guard.ts` | recipients instead of sessions |
| `src/ws/connection.ts` | `StorageBusyError` closes the requester with `1001` |
| `src/server.ts` | wiring, startup order, `close()` |
| `src/limits/constants.ts` | `GROUP_LEASE_MS`, `GROUP_LEASE_RENEW_MS`, `GROUP_LEASE_MAX_HOLD_MS`, `GROUP_LOCK_WAIT_MS`, `INSTANCE_LIVENESS_MS`, `INSTANCE_HEARTBEAT_MS`, `INSTANCE_SELF_FENCE_MS`, `ORPHAN_SWEEP_MS`, `PUBSUB_MESSAGE_MAX_BYTES`, `PUBSUB_FRAME_MAX_CHARS` |
| `test/keys.test.ts`, `test/redis-stored-values.redis.test.ts`, `test/redis-privacy.redis.test.ts`, `test/outage.redis.test.ts`, `test/restart.redis.test.ts` | new keys and values (C1, C6), lifetimes (AC24), log privacy (AC25), outage longer than the self-fence, restart through the new startup order |
| `test/repo-hygiene.test.ts` | `compose.multi.yaml` and nginx checks; README checks (12.16) |
| `.github/workflows/ci.yml` | `docker compose ... config -q` for the three combinations; `check` `timeout-minutes` 15 -> 25 |
| `README.md`, `docs/conventions.md` | 12.16 |

### 12.16 Docs impact

- `README.md`:
  - "Storage (Redis)": the bold **"One instance only, for now"** paragraph is replaced
    by a new **"Several instances"** subsection:
    - same `REDIS_URL` and prefix;
    - identical `TOKEN_SECRET` (and previous keyring), apps config and env ceilings on
      every instance;
    - NTP;
    - a load balancer with WebSocket upgrade, no sticky sessions, idle timeout above
      30 s;
    - what happens when an instance stops or is killed (normal grace; detected within
      about 20 s; timers within 30 s);
    - a Redis outage longer than 10 s closes the instance's group sessions with `1001`;
    - frames, including leader-only frames with display names, travel through Redis
      pub/sub (P2-5);
    - pending joiners' chosen names live in Redis until settled or the deadline.
  - Per-instance limits table (AC22), with the **join-attempt multiplication note**
    (P2-6): the per-app join budget and the code-guessing budget grow with the number
    of instances; door-code failures and pauses are global.
  - ACL example: add channels `&<prefix>:*` and `+@pubsub` (pub/sub, and `PUBLISH`
    from the commit script; F14 follow-on).
  - "Run with Docker Compose": the `compose.multi.yaml` example (AC23).
  - "Upgrading": from the PR 1 build, stop **every** instance before starting the new
    ones; mixing old and new instances on one prefix is not supported (Q-B7).
  - "Deployment security": the "one instance per token secret" bullet becomes "without
    Redis: one instance; with Redis: any number of instances on one prefix, all on one
    keyring".
  - The "Timers" and "Recovery and tokens" sections are touched only where they say
    "one instance".
- `docs/conventions.md`: one row, "Several instances (9a PR 2)": lease lock timings,
  self-fence, registry key, publish inside the commit, busy closes the requester only.
  ADRs 0011 and 0012 stay Accepted (no text change).
- `repo-hygiene.test.ts` asserts:
  - the README no longer says "One instance only";
  - it has a "Several instances" heading;
  - it mentions `compose.multi.yaml` and the join-attempt multiplication.

### 12.17 Test plan (PR 2)

Runner: Vitest. The several-instance suites are `*.redis.test.ts`: they run when
`SYNC_TEST_REDIS_URL` is set, and `redis-required.test.ts` still fails CI without it.
`test/helpers/cluster.ts` starts 2 or 3 in-process servers on one random prefix. They
share the token secret and the apps config, and each has its own links, a per-instance
TCP proxy to Redis (to partition one) and short `timings`. Liveness uses real time;
group timers use real time with short app settings, or the manual scheduler where a
single clock suffices.

| AC | Test |
| -- | ---- |
| AC6 | 3 instances start at once on one prefix (concurrent startup sweeps, no error, no duplicate effect); clients spread round-robin all work. |
| AC7 (approvals) | A pending request is a key with `PTTL <=` the deadline and `<= E`; it is gone after settle and after group end. |
| AC16 | Create on A; join on B by group code + door code, by alphanumeric code and by QR ticket. Concurrency: 2 instances x 20 creates with a `codeRandom` that collides; no two live groups share a code (key scan). |
| AC17 | Every event type to a member on B from a leader on A: position, roster, leader changes, lifecycle prompts, pause and resume, lock, removal with close 4004 (`detach` + close), group end. **Bound:** 20 leader moves on A, each received on B in **< 1 000 ms** (assert the max on a local run). Order: a burst of 50 updates arrives in order. |
| AC18 | Concurrency with two instances (`Promise.all`, repeated 20 times): the last slot (exactly one `group.joined`, one `GROUP_FULL`); two leader resumes with the same token (exactly one leads, the other `replaced`); take-back against a handoff; create-if-absent (two recreations after a flush: one group, one term). **Fence:** with a test lease of 300 ms and a commit delayed 600 ms on A, B takes the lease and commits; A's commit aborts `lease`, the document is byte-identical to B's write, and A's local sessions of the group get `1001`. **Busy:** a lease held past the wait bound gives the requester `1001`, and the group's other sessions stay open. |
| AC19 | Each kind fires once with 3 instances (counted by outcome and by a test hook). A `maxSession` timer claimed by A, then A partitioned before its handler commits: it fires on B after the timer lease (short in the test). |
| AC20 | Joiner on B, leader on A: approve (`group.joined` on B, `admitted` on A), deny, timeout (`APPROVAL_TIMEOUT` on B, `join.withdrawn timeout` on A), group end (`GROUP_ENDED`), cancel, joiner socket closed (`join.withdrawn disconnected`); each settles once (counted). Approve racing a joiner close: the member is admitted, then removed by `disconnectStale` (Q-B3). Leader return re-sends pending requests across instances. |
| AC21 | Clean stop of A: its members resume on B; its leader resumes on B and keeps the lead, or after `disconnectGraceSeconds` hands off (no handoff before). Partition of A (heartbeat fails): A self-fences (all its group sessions `1001`) **before** B's sweep, which then sweeps A's attachments. `multi-process.redis.test.ts`: two processes, `SIGKILL` one, clients reconnect through the other and the group goes on. |
| AC22 | `MAX_CONNECTIONS=2` per instance: 2 instances accept 4 and refuse the 5th on each; join-attempt limits are counted per instance; door failures add up across instances (rotation after 5 failures split 3 + 2). |
| AC23 | `repo-hygiene.test.ts`: `lb` image pinned by digest; only `lb` publishes a port, and on 127.0.0.1; both servers have `ports: !reset []`; Redis flags and dev-password rule still hold; nginx config has the upgrade headers and no `ip_hash`, `hash` or `sticky`. QA: `docker compose ... config` and, where Docker allows, a manual two-instance run through `127.0.0.1:8080`. |
| AC24 | After a full multi-instance flow (attach on two instances, a pending approval, a parked member), every new key has a TTL `<= E` (requests `<=` deadline); after the end, no key of the group remains (`P:a`, `P:aq`, `P:ap:*`; `P:ig:*` without the group). |
| AC25 | Log capture across fence, sweep, resync and dropped effects: no pid, name, code, key with a group ID, full instance ID, URL or password. |
| AC29 | Shared contract suites still run on both stores, plus the suites above with two or more servers. The whole sync-server suite also runs with `SYNC_TEST_STORE=redis` (every server test on the lease lock). |
| AC31 | `ci.yml` jobs green in local Docker (below). |
| AC32 | README checks above. |
| P2-4 | `pubsub-schema.test.ts` (contract); an injected message with a wrong `att`, an unknown `rid` or a foreign group changes nothing (no frame, no close). |
| #39 | Chunk 1: store a group with an invalid document and its two code keys, run the startup sweep; the code keys are gone (compare-and-delete), the group is ended, and a code key already pointing at another group stays. |

All PR 1 suites stay green in both modes. That is the AC1 guard for the recipient and
approval refactors (chunks 2 and 3 change no behaviour).

**Local CI (GitHub Actions is blocked by billing; as QA did for #38).** From the repo
root, with a fresh clone so no `dist/` leaks in:

```
docker network create ci-35b
docker run -d --name ci-35b-redis --network ci-35b \
  redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335 \
  redis-server --requirepass ci-only-redis-password --save "" --appendonly no \
  --maxmemory-policy noeviction
docker run --rm --network ci-35b -e CI=true \
  -e SYNC_TEST_REDIS_URL=redis://:ci-only-redis-password@ci-35b-redis:6379 \
  -v "$PWD":/src:ro node:24 bash -c 'git clone /src /w && cd /w && corepack enable && \
  pnpm install --frozen-lockfile && pnpm audit --audit-level=high && pnpm lint && \
  pnpm typecheck && pnpm test && \
  SYNC_TEST_STORE=redis pnpm --filter @sync-system/server test && pnpm build'
# e2e job as for #31 and #38 (memory store, unchanged)
docker compose -f compose.yaml config -q
docker compose -f compose.yaml -f compose.redis.yaml config -q
docker compose -f compose.yaml -f compose.redis.yaml -f compose.multi.yaml config -q
docker rm -f ci-35b-redis && docker network rm ci-35b
```

`ci.yml` is kept correct for when Actions runs again:

- the `check` job keeps its `docker run` Redis step (F15);
- a new step `Compose files` runs the three `docker compose ... config -q` commands
  (the runner has Docker Compose v2);
- `timeout-minutes` goes from 15 to 25 for the added suites.

No other job changes.

### 12.18 Risks and edge cases

- **Mixed PR 1 and PR 2 instances** on one prefix: PR 1 takes no lease, so it breaks
  AC18. The README "Upgrading" note says to stop every instance first (Q-B7). Rolling
  back to the PR 1 build is safe for data: it ignores `P:a`, `P:ap` and the others,
  which expire by `E`. Its startup sweep disconnects everyone with the restart grace.
- **Hot groups and lease fairness.** There is no queueing across instances; a busy
  instance can win the lease repeatedly. The leader rate limit bounds a group's write
  rate, and the test "join on B during 10 updates/s on A completes < 1 s" guards it.
  The wait bound turns starvation into `1001`, never a hang.
- **Approve races** (Q-B3): `admitted`, then gone, unlike single-instance
  `REQUEST_NOT_FOUND`.
- **Parked duplicates across instances.** Two parked sessions of one pid on two
  instances are admitted in message order; the later one replaces the earlier
  (`replaced`), so the newest-wins rule (M5) holds per instance only.
- **Dead-but-not-yet-swept instances** (up to about 20 s) look attached:
  - a handoff may pick a successor that is on such an instance; the sweep then puts
    that leader offline with a new grace;
  - frames published to it are lost, and those clients resume anyway.
- **Timers on a killed instance** fire up to 30 s late (ADR 0013 lease).
- **A newly started instance** is in a peer's live-instance cache only after that
  peer's next heartbeat (up to 5 s). Until then the peer treats its participants as
  not connected wherever it checks `isOpen()`: for example, a grace ending on the peer
  in that window skips them as successors (with nobody else eligible, the group stays
  paused). Frames and detaches are still published to them. Found by the fix round 1
  tests (`cluster.converged()` waits it out); not changed in PR 2.
- **Self-fence on a slow Redis** (renewals take more than 10 s) closes sessions without
  a real partition. This fails safe; clients resume.
- **Large frames through pub/sub**: a roster snapshot is up to about 45 KB, under the
  128 Ki-character frame cap. A bigger snapshot (`MAX_GROUP_SIZE_CEILING` above 100)
  would be split across `pub` ops, and a single frame above the cap is a bug (logged,
  not sent). The engineer measures the largest frame at the ceiling.
- **Config drift between instances** (secret, apps, ceilings) shows up as refusals or
  TTL mismatch. Documented; no runtime check (Q-B9).
- **Epoch after a flush with several instances.** Every decision point already reads
  the epoch from Redis (P2-2, C7); per-instance iat floors follow on their next read.
- **Redis pub/sub buffer limits** (`client-output-buffer-limit pubsub`): a slow
  subscriber is disconnected by Redis, which triggers the resync rule. The README names
  the setting.

### 12.19 Security-sensitive areas

Security-sensitive: yes

- **Concurrency and authorization.** The lease lock and commit fence carry every
  "exactly one wins" rule across instances: #5 AC27, #10 R11/R14, #13 RC1-RC21, AC18.
  A registry-based owner check (M4) decides who may act, under the lease.
- **New input boundary.** Pub/sub messages are zod-validated and applied only to
  matching local sessions (P2-4).
- **Personal data in Redis.** Pending joiners' names, with a TTL to the deadline. The
  registry holds pids and instance IDs only. Frames with names transit Redis (P2-5).
  Everything is deleted at group end, with TTLs `<= E` (AC24).
- **Availability.** Self-fence, resync, busy and lease-lost all close with `1001`, and
  each is scoped as narrowly as possible (C8, P2-7).
- **Rate limits per instance** (P2-6).
- **Compose and load balancer exposure** (P2-8).
- **No new dependency.** The nginx image is dev-compose only, pinned by digest.

How each PR 2 item from security.md section 4 is settled:

| Item | Settled by |
| ---- | ---------- |
| P2-3 self-fencing | 12.5: close at 10 s since the last successful send, the key lives 15 s, sweepers act only on a missing key; a new ID after a fence; the lease fence stays as the second line. Tests: partition before sweep; fenced heartbeat reply. |
| P2-4 pub/sub input | 12.7: byte cap, strict zod schema, apply only on a matching membership and `attachId` (or a matching pending `rid`), drop otherwise; subscriber link has its own `error` listener with `safeErr`; instance ID 128-bit random, logged as `instanceRef` only. |
| P2-5 frames with names | README (12.16); ACL channel scope. |
| P2-6 per-instance join limits | README multiplication note; door failures global; follow-up issue (Q-B6). |
| P2-7 lock wait | 12.4: no client awaited inside a task; wait bound 5 s, then `StorageBusyError` for the requester only; hold cap 30 s; fence. |
| P2-8 `compose.multi.yaml` | 12.14: nginx pinned by digest (unprivileged image), loopback only on `lb`, no host ports elsewhere, Redis C3 flags and C5 dev password via `compose.redis.yaml`; `repo-hygiene.test.ts`. |

C1-C10 carry over to the new code:

- C1: registry, requests, parking set and messages are validated.
- C6: new keys only from `keys.ts`; scripts constant.
- C8: busy and dropped effects close nobody else.
- C9: the subscriber link uses the same redaction.
- C10: the subscriber link uses the same TLS.

### 12.20 Implementer model

Implementer model: opus
Reason: security-sensitive distributed concurrency (lease fencing, self-fencing,
cross-instance delivery) across about 30 files, with a new input boundary and
approval semantics across instances. Nothing here follows an existing pattern.

### 12.21 Implementation chunks (PR 2, all in this repo, on `feat/35-redis-multi-instance`)

1. `fix(storage): delete join-code keys when an invalid stored group ends` (#39;
   **only if Q-B1 = yes**; with `test/ended-invalid-codes.redis.test.ts`; PR body
   `Refs #39` becomes `Closes #39`)
2. `refactor(server): reach participants through recipients` (Recipient,
   `Membership.attachId`, one detach path; no behaviour change)
3. `refactor(server): put method b approvals behind an async store` (`ApprovalStore`,
   memory adapter; no behaviour change)
4. `feat(storage): register instances with liveness and self-fencing` (12.5; P2-3)
5. `feat(storage): fence group tasks with a redis lease lock` (12.4; AC18 base;
   P2-7)
6. `feat(storage): keep an attachment registry per group` (12.6)
7. `feat(storage): deliver group effects across instances over pub/sub` (12.7;
   AC17; P2-4)
8. `feat(server): sweep the attachments of stopped instances` (12.8; AC21; AC11 and
   AC12 kept)
9. `feat(storage): keep method b approvals in redis across instances` (12.9; AC7,
   AC20)
10. `feat(server): admit parked members across instances` (12.10)
11. `test(server): cover several instances on one redis` (12.17: AC6, AC16-AC22,
    AC24, AC25, AC29; multi-process kill)
12. `build(compose): add a two-instance example behind a load balancer` (12.14;
    AC23; P2-8)
13. `ci: check the compose files and allow time for the multi-instance tests`
    (AC31)
14. `docs(server): document several instances` (12.16; AC6, AC22, AC32; P2-5,
    P2-6)

Each chunk keeps `pnpm lint`, `pnpm typecheck` and `pnpm test` green (Redis suites
included). Chunks 4-10 bring their own focused tests; chunk 11 adds the cross-cutting
suites.

### 12.22 Gate 2 questions for PR 2 (recommendation first)

- **Q-B1. Fold follow-up #39 into PR 2?** Recommended: **yes**, as chunk 1.
  - Why: PR 2 rewrites `endInvalid` anyway, because it must also delete the new keys
    `P:a`, `P:aq` and `P:ap:*`.
  - The fix is small: read the code fields leniently from the invalid document, check
    each against its pattern, and compare-and-delete them, so another group's code is
    never touched; codes it cannot parse expire with their TTL (`<= E`).
  - It carries its own Redis test.
  - The PR body then changes `Refs #39` to `Closes #39`.

  Alternative: keep #39 separate. Then `endInvalid` is touched twice.
- **Q-B2. Refinements inside ADRs 0011 and 0012** (12.1): the registry in its own key,
  `PUBLISH` inside the commit script, and a lease-wait timeout that closes only the
  requester. Recommended: yes; no new ADR, recorded in `docs/conventions.md`.
- **Q-B3. Approve racing a joiner's disconnect across instances.** Recommended: accept.
  The leader gets `admitted`, then the member shows as gone through the normal
  disconnect rules, instead of `REQUEST_NOT_FOUND`. The window is the pub/sub delay
  (milliseconds). Alternative: a two-step approve (ask B first), which adds a round
  trip and a new pending state. Not worth it.
- **Q-B4. Lease-wait timeout of 5 s gives `1001` to the requester only**, and nothing
  else closes. Recommended: yes.
- **Q-B5. Fixed timings:**
  - group lease 10 s, renewed every 3 s, wait 5 s, hold cap 30 s;
  - instance liveness 15 s, heartbeat 5 s, self-fence 10 s, sweep every 5 s.

  This means a killed instance's participants are swept within about 20 s and its
  timers fire within 30 s. A Redis outage longer than 10 s now closes group sessions
  even with one instance. Recommended: yes, as constants, not env.
- **Q-B6. Join-attempt limits per instance (P2-6).** Recommended: document the
  multiplication in PR 2, and have the pm open a follow-up issue for a Redis-backed
  global join-attempt limiter (Q12 stays "per instance" for 9a).
- **Q-B7. Upgrading from the PR 1 build.** Recommended: stop every instance, then
  start the new ones; mixed versions on one prefix are unsupported (README).
- **Q-B8. Load balancer image for the dev compose.** Recommended:
  `nginxinc/nginx-unprivileged` (alpine, digest-pinned, non-root on port 8080).
  Alternative: the official `nginx` image, whose master process runs as root.
- **Q-B9. Configuration consistency across instances.** Recommended: document only
  (same token keyring, apps config and env ceilings). Alternative: a startup check
  through a config fingerprint in Redis. Deferred, because a fingerprint derived from
  the token secret would need its own security review.

## 13. Files (PR 1, merged)

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

## 14. Docs impact (PR 1, merged; PR 2: 12.16)

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

## 15. Test plan (PR 1, merged)

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

## 16. Risks and edge cases (PR 1, merged; PR 2: 12.18)

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

## 17. Implementation chunks (PR 1, merged; all in this repo, on `feat/35-redis-docs-release`)

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

## 18. Gate 2 questions for PR 1 (answered 2026-11-12, see STATE.md)

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

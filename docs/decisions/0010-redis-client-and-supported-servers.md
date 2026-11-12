# 0010. Redis client library and supported Redis servers

- Status: Accepted (Gate 2, 2026-11-12: user chose the recommended option)
- Date: 2026-11-12
- Issue: #35

## Context

#35 (PRD item 9a) adds an optional Redis store to the sync server: groups
survive a restart, and several instances share one Redis. Gate 1 (Q5)
accepted the recommended default, to be confirmed here: the official
node-redis client, loaded only when Redis is configured, Redis 7.2+ and
protocol-compatible Valkey, a single endpoint (no Cluster, no Sentinel).

Constraints:

- A runtime dependency of the server image, so it is pinned exactly and
  `pnpm audit --audit-level=high` stays clean (AC28).
- An in-memory server never loads it and never opens a connection (AC1,
  AC28): the module is imported dynamically, only when `REDIS_URL` is set.
- Needs: `redis://` and `rediss://` URLs with a password (AC2), Lua scripts
  (`EVALSHA`/`EVAL`), `MULTI`/`EXEC`, sorted sets, pub/sub on a second
  connection (several instances, PR 2), connect and command timeouts, no
  offline queue (fail fast while Redis is down, AC26), automatic reconnect.
- Error messages from the client can contain the host and port. The server
  already logs errors through `safeErr` (name, code and stack frames only,
  never the message), so nothing extra is needed for AC25 as long as every
  client error goes through it.
- ESM, TypeScript types included, Node 24.

Versions checked on 2026-11-12: `redis` 6.3.1 (MIT), `@redis/client` 6.3.1
(MIT, no dependencies), `ioredis` 6.0.0 (MIT, 6 dependencies).

## Options

1. **`@redis/client`, exact `6.3.1` (recommended).** The core of the
   official node-redis project, the same code the `redis` package
   re-exports, with zero dependencies. Promise API, typed commands, RESP3,
   `defineScript` for Lua with automatic `EVALSHA`, `MULTI`, pub/sub
   through `duplicate()`, `socket.connectTimeout`, `socket.reconnectStrategy`,
   `disableOfflineQueue`, TLS through `rediss://`. Cons: none against the
   needs; the name differs from the "`redis`" written at Gate 1, but it is
   the same client.
2. **`redis`, exact `6.3.1`.** The meta-package named at Gate 1. Pulls
   `@redis/client` plus four module clients we would never use
   (`@redis/json`, `@redis/bloom`, `@redis/search`, `@redis/time-series`):
   more code in the image and more audit surface for nothing.
3. **`ioredis` 6.0.0.** Mature, built-in Cluster and Sentinel support,
   `defineCommand` for Lua. Cons: six runtime dependencies (`debug`,
   `denque`, `redis-errors`, `cluster-key-slot`, `@ioredis/commands`,
   `standard-as-callback`); its Cluster and Sentinel strengths are out of
   scope (Q5); an offline queue on by default that must be turned off.

Supported servers (same for every option):

- Redis 7.2 or later and Valkey 7.2 or later (Valkey reports
  `redis_version` 7.2.x), one endpoint, no Cluster mode. Startup reads
  `INFO server` and refuses a server below 7.2 (`Startup error`). 7.2 is
  needed for `PEXPIRE ... GT` and `SET ... PXAT` with `GET`.
- CI and the dev compose run the minimum supported version, so the tests
  prove the floor: `redis:7.2.17-alpine` pinned by digest
  `sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335`
  (BSD-3-Clause, the last BSD release line). Valkey is supported by
  protocol compatibility and named in the docs; a Valkey run is an optional
  QA extra (`valkey/valkey:8-alpine`), not a CI job.

## Decision

Accepted: **option 1**, `@redis/client` pinned at exactly `6.3.1`, in
`apps/sync-server` `dependencies`, imported only through a dynamic
`import('@redis/client')` in `src/storage/redis/connect.ts`. Redis 7.2+ and
Valkey 7.2+, single endpoint, tested against `redis:7.2.17-alpine` by digest.

## Consequences

- The server image grows by one zero-dependency package; the in-memory path
  is unchanged and never imports it (a test asserts the module is not
  loaded when `REDIS_URL` is unset).
- Upgrades of the client are explicit (exact pin) and go through
  `pnpm audit`.
- Cluster and Sentinel stay out of scope; adding them later means a new ADR.
- The compose override and the CI service use the pinned digest; a bump is
  a reviewed change like the Node base image.

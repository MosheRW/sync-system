# Sync System

Group Reading Sync: a sync service that lets an ad-hoc group follow one
leader's position in real time, and a reading app that is its first
customer. The server syncs a **position, not a page**: it stores and relays an
opaque payload and never reads it.

## Workspace

A pnpm workspace (Node 24, pnpm 10, TypeScript, ESM).

| Package                         | Path                | What                                                    |
| ------------------------------- | ------------------- | ------------------------------------------------------- |
| `@mosherw/sync-system-protocol` | `packages/protocol` | Wire protocol: versions, error codes, schemas.          |
| `@mosherw/sync-system-server`   | `apps/sync-server`  | The sync server (HTTP `/health`, `/ready` + WebSocket). |
| `@mosherw/sync-system-client`   | `packages/client`   | Framework-free client for browsers and Node.            |
| `@mosherw/sync-system-react`    | `packages/react`    | React/Next provider and hooks over the client.          |
| `@mosherw/sync-system-reader`   | `apps/reader`       | The reading app (React + Vite, Node server).            |

`packages/*` holds libraries and `apps/*` holds deployables.

The client's usage, API, events, error codes, connection states and
reconnect behavior are documented in
[`packages/client/README.md`](packages/client/README.md).
The React and Next.js provider, hooks and SSR rules are documented in
[`packages/react/README.md`](packages/react/README.md).
The reading app (content schema, fingerprint, direction rules, configuration)
is documented in [`apps/reader/README.md`](apps/reader/README.md).

```sh
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm lint                # eslint + prettier --check
pnpm typecheck
pnpm test                # vitest in every package
pnpm build
pnpm audit               # high and critical advisories
```

## Sync server

How to install, configure, scale, upgrade and secure the server (Docker
Compose, the apps config file, every environment variable, Redis, several
instances, health and readiness, token secret, timers, joining limits,
deployment security) is in the
[operator guide](docs/operator-guide.md). Startup errors and their fixes are
in [`docs/startup-errors.md`](docs/startup-errors.md).

### Protocol (v1) in brief

Plain WebSocket, one JSON object per text frame. The full protocol is in
[`docs/issues/1/architecture.md`](docs/issues/1/architecture.md) (section 5)
and the types are exported by `@mosherw/sync-system-protocol`.

1. Server sends `welcome` with `protocolVersion` and `minProtocolVersion`.
2. Client sends `hello` with `protocolVersion`, `appVersion` (semver) and
   `apiKey`; the server answers `hello.ok` (with the app's limits) or an
   `error` and closes (4001; 4003 when the app is at `maxConnections`; 4002 if
   no hello arrives within 5 s).
3. `group.create` (`metadata`, optional `position` and `joinMethods`) makes
   the sender leader and returns its `codes`; `group.joinByCode` (`joinCode`,
   optional `doorCode` and `displayName`) and `group.joinByQr` (`ticket`)
   return the metadata and current position (or `hasPosition: false`), or
   `join.pending` when the leader must approve; `position.update` from the
   leader is relayed to every member as `position.updated`. `group.created`
   and `group.joined` carry the participant's token; `hello.ok` carries the
   app `namespace`, its `joinMethods` and its limits.
4. Leader join messages: `codes.rotate` (reply `codes.updated`), `qr.issue`
   (reply `qr.ticket`), `join.approve` / `join.deny` (reply `join.decided`);
   events `join.requested`, `join.withdrawn`, `join.paused`, `join.resumed`
   and unsolicited `codes.updated` after door-code failures. A joiner can
   `join.cancel`. See [`docs/issues/10/architecture.md`](docs/issues/10/architecture.md)
   (section 4).
5. `group.resume` (`token`, plus `metadata`, `position`, `blockList` and the
   `joinCodes` blob from a leader) answers `group.resumed` (leader, with its
   codes and `codesChanged`), `group.joined` or `group.waiting`
   (member). `tokens.check` (up to 20 tokens) answers one status per token:
   `live`, `recoverable`, `waiting`, `blocked`, `ended`, `expired` or
   `invalid`. `group.end`, `group.leave` and `blocklist.set` (leader) complete
   the set. See [`docs/issues/5/architecture.md`](docs/issues/5/architecture.md)
   (section 4).
6. `group.ended` reasons: `ended_by_leader`, `leader_timeout`, `max_session`,
   `inactivity`, `replaced` (the same participant resumed on another
   connection) and `removed` (blocked; the socket then closes with 4004).
   Close code `1001` means the server is going away **or temporarily
   unavailable** (its storage is unreachable): resume later.
7. Roles and lifecycle (#13): leader requests `vice.set`, `vice.clear`
   (reply `vice.updated`), `group.lock`, `group.unlock` (reply
   `lock.changed`), `member.remove` (reply `member.removed`, then
   `codes.updated`), `leader.activity`, `keepalive.ack` (reply
   `activity.ack`); `leader.takeBack` (reply `leader.granted`). Events:
   `roster.snapshot`, `roster.updated`, `roster.removed`, `vice.changed`,
   `keepalive.prompt`, `keepalive.cleared`, `leader.granted`, `leader.lost`,
   `leader.changed`, `takeback.offered`; `leader.offline` carries `cause`
   and `graceMs`. `hello.ok` adds the lifecycle timers and
   `defaultHandoff`. Tokens are format 2 (`term`). See
   [`docs/issues/13/architecture.md`](docs/issues/13/architecture.md)
   (section 5).

Errors carry a stable `code` (`CODE_NOT_FOUND`, `DOOR_CODE_REQUIRED`,
`DOOR_CODE_WRONG`, `JOIN_PAUSED`, `JOIN_DENIED`, `APPROVAL_TIMEOUT`,
`APPROVAL_QUEUE_FULL`, `QR_INVALID`, `QR_EXPIRED`, `GROUP_FULL`, `NOT_LEADER`,
`RATE_LIMITED`, `MESSAGE_TOO_LARGE`, `TOO_MANY_MESSAGES`, `TOKEN_INVALID`,
`TOKEN_EXPIRED`, `GROUP_ENDED`, `PARTICIPANT_BLOCKED`, `LEADER_CANNOT_LEAVE`,
`GROUP_LOCKED`, `NOT_ALLOWED`, `PARTICIPANT_NOT_FOUND`, `BLOCK_LIST_FULL`,
`APP_GROUP_LIMIT`, ...). Every token failure gets the same `TOKEN_INVALID`, every unknown code
the same `CODE_NOT_FOUND` and every bad ticket the same `QR_INVALID`, so
errors reveal nothing about other groups or apps. A connection that floods messages gets
`TOO_MANY_MESSAGES` and close 4008, even if it is the leader (which freezes its
group).

## Reading app

A JSON-driven reading app with right-to-left, left-to-right and mixed-direction
text, a content fingerprint, and groups: start one, join by code or QR, follow
the leader's page (#24). Full documentation:
[`apps/reader/README.md`](apps/reader/README.md), groups in its
[Groups](apps/reader/README.md#groups) section.

```sh
pnpm --filter @mosherw/sync-system-reader dev           # http://localhost:5173
docker compose up --build                       # reader and sync server, http://127.0.0.1:8081
```

The `reader` service in `compose.yaml` builds `apps/reader/Dockerfile`, binds
port 8081 to `127.0.0.1` only, runs read-only as a non-root user, and sets
every `READER_*` variable to its default (the library is the entry page and
`?src` links are disabled), except the sync settings, which wire it to the
`sync-server` service with the public dev key. A bad value makes the container exit 1 with
`Config error: ...`. Serve it over HTTPS beyond `localhost`: the fingerprint
needs Web Crypto, which browsers offer only in secure contexts.

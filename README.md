# Sync System

Group Reading Sync: a sync service that lets an ad-hoc group follow one
leader's position in real time, and (later) a reading app that is its first
customer. The server syncs a **position, not a page**: it stores and relays an
opaque payload and never reads it.

## Workspace

A pnpm workspace (Node 24, pnpm 10, TypeScript, ESM).

| Package                 | Path                | What                                           |
| ----------------------- | ------------------- | ---------------------------------------------- |
| `@sync-system/protocol` | `packages/protocol` | Wire protocol: versions, error codes, schemas. |
| `@sync-system/server`   | `apps/sync-server`  | The sync server (HTTP `/health` + WebSocket).  |
| `@sync-system/client`   | `packages/client`   | Framework-free client for browsers and Node.   |

`packages/*` holds libraries and `apps/*` holds deployables.

The client's usage, API, events, error codes, connection states and
reconnect behavior are documented in
[`packages/client/README.md`](packages/client/README.md).

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

### Run locally

```sh
pnpm install
cp config/apps.example.json config/apps.json   # then put real keys in it
TOKEN_SECRET="$(openssl rand -base64 32)" \
  SYNC_CONFIG_PATH="$PWD/config/apps.json" pnpm --filter @sync-system/server dev
```

The `dev` script (tsx watch) runs in `apps/sync-server`, and
`SYNC_CONFIG_PATH` is resolved relative to the working directory, so pass an
absolute path as above. For a quick start with the public dev key, run
`NODE_ENV=development SYNC_CONFIG_PATH="$PWD/config/apps.dev.json" pnpm --filter @sync-system/server dev`
instead: the dev key is refused unless `NODE_ENV` is exactly `development`
or `test`. In those two environments `TOKEN_SECRET` may be left unset: the
server then uses a random secret per process and warns that tokens will not
survive a restart (see [Token secret](#token-secret)).

Production build: `pnpm build`, then from the repo root
`node apps/sync-server/dist/index.js` (which reads `./config/apps.json` by
default).

- WebSocket endpoint: `ws://localhost:8080/ws`
- Health: `GET http://localhost:8080/health` returns
  `{"status":"ok","protocolVersion":1,"minProtocolVersion":1}` and nothing else.
  Every other path is a 404.

### Run with Docker Compose

```sh
docker compose up --build
docker compose ps                     # STATUS shows (healthy)
curl http://127.0.0.1:8080/health
```

`compose.yaml` builds `apps/sync-server/Dockerfile`, mounts
`config/apps.dev.json` read-only at `/config/apps.json`, sets every ceiling and
cap to its default, health-checks `/health`, and binds the port to `127.0.0.1`
only. It sets `NODE_ENV=development`, because the dev registry uses a public
API key: the log shows a `dev api key in use` warning. With any other
`NODE_ENV` (the image default is `production`) the server refuses that key
and exits 1. Compose also sets the public development token secret
(`dev-only-insecure-token-secret-change-me-please`, logged as
`dev_token_secret`), so tokens survive `docker compose restart` and restart
recovery can be tried locally. It is refused outside `development`/`test`.

To run the image yourself, mount your own registry and point
`SYNC_CONFIG_PATH` at it. The image never contains a config file:

```sh
docker build -f apps/sync-server/Dockerfile -t sync-server .
docker run -p 127.0.0.1:8080:8080 \
  -v "$PWD/config/apps.json:/config/apps.json:ro" \
  -e SYNC_CONFIG_PATH=/config/apps.json \
  -e TOKEN_SECRET="$(cat /run/secrets/sync_token_secret)" sync-server
```

### Config file (registered client apps)

The server loads its client apps from a JSON file at `SYNC_CONFIG_PATH`.
`config/apps.example.json` is a documented example; real registries
(`config/*.json` other than the two committed examples) are git-ignored.

```json
{
  "apps": [
    {
      "namespace": "reading-app",
      "apiKey": "<output of: openssl rand -base64 32>",
      "minAppVersion": "1.0.0",
      "maxGroupSize": 30,
      "maxLeaderUpdatesPerSecond": 5,
      "maxMessageBytes": 4096,
      "maxConnections": 1000,
      "maxSessionMinutes": 180,
      "inactivityLimitMinutes": 20
    }
  ]
}
```

| Field                       | Required | Default | Rule                                                        |
| --------------------------- | -------- | ------- | ----------------------------------------------------------- |
| `namespace`                 | yes      |         | `^[a-z0-9][a-z0-9_-]{0,62}$`, unique.                       |
| `apiKey`                    | yes      |         | 32-256 characters, unique. Stored only as a sha256 hash.    |
| `minAppVersion`             | yes      |         | Valid semver. Older clients get `APP_VERSION_TOO_OLD`.      |
| `maxGroupSize`              | no       | 30      | Integer >= 2, <= `MAX_GROUP_SIZE_CEILING`. Leader counts.   |
| `maxLeaderUpdatesPerSecond` | no       | 5       | Integer >= 1, <= `MAX_LEADER_UPDATE_RATE_CEILING`.          |
| `maxMessageBytes`           | no       | 4096    | Integer >= 1, <= `MAX_MESSAGE_SIZE_CEILING`. Per field.     |
| `maxConnections`            | no       | 1000    | Integer >= 1, <= `MAX_APP_CONNECTIONS_CEILING`.             |
| `maxSessionMinutes`         | no       | 180     | Integer >= 1, <= `MAX_SESSION_MINUTES_CEILING`. Group life. |
| `inactivityLimitMinutes`    | no       | 20      | Integer >= 1, <= `INACTIVITY_LIMIT_MINUTES_CEILING`.        |

- Unknown fields are rejected (catches typos).
- A value above its env ceiling is a startup error naming the app and field;
  values are never clamped. An omitted value uses `min(default, ceiling)`.
- Any invalid config makes the server print `Config error: ...` and exit 1.
  Errors name the file, app index, namespace and field, and never print an API
  key (JSON syntax errors report only the line and column).

Generate keys with:

```sh
openssl rand -base64 32
```

An API key identifies an app and selects its limits. In a browser app anyone
can read it, so it is **not** access control: group IDs (256 random bits) are
what keeps groups apart in this version.

### Environment variables

Numeric variables must be positive integers; anything else (empty, `0`, `-1`,
`1.5`, `abc`) is a startup error naming the variable. Unset means the default.

| Variable                           | Default              | Purpose                                                                  |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `SYNC_CONFIG_PATH`                 | `./config/apps.json` | Apps registry file (relative to the working directory).                  |
| `PORT`                             | `8080`               | Listen port, 1-65535.                                                    |
| `HOST`                             | `0.0.0.0`            | Bind address.                                                            |
| `LOG_LEVEL`                        | `info`               | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.          |
| `NODE_ENV`                         | unset                | The public dev API key is refused unless this is `development`/`test`.   |
| `TOKEN_SECRET`                     | none                 | Token signing secret; see [Token secret](#token-secret). Never logged.   |
| `TOKEN_SECRET_PREVIOUS`            | unset                | Old secret, verify only, during a rotation.                              |
| `MAX_GROUP_SIZE_CEILING`           | `100`                | Ceiling for `maxGroupSize`.                                              |
| `MAX_LEADER_UPDATE_RATE_CEILING`   | `10`                 | Ceiling for `maxLeaderUpdatesPerSecond`.                                 |
| `MAX_MESSAGE_SIZE_CEILING`         | `16384`              | Ceiling for `maxMessageBytes` (bytes).                                   |
| `MAX_APP_CONNECTIONS_CEILING`      | `10000`              | Ceiling for `maxConnections`. Must be <= `MAX_CONNECTIONS`.              |
| `MAX_CONNECTIONS`                  | `10000`              | Concurrent WebSockets, pending and authenticated. Over it: HTTP 503.     |
| `MAX_PENDING_HANDSHAKES`           | `1000`               | Sockets that have not sent hello yet. Must be <= `MAX_CONNECTIONS`.      |
| `MAX_INBOUND_MESSAGES_PER_SECOND`  | `20`                 | Per-connection message rate. Must be > `MAX_LEADER_UPDATE_RATE_CEILING`. |
| `MAX_INBOUND_BURST`                | `40`                 | Per-connection burst. Must be >= `MAX_INBOUND_MESSAGES_PER_SECOND`.      |
| `MAX_BUFFERED_BYTES`               | `262144`             | Outbound buffer per socket before drop. >= 4 x msg ceiling and >= 45056. |
| `MAX_SESSION_MINUTES_CEILING`      | `480`                | Ceiling for `maxSessionMinutes`.                                         |
| `INACTIVITY_LIMIT_MINUTES_CEILING` | `60`                 | Ceiling for `inactivityLimitMinutes`.                                    |
| `TOKEN_REFRESH_ACTIVITIES`         | `10`                 | Leader updates that allow a token refresh after the min interval.        |
| `TOKEN_REFRESH_MIN_SECONDS`        | `60`                 | Min seconds between leader token refreshes. <= the max.                  |
| `TOKEN_REFRESH_MAX_SECONDS`        | `300`                | Max seconds between refreshes (<= 3600); also the recovery slack.        |

Fixed limits: hello within 5 s, at most 32 queued messages per connection, JSON
nesting at most 64 levels, heartbeat ping every 30 s, HTTP header timeout 10 s
and request timeout 15 s. Tokens: 365 days `exp`, at most 2048 characters, 20
per `tokens.check`, 10 checks per connection per minute, block lists of at
most 256 IDs, ended groups remembered for at most 100 000 groups.

Memory sizing: outbound buffers alone can reach
`MAX_CONNECTIONS x MAX_BUFFERED_BYTES` (10000 x 256 KiB, about 2.5 GiB at the
defaults), and one app's clients up to its `maxConnections x MAX_BUFFERED_BYTES`
(1000 x 256 KiB, about 250 MiB at the default). Give the process (and its
container memory limit) at least that much headroom, or lower `MAX_CONNECTIONS`
or `MAX_BUFFERED_BYTES` to fit the machine.

Inbound frames: the transport limit is
`max(2 x MAX_MESSAGE_SIZE_CEILING + 8192 + 16384, 45056)` bytes (57 344 at the
defaults; a recreation request carries metadata, a position, a token and a
block list). With 32 queued messages per connection, the worst case is about
32 x 57 KiB per socket; size the machine for it at your `MAX_CONNECTIONS`.

### Token secret

Every participant gets a signed token (HS256 JWT) per group. Each app gets its
own signing key, derived from `TOKEN_SECRET` with HKDF, so one app's tokens
are useless on another. Generate the secret with:

```sh
openssl rand -base64 32
```

Rules, checked at startup (`Config error: ...`, exit 1, the value is never
printed):

- `TOKEN_SECRET` is **required** unless `NODE_ENV` is exactly `development`
  or `test` (an unset `NODE_ENV` counts as production). There, a missing
  secret means a random secret per process and the warning
  `token_secret_random`: tokens do not survive a restart.
- In every environment a set secret must be at least 32 bytes, have at least
  16 different byte values, must not start or end with whitespace (nothing is
  trimmed), and must not be an example value from these docs
  (`REPLACE-with-output-of-openssl-rand-base64-32`).
- The public development secret is accepted only in `development` and `test`.
- `TOKEN_SECRET_PREVIOUS` follows the same rules and must differ from
  `TOKEN_SECRET`. While it is set, the log shows `token_secret_previous_set`
  at startup, so it is not forgotten.
- Keep the secret out of git, images and logs; inject it from your secret store.
  Every instance of one deployment must use the same secret. Keep server clocks
  in sync (NTP): token times are server times, with 5 minutes of tolerance.

**Routine rotation** (no downtime, nobody logged out):

1. Set the new secret as `TOKEN_SECRET` and the old one as
   `TOKEN_SECRET_PREVIOUS`, and restart. Old tokens still verify, and every
   check, resume or refresh hands back a token signed with the new secret.
2. After `MAX_SESSION_MINUTES_CEILING` + `TOKEN_REFRESH_MAX_SECONDS` (8 h 5 min
   by default) remove `TOKEN_SECRET_PREVIOUS` and restart. Every old token is
   expired by then anyway.

**After a leak** (compromise): replace `TOKEN_SECRET` with a new value and
do **not** set the leaked one as `TOKEN_SECRET_PREVIOUS`. Otherwise tokens
forged with the leaked secret would be re-signed with the new one. All tokens
become invalid; clients delete them and groups must be created again. That is
the price of a leak.

Changing the HKDF label or salt in the code has the same effect as a new
secret.

### Recovery and tokens

The server still keeps nothing on disk; the leader's client is the group's
database.

- A leader disconnect **freezes** the group: members get `leader.offline` and
  stay in it. The leader comes back with `group.resume` and its token (members
  get `leader.online`; the server's position wins). A frozen group ends with
  `leader_timeout` when `inactivityLimitMinutes` + `TOKEN_REFRESH_MAX_SECONDS`
  have passed since the leader's last activity.
- Every group ends with `max_session` at `maxSessionMinutes` after it was
  created, leader online or not.
- A group nobody is connected to is dropped from memory (not ended). After a
  restart, or later ("resume later"), the leader's `group.resume` with its
  token **recreates** it with the same ID, creation time and leader, plus the
  metadata, position and block list its client sends. Members that resumed
  first wait (`group.waiting`) and are admitted automatically.
- The leader can `group.end` the group; a member can `group.leave`. Ended
  groups are remembered (as hashes) until their max-session deadline, so their
  tokens get `GROUP_ENDED`; a restart forgets that (accepted: the leader's
  client deletes its token on end).
- Leader tokens are refreshed (`token.refreshed`) after activity; member
  tokens are not.
- The block list binds token identities only. Until join codes (item 4), a
  blocked person can still join again **by group ID** with a new identity.

### Protocol (v1) in brief

Plain WebSocket, one JSON object per text frame. The full protocol is in
[`docs/issues/1/architecture.md`](docs/issues/1/architecture.md) (section 5)
and the types are exported by `@sync-system/protocol`.

1. Server sends `welcome` with `protocolVersion` and `minProtocolVersion`.
2. Client sends `hello` with `protocolVersion`, `appVersion` (semver) and
   `apiKey`; the server answers `hello.ok` (with the app's limits) or an
   `error` and closes (4001; 4003 when the app is at `maxConnections`; 4002 if
   no hello arrives within 5 s).
3. `group.create` (`metadata`, optional `position`) makes the sender leader;
   `group.join` (`groupId`) returns the metadata and current position (or
   `hasPosition: false`); `position.update` from the leader is relayed to every
   member as `position.updated`. `group.created` and `group.joined` carry the
   participant's token; `hello.ok` carries the app `namespace` and
   `limits.maxSessionMinutes`.
4. `group.resume` (`token`, plus `metadata`, `position` and `blockList` from a
   leader) answers `group.resumed` (leader), `group.joined` or `group.waiting`
   (member). `tokens.check` (up to 20 tokens) answers one status per token:
   `live`, `recoverable`, `waiting`, `blocked`, `ended`, `expired` or
   `invalid`. `group.end`, `group.leave` and `blocklist.set` (leader) complete
   the set. See [`docs/issues/5/architecture.md`](docs/issues/5/architecture.md)
   (section 4).
5. `group.ended` reasons: `ended_by_leader`, `leader_timeout`, `max_session`,
   `replaced` (the same participant resumed on another connection) and
   `removed` (blocked).

Errors carry a stable `code` (`GROUP_NOT_FOUND`, `GROUP_FULL`, `NOT_LEADER`,
`RATE_LIMITED`, `MESSAGE_TOO_LARGE`, `TOO_MANY_MESSAGES`, `TOKEN_INVALID`,
`TOKEN_EXPIRED`, `GROUP_ENDED`, `PARTICIPANT_BLOCKED`, `LEADER_CANNOT_LEAVE`,
...). Every token failure gets the same `TOKEN_INVALID`, so errors reveal
nothing about other groups. A connection that floods messages gets
`TOO_MANY_MESSAGES` and close 4008, even if it is the leader (which freezes its
group).

### Deployment security

- **Use TLS.** Any deployment beyond your own machine must sit behind TLS
  termination so clients connect with `wss://`. Without it the API key, group
  IDs (which are join capabilities) and reading positions travel in cleartext.
- **Use a reverse proxy** for TLS and for **per-IP connection and request
  limits**. The server caps global, pending and per-app connections, but it
  deliberately does not look at client IPs (behind a proxy they are the
  proxy's, and IPs stay out of the app and its logs).
- **Logs** never contain client IPs, display names, API keys, positions,
  metadata, tokens, participant IDs, block lists, secrets or raw group IDs
  (groups appear as a hash prefix). Keep it that way at the proxy too, or keep
  proxy logs short-lived.
- **Tokens are bearer credentials.** Whoever holds a leader token can take the
  lead back until the group ends. `wss://` keeps them off the wire; the
  client README covers storing them.
- **Never commit real registries or `.env` files**; mount the registry at
  runtime.

Minimal nginx example:

```nginx
limit_conn_zone $binary_remote_addr zone=perip:10m;

server {
  listen 443 ssl;
  server_name sync.example.com;
  ssl_certificate     /etc/ssl/sync.crt;
  ssl_certificate_key /etc/ssl/sync.key;
  access_log off;

  location /ws {
    limit_conn perip 20;
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
  }

  location = /health {
    proxy_pass http://127.0.0.1:8080;
  }
}
```

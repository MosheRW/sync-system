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

`packages/*` holds libraries and `apps/*` holds deployables.

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
SYNC_CONFIG_PATH="$PWD/config/apps.json" pnpm --filter @sync-system/server dev
```

The `dev` script (tsx watch) runs in `apps/sync-server`, and
`SYNC_CONFIG_PATH` is resolved relative to the working directory, so pass an
absolute path as above. For a quick start with the public dev key, use
`SYNC_CONFIG_PATH="$PWD/config/apps.dev.json"` instead.

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
API key: the log shows a `dev api key in use` warning. With
`NODE_ENV=production` (the image default) the server refuses that key and
exits 1.

To run the image yourself, mount your own registry and point
`SYNC_CONFIG_PATH` at it. The image never contains a config file:

```sh
docker build -f apps/sync-server/Dockerfile -t sync-server .
docker run -p 127.0.0.1:8080:8080 \
  -v "$PWD/config/apps.json:/config/apps.json:ro" \
  -e SYNC_CONFIG_PATH=/config/apps.json sync-server
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
      "maxConnections": 1000
    }
  ]
}
```

| Field                       | Required | Default | Rule                                                      |
| --------------------------- | -------- | ------- | --------------------------------------------------------- |
| `namespace`                 | yes      |         | `^[a-z0-9][a-z0-9_-]{0,62}$`, unique.                     |
| `apiKey`                    | yes      |         | 32-256 characters, unique. Stored only as a sha256 hash.  |
| `minAppVersion`             | yes      |         | Valid semver. Older clients get `APP_VERSION_TOO_OLD`.    |
| `maxGroupSize`              | no       | 30      | Integer >= 2, <= `MAX_GROUP_SIZE_CEILING`. Leader counts. |
| `maxLeaderUpdatesPerSecond` | no       | 5       | Integer >= 1, <= `MAX_LEADER_UPDATE_RATE_CEILING`.        |
| `maxMessageBytes`           | no       | 4096    | Integer >= 1, <= `MAX_MESSAGE_SIZE_CEILING`. Per field.   |
| `maxConnections`            | no       | 1000    | Integer >= 1, <= `MAX_APP_CONNECTIONS_CEILING`.           |

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

| Variable                          | Default              | Purpose                                                                  |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `SYNC_CONFIG_PATH`                | `./config/apps.json` | Apps registry file (relative to the working directory).                  |
| `PORT`                            | `8080`               | Listen port, 1-65535.                                                    |
| `HOST`                            | `0.0.0.0`            | Bind address.                                                            |
| `LOG_LEVEL`                       | `info`               | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.          |
| `NODE_ENV`                        | unset                | `production` refuses the public dev API key.                             |
| `MAX_GROUP_SIZE_CEILING`          | `100`                | Ceiling for `maxGroupSize`.                                              |
| `MAX_LEADER_UPDATE_RATE_CEILING`  | `10`                 | Ceiling for `maxLeaderUpdatesPerSecond`.                                 |
| `MAX_MESSAGE_SIZE_CEILING`        | `16384`              | Ceiling for `maxMessageBytes` (bytes).                                   |
| `MAX_APP_CONNECTIONS_CEILING`     | `10000`              | Ceiling for `maxConnections`. Must be <= `MAX_CONNECTIONS`.              |
| `MAX_CONNECTIONS`                 | `10000`              | Concurrent WebSockets, pending and authenticated. Over it: HTTP 503.     |
| `MAX_PENDING_HANDSHAKES`          | `1000`               | Sockets that have not sent hello yet. Must be <= `MAX_CONNECTIONS`.      |
| `MAX_INBOUND_MESSAGES_PER_SECOND` | `20`                 | Per-connection message rate. Must be > `MAX_LEADER_UPDATE_RATE_CEILING`. |
| `MAX_INBOUND_BURST`               | `40`                 | Per-connection burst. Must be >= `MAX_INBOUND_MESSAGES_PER_SECOND`.      |
| `MAX_BUFFERED_BYTES`              | `262144`             | Per-socket outbound buffer before it is dropped. >= 4 x message ceiling. |

Fixed limits: hello within 5 s, at most 32 queued messages per connection, JSON
nesting at most 64 levels, heartbeat ping every 30 s, HTTP header timeout 10 s
and request timeout 15 s.

Memory sizing: outbound buffers alone can reach
`MAX_CONNECTIONS x MAX_BUFFERED_BYTES` (10000 x 256 KiB, about 2.5 GiB at the
defaults), and one app's clients up to its `maxConnections x MAX_BUFFERED_BYTES`
(1000 x 256 KiB, about 250 MiB at the default). Give the process (and its
container memory limit) at least that much headroom, or lower `MAX_CONNECTIONS`
or `MAX_BUFFERED_BYTES` to fit the machine.

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
   member as `position.updated`.
4. When the leader disconnects, members get `group.ended` and the group is gone.
   Groups live in memory only: a restart forgets them.

Errors carry a stable `code` (`GROUP_NOT_FOUND`, `GROUP_FULL`, `NOT_LEADER`,
`RATE_LIMITED`, `MESSAGE_TOO_LARGE`, `TOO_MANY_MESSAGES`, ...). A connection
that floods messages gets `TOO_MANY_MESSAGES` and close 4008, even if it is the
leader (which ends its group).

### Deployment security

- **Use TLS.** Any deployment beyond your own machine must sit behind TLS
  termination so clients connect with `wss://`. Without it the API key, group
  IDs (which are join capabilities) and reading positions travel in cleartext.
- **Use a reverse proxy** for TLS and for **per-IP connection and request
  limits**. The server caps global, pending and per-app connections, but it
  deliberately does not look at client IPs (behind a proxy they are the
  proxy's, and IPs stay out of the app and its logs).
- **Logs** never contain client IPs, display names, API keys, positions,
  metadata or raw group IDs (groups appear as a hash prefix). Keep it that way
  at the proxy too, or keep proxy logs short-lived.
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

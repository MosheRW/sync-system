# Architecture: #1 Sync server core and monorepo scaffold

Issue: https://github.com/MosheRW/sync-system/issues/1
Spec: [`spec.md`](./spec.md) (28 ACs) | Security review: [`security.md`](./security.md)
Path: full | Designer: skipped (no UI)
Status: **revised for security review (rev 2); awaiting user approval (Gate 2)**

Revision 2 adds every finding from `security.md` (H1-H4, M1-M6, L1-L8). The
mapping is in section 10, "Security controls".

## 1. Approach

A TypeScript monorepo on pnpm workspaces (ESM, Node 24 LTS, pnpm 10). This
issue adds two packages:

| Package | Path | Role |
| --- | --- | --- |
| `@sync-system/protocol` | `packages/protocol` | Works in Node and the browser, no framework. Holds protocol version constants, error codes, close codes, message types, zod schemas and the iterative JSON depth guard. The server uses it now; the core client (#2), React package (#6) and reading app (#7-8) use it later. |
| `@sync-system/server` | `apps/sync-server` | Node sync server: config loading, HTTP `/health`, WebSocket endpoint, connection caps, handshake, groups, limits, logging. Deployable (Dockerfile). |

Layout rule for later issues: `packages/*` holds publishable libraries
(`packages/client` in #2, `packages/react` in #6) and `apps/*` holds deployables
(`apps/reading-app` in #7). `pnpm-workspace.yaml` covers both globs from day one.

The server is split into layers so later issues extend it instead of rewriting it:

```
transport (http + ws upgrade, connection caps, error guards)
  -> connection (state machine, inbound limiter, bounded serial queue)
  -> GroupService (business rules, limits)
  -> GroupStore (interface; InMemoryGroupStore now, Redis in #9)
  -> Notifier (interface; local fan-out with backpressure now, pub/sub in #9)
```

- `GroupStore` is **async** and its operations are **atomic**. For example,
  `addParticipant(..., maxSize)` returns `ok | not_found | full`. A Redis
  implementation (#9) can then slot in with the same semantics.
- Groups are keyed internally by `namespace + groupId`. A cross-app lookup is
  impossible by construction (AC18), not just filtered out.
- In #1 a connection holds at most one group. Roles are the string union
  `leader | member`, so #5 can add `vice-leader`.
- The position payload and the metadata are stored exactly as `JSON.parse`
  returned them. The server checks them with an iterative type-and-depth walk
  and never rebuilds them through a schema (M4, L6). It re-serializes them on
  relay and never reads their fields.

### WebSocket library: `ws` (Socket.IO rejected)

- **Plain WebSocket on the wire.** The core client (#2) can use the browser's
  native `WebSocket` with no runtime dependency. Socket.IO would force its own
  client library and Engine.IO framing on every app that integrates.
- **We own the protocol anyway.** The versioned handshake, explicit error codes
  and token-based reconnect (#3) are ours. Socket.IO's auto-reconnect, rooms and
  acks would duplicate or fight them. Rooms would also make "list groups" easy to
  reach, which AC20 forbids.
- **Transport controls.** `ws` provides `maxPayload`, `bufferedAmount` (outbound
  backpressure), `perMessageDeflate: false`, and ping/pong for dead-peer
  detection.
- Socket.IO's main advantage, the Redis adapter for multi-instance, is deferred
  to #9. Our `Notifier` plus Redis pub/sub can replace it.

### Other choices

- **HTTP:** Node `http.createServer`, no Express or Fastify. One route,
  `GET /health`. The WebSocket upgrade uses
  `new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false })`
  on path `/ws` only. Connection caps are checked before `handleUpgrade`.
- **Validation:** `zod` (v4) for env, the config file and every inbound message
  envelope. Message schemas are shallow: `position` and `metadata` are
  `z.unknown()`, so the parsed value passes through by reference. Our own code
  formats the errors (paths and expectations only, never received values), so API
  keys never appear in errors.
- **Semver:** `semver@^7.7` (`valid`, `lt`). Inputs are length-bounded first.
- **Logging:** `pino` with an injectable destination stream (for the AC24 test).
  `redact` is a second line of defense. Group IDs are logged only as `groupRef`
  (the first 12 hex chars of sha256(groupId)).
- **Tests:** Vitest in each package. Integration tests start a real server on
  port 0 and connect with a `ws` client. A raw TCP client helper crafts malformed
  frames. Time is injected (`now: () => number`) so the rate limiters can be
  tested without fake timers interfering with socket I/O.
- **Lint/format:** ESLint 9 flat config + `typescript-eslint` + Prettier.
  `pnpm lint` also runs `prettier --check`.

### Workspace-internal imports without a build step

The `exports` field of `@sync-system/protocol` uses a custom condition:

```json
".": { "@sync-system/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
```

How it is wired:
- `tsconfig.base.json` sets `customConditions: ["@sync-system/source"]`, and the
  Vitest `resolve.conditions` setting uses the same name. Typecheck and tests
  therefore read the protocol sources directly.
- Each package's `tsconfig.build.json` sets `customConditions: []` and sets
  `rootDir`/`outDir`, so builds resolve the built `dist`. `pnpm -r build` builds
  protocol first because it runs in dependency order.
- At runtime Node takes the `default` entry, which is `dist`.

Fallback if this misbehaves: make `typecheck` and `test` depend on
`pnpm --filter @sync-system/protocol build`, and record it as a deviation.

### Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Socket.IO | See above. |
| Express/Fastify | There is only one route; not worth the dependency. |
| API key in the WS URL query string | It ends up in proxy and access logs. The key goes in the first message instead. |
| Synchronous store | Simpler now, but a Redis store (#9) would force a change at every call site. |
| Logging the raw group ID | In #1 the group ID is enough to join; logs must not grant access. |
| Recursive zod JSON schema for payloads | Deep nesting overflows the stack, and the rebuild can lose `__proto__` keys (M4, L6). |
| Per-IP limits in the app | Behind a proxy the IP belongs to the proxy, and IPs must stay out of the app's logic and logs. Per-IP limits belong in the reverse proxy (README). |

## 2. Files to create

Root:

| Path | What |
| --- | --- |
| `package.json` | Private root. `packageManager: pnpm@10.28.0`, `engines.node >=24`. Scripts `lint`, `typecheck`, `test`, `build`, `format`, `audit` (`pnpm audit --audit-level=high`). Root devDeps: eslint, typescript-eslint, @eslint/js, eslint-config-prettier, prettier, typescript. |
| `pnpm-workspace.yaml` | `packages: [apps/*, packages/*]`. |
| `pnpm-lock.yaml` | Committed (AC28). |
| `tsconfig.base.json` | Strict. `module`/`moduleResolution: NodeNext`, `target: ES2023`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `customConditions`. |
| `eslint.config.js` | Flat config with type-aware rules for `apps/*` and `packages/*`. Ignores `dist` and `coverage`. Enables `@typescript-eslint/no-floating-promises` and `no-misused-promises` (H4). |
| `.prettierrc.json`, `.prettierignore` | `endOfLine: lf`. Ignore `pnpm-lock.yaml`, `dist`, `docs/PRD*`. |
| `.gitignore` | `node_modules`, `dist`, `coverage`, `.env*`, `*.log`, `config/*.json` with exceptions `!config/apps.example.json` and `!config/apps.dev.json` (M1). |
| `.nvmrc` | `24`. |
| `.editorconfig` | LF, 2 spaces. |
| `.dockerignore` | `node_modules`, `**/dist`, `.git`, `.github`, `.claude`, `docs`, `config/`, `.env*`, `**/*.log`, `coverage` (M1). |
| `compose.yaml` | `sync-server` service (section 7). |
| `config/apps.dev.json` | Dev registry with one obviously fake app (`namespace: "dev-app"`, key `dev-only-insecure-api-key-change-me-please`). Mounted by compose. Refused in production (M6). |
| `config/apps.example.json` | Documented example with two apps and placeholder keys. |
| `README.md` | Overview, workspace commands, "Sync server" section (AC26), including deployment security: TLS and a reverse proxy (M3, H1) and key generation (L7). |
| `.github/workflows/ci.yml` | CI (AC28, L1, L8). |

`packages/protocol`:

| Path | What |
| --- | --- |
| `package.json` | `@sync-system/protocol`, `type: module`, `exports` with the source condition, dep `zod`. Scripts `build`, `typecheck`, `test`. |
| `tsconfig.json` / `tsconfig.build.json` | Typecheck (src + test, noEmit) / build (src -> dist, with declarations). |
| `vitest.config.ts` | Uses the source condition. |
| `src/index.ts` | Public exports. |
| `src/version.ts` | `PROTOCOL_VERSION = 1`, `MIN_CLIENT_PROTOCOL_VERSION = 1`. |
| `src/errors.ts` | `ErrorCode` const object and type. |
| `src/close-codes.ts` | `CloseCode` const object (4001, 4002, 4003, 4008). |
| `src/json.ts` | `JsonValue`, `JsonObject` types. |
| `src/json-guard.ts` | `checkJson(value, { maxDepth })`: an iterative (explicit-stack) walk that checks JSON types and depth. Returns `ok \| too_deep \| invalid`. Never recurses and never copies. |
| `src/limits.ts` | `MAX_JSON_DEPTH = 64`, `GROUP_ID_PATTERN`, `MAX_API_KEY_LENGTH = 256`, `MAX_APP_VERSION_LENGTH = 64`, `MAX_REQ_ID_LENGTH = 64`, `MAX_GROUP_ID_INPUT_LENGTH = 256`. |
| `src/messages.ts` | TS discriminated unions `ClientMessage` and `ServerMessage`. |
| `src/schemas.ts` | Shallow zod schemas for every message, with length bounds (L2, L3). |
| `test/schemas.test.ts`, `test/json-guard.test.ts` | Parsing, bounds, depth 10,000, `__proto__` preserved by reference. |

`apps/sync-server`:

| Path | What |
| --- | --- |
| `package.json` | `@sync-system/server`. Deps: `@sync-system/protocol` (`workspace:*`), `ws@^8.18`, `pino`, `semver@^7.7`, `zod` (L1). DevDeps: `@types/ws`, `@types/semver`, `@types/node`, `tsx`, `vitest`, `typescript`. Scripts: `dev` (tsx watch), `start` (`node dist/index.js`), `build`, `typecheck`, `test`. |
| `tsconfig.json` / `tsconfig.build.json` / `vitest.config.ts` | Same setup as protocol. |
| `Dockerfile` | Multi-stage build (section 7). |
| `src/index.ts` | Process entry. Calls `run(process.env)`, sets the exit code, and wires SIGTERM/SIGINT to a graceful close. Has `process.on('unhandledRejection')` and `('uncaughtException')` handlers that log `err.name` only and exit 1. This is the last resort; the guards in section 5 must make it unreachable (H4). |
| `src/main.ts` | `run(env, io)`: parse env, load config, run the dev-key check, create the logger, start the server. On `ConfigError` it prints `Config error: <message>` to stderr and returns exit code 1. |
| `src/config/env.ts` | Parse and validate env variables (section 4). |
| `src/config/apps-config.ts` | `parseAppsConfig(text, env)` and `loadAppsConfigFile(path, env)`: safe JSON parse (M2), zod schema, defaults, ceilings, duplicates, semver. |
| `src/config/dev-key.ts` | `DEV_API_KEYS` (the key from `apps.dev.json`). `checkDevKeys(apps, nodeEnv, logger)`: in production this is a `ConfigError`, otherwise a `warn` that names only the namespace (M6). |
| `src/config/config-error.ts` | `ConfigError` with a human-readable message that never contains key values. |
| `src/apps/app-registry.ts` | `AppRegistry`: `findByApiKey(key)` uses a map keyed by sha256 of the key. Holds immutable `AppConfig` records. |
| `src/server.ts` | `createSyncServer({ env, registry, logger, now, store?, heartbeatMs?, handshakeTimeoutMs? })` returns `{ listen(port, host), close(), port, stats() }`. Sets the HTTP timeouts and wires the `upgrade` handler and error listeners (H1, H4). `stats()` is for tests only and is never exposed over HTTP. |
| `src/http/health.ts` | `GET /health` handler. 404 for everything else. |
| `src/ws/upgrade.ts` | Path check, global connection cap and pending-handshake cap before `handleUpgrade`. Writes `HTTP/1.1 503` or `404` and destroys the socket. Attaches `ws.on('error')` right away (H1, H4). |
| `src/ws/connection-counter.ts` | Counters: total, pending handshakes, per-app. Decremented exactly once on close. |
| `src/ws/connection.ts` | Per-connection state (`awaiting_hello` -> `ready`), handshake timeout, inbound limiter, bounded serial queue whose tail never rejects, dispatch, disconnect hook (H3, H4). |
| `src/ws/handshake.ts` | Hello validation: API key, protocol version, app version, per-app connection cap (M5). |
| `src/ws/send.ts` | Typed `send(ws, ServerMessage)`. A no-op unless `readyState === OPEN`. Terminates the socket if `bufferedAmount` exceeds `MAX_BUFFERED_BYTES` (H2, H4). Also `sendErrorAndClose`. |
| `src/ws/heartbeat.ts` | Pings every 30 s. A pong counts only while a ping is outstanding. Terminates sockets with no pong, or with a non-zero `bufferedAmount` that did not drop between two heartbeats (H2). |
| `src/ws/inbound-limiter.ts` | Token bucket per connection, injected clock (H3). |
| `src/groups/group-store.ts` | `GroupStore` interface and `GroupRecord` types. |
| `src/groups/in-memory-group-store.ts` | Map-based implementation. |
| `src/groups/group-service.ts` | Rules for create, join, update and disconnect; limits; notifications. |
| `src/groups/notifier.ts` | `Notifier` interface and `LocalNotifier` (participantId -> connection, via `send()`). |
| `src/groups/ids.ts` | `newGroupId()` (32 bytes from `crypto.randomBytes`, base64url, 43 chars) and `newParticipantId()` (`crypto.randomUUID`). |
| `src/limits/rate-limiter.ts` | Sliding-window leader update limiter keyed by group, injected clock. |
| `src/limits/json-size.ts` | `jsonByteLength(value)`: UTF-8 bytes of `JSON.stringify(value)`. Called only after `checkJson` passes. |
| `src/logging/logger.ts` | pino factory (`level`, `destination`), redact paths, `groupRef()`, `safeErr(err)` (name + stack frames, no message line) (L5). |
| `test/helpers/test-server.ts` | Starts the server on port 0 with an in-test registry, captured log stream, controllable clock and small caps. |
| `test/helpers/test-client.ts` | `ws` client wrapper: `hello()`, `send()`, `next(type)`, `expectNoMessage(ms)`, `closed()` (returns code and reason). |
| `test/helpers/raw-client.ts` | Raw `net` socket. Does the HTTP upgrade by hand and writes hand-built frames: masked/unmasked, RSV bits, invalid UTF-8, bad close code, oversized length header. Can `pause()` reading (H2, H4). |
| `test/*.test.ts` | See the test plan (section 9). |

The repo currently contains only `docs/` and `.claude/`. No other files are
modified.

## 3. Data model (in memory, no database, no migrations)

```ts
// apps
interface AppConfig {
  namespace: string;           // ^[a-z0-9][a-z0-9_-]{0,62}$
  apiKeyHash: string;          // sha256 hex; the raw key is not kept after load
  minAppVersion: string;       // valid semver
  maxGroupSize: number;        // effective value, <= ceiling
  maxLeaderUpdatesPerSecond: number;
  maxMessageBytes: number;
  maxConnections: number;      // per-app concurrent sockets, <= ceiling (M5)
}

// groups
type Role = 'leader' | 'member';
type StoredPosition = { has: false } | { has: true; payload: JsonValue };

interface GroupRecord {
  id: string;                  // 43-char base64url, 256 bits
  appNamespace: string;
  metadata: JsonObject;        // opaque, stored as parsed
  position: StoredPosition;    // opaque payload, stored as parsed
  leaderId: string;            // participant ID
  participantIds: string[];    // includes the leader
  createdAt: number;           // epoch ms (used by #5 for max session time)
}

interface GroupStore {
  create(group: GroupRecord): Promise<void>;
  get(ns: string, id: string): Promise<GroupRecord | undefined>;
  addParticipant(ns: string, id: string, pid: string, maxSize: number): Promise<'ok' | 'not_found' | 'full'>;
  removeParticipant(ns: string, id: string, pid: string): Promise<{ remaining: number } | undefined>;
  setPosition(ns: string, id: string, payload: JsonValue): Promise<boolean>;
  delete(ns: string, id: string): Promise<void>;
}
```

- The store has no `list` method (AC20).
- `get` returns a shallow copy of the record and `participantIds`. The opaque
  values are never mutated, so they are shared by reference and not deep-cloned.
  This avoids copying and avoids recursion.
- A restart means a new, empty store (AC16).
- Group count is bounded by connections: every group has at least one live
  participant, and connections are capped (H1, M5).

Connection state is local only and never goes in the store: `participantId`,
`app`, `state`, `groupId?`, `role?`, limiter bucket, queue length,
`awaitingPong`, `lastBufferedAmount`.

## 4. Configuration

### Env variables

Every numeric variable must be a **positive integer**. An empty, non-numeric,
zero, negative or fractional value is a startup error that names the variable
(AC6). Unset means the default.

| Variable | Default | Rule / purpose |
| --- | --- | --- |
| `SYNC_CONFIG_PATH` | `./config/apps.json` (relative to cwd) | Path to the apps JSON file. |
| `PORT` | `8080` | 1-65535. |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | pino level (`fatal`..`trace`, `silent`). |
| `NODE_ENV` | unset | `production` makes the dev API key a startup error (M6). |
| `MAX_GROUP_SIZE_CEILING` | `100` | Ceiling for app `maxGroupSize`. |
| `MAX_LEADER_UPDATE_RATE_CEILING` | `10` | Ceiling for app `maxLeaderUpdatesPerSecond`. |
| `MAX_MESSAGE_SIZE_CEILING` | `16384` | Ceiling for app `maxMessageBytes` (bytes). |
| `MAX_APP_CONNECTIONS_CEILING` | `10000` | Ceiling for app `maxConnections` (M5). Must be <= `MAX_CONNECTIONS`. |
| `MAX_CONNECTIONS` | `10000` | Global concurrent WebSocket cap, pending and authenticated combined (H1). |
| `MAX_PENDING_HANDSHAKES` | `1000` | Concurrent sockets still in `awaiting_hello` (H1). Must be <= `MAX_CONNECTIONS`. |
| `MAX_INBOUND_MESSAGES_PER_SECOND` | `20` | Per-connection token-bucket refill rate for all message types (H3). Must be > `MAX_LEADER_UPDATE_RATE_CEILING`. |
| `MAX_INBOUND_BURST` | `40` | Per-connection bucket size (H3). Must be >= `MAX_INBOUND_MESSAGES_PER_SECOND`. |
| `MAX_BUFFERED_BYTES` | `1048576` (1 MiB) | Per-socket outbound buffer limit before terminate (H2). Must be >= `4 * MAX_MESSAGE_SIZE_CEILING`. |

Cross-field rule violations are startup errors naming both variables, for
example `MAX_PENDING_HANDSHAKES (2000) must be <= MAX_CONNECTIONS (1000)`.

Fixed constants (not env; defined in `src/limits` / protocol `limits.ts`):

| Constant | Value | Why |
| --- | --- | --- |
| Handshake timeout | 5 s | H1 (was 10 s in rev 1). A hello is one small message. |
| Max queued messages per connection | 32 | H3. |
| Max JSON depth (whole frame) | 64 | M4. |
| `server.headersTimeout` / `server.requestTimeout` | 10 s / 15 s | H1 (slowloris). |
| `server.maxConnections` | `MAX_CONNECTIONS + 64` | H1 backstop. The margin keeps `/health` reachable at the WS cap. |
| Heartbeat interval | 30 s | H2, AC17. |
| `maxPayload` (transport) | `2 * MAX_MESSAGE_SIZE_CEILING + 8192` | A frame that could still be legal reaches the app-level size check. |

### Apps file (`SYNC_CONFIG_PATH`)

```json
{
  "apps": [
    {
      "namespace": "reading-app",
      "apiKey": "generate-with: openssl rand -base64 32",
      "minAppVersion": "1.0.0",
      "maxGroupSize": 30,
      "maxLeaderUpdatesPerSecond": 5,
      "maxMessageBytes": 4096,
      "maxConnections": 1000
    }
  ]
}
```

| Field | Required | Default | Validation |
| --- | --- | --- | --- |
| `namespace` | yes | - | String, `^[a-z0-9][a-z0-9_-]{0,62}$`, unique. |
| `apiKey` | yes | - | String, 32-256 chars (L7, L2), unique. |
| `minAppVersion` | yes | - | Valid semver, <= 64 chars. |
| `maxGroupSize` | no | 30 | Positive integer, >= 2, <= `MAX_GROUP_SIZE_CEILING`. |
| `maxLeaderUpdatesPerSecond` | no | 5 | Positive integer, <= `MAX_LEADER_UPDATE_RATE_CEILING`. |
| `maxMessageBytes` | no | 4096 | Positive integer, <= `MAX_MESSAGE_SIZE_CEILING`. |
| `maxConnections` | no | 1000 | Positive integer, <= `MAX_APP_CONNECTIONS_CEILING` (M5). |

Rules:
- `apps` must be a non-empty array. Unknown fields in an app entry are rejected,
  which catches typos such as `maxGroupsize`.
- An explicit value above its ceiling is a startup error, for example
  `apps[0] (namespace "reading-app"): maxGroupSize 150 exceeds MAX_GROUP_SIZE_CEILING 100`.
  Values are never clamped (AC5).
- An omitted value uses `min(default, ceiling)`, so lowering a ceiling below a
  default does not break apps that never set the field.
- Duplicate key error: `apps[2] (namespace "b") has the same apiKey as apps[0] (namespace "a")`.
- **JSON parse errors (M2):** the `SyntaxError` message is never passed on,
  because V8 includes an input snippet in it. The loader extracts only
  `line`/`column` (or `position`) with a regex and prints
  `<path>: not valid JSON (line L, column C)`. If no position can be found, it
  prints `<path>: not valid JSON`.
- Errors identify the file path, array index, namespace (when known) and field.
  They never contain an API key value, and our error formatter never echoes
  received values.
- **Dev key (M6):** after loading, any app whose key is in `DEV_API_KEYS` causes:
  - with `NODE_ENV=production`: `ConfigError`
    `apps[0] (namespace "dev-app") uses the public development API key; set a real key`,
    and the process exits 1.
  - otherwise: a `warn` log line `dev api key in use` with `{ namespace }`.

## 5. Wire protocol (v1)

Endpoint: `ws://<host>:<port>/ws` (use `wss://` behind TLS in any non-local
deployment, see the README, M3).
- Frames are text only, and each is one JSON object with a `type` field.
- Client requests may carry `reqId` (string, <= 64 chars). Every direct response
  or error echoes it.
- Unknown extra fields in client messages are ignored, for forward
  compatibility.
- Binary frames, invalid JSON, schema failures and depth > 64 all produce
  `INVALID_MESSAGE`.

### Upgrade (before any WebSocket exists)

| Condition | Response |
| --- | --- |
| Path is not `/ws` | `HTTP/1.1 404`, socket destroyed. |
| Open WebSockets >= `MAX_CONNECTIONS` | `HTTP/1.1 503`, socket destroyed (H1). |
| Pending handshakes >= `MAX_PENDING_HANDSHAKES` | `HTTP/1.1 503`, socket destroyed (H1). |
| Otherwise | `handleUpgrade`. `ws.on('error')` is attached immediately and counters are incremented. |

### Handshake

1. On connect the server sends
   `{ "type": "welcome", "protocolVersion": 1, "minProtocolVersion": 1 }` (AC8).
2. The client sends
   `{ "type": "hello", "protocolVersion": 1, "appVersion": "1.4.0", "apiKey": "..." }`.
   The schema bounds are `apiKey` <= 256 chars and `appVersion` <= 64 chars. They
   are checked before any hashing or semver parsing (L2).
3. The server checks, in order: message shape -> protocol version -> API key ->
   app version is semver -> app version >= app minimum -> app connection count <
   app `maxConnections` (M5).
4. On success the server sends `{ "type": "hello.ok", "participantId": "...", "limits": { "maxGroupSize": 30, "maxLeaderUpdatesPerSecond": 5, "maxMessageBytes": 4096 } }`.
   The connection then leaves the pending count and joins its app's count.
5. On failure the server sends an `error` message, then closes with code `4001`
   (reason = error code). The exception is `APP_CONNECTION_LIMIT`, which closes
   with `4003` (try again later).
6. If no `hello` arrives within 5 s: `HANDSHAKE_TIMEOUT` error, close `4002`.
7. Any other message before `hello.ok`: `HANDSHAKE_REQUIRED` error, close `4001`
   (AC10).

### Client -> server (after the handshake)

| type | Fields | Success response |
| --- | --- | --- |
| `group.create` | `reqId?`, `metadata: JsonObject`, `position?: JsonValue` | `group.created { reqId, groupId, participantId, role: "leader" }` |
| `group.join` | `reqId?`, `groupId: string` | `group.joined { reqId, groupId, participantId, role: "member", metadata, hasPosition, position? }` |
| `position.update` | `reqId?`, `position: JsonValue` | `position.ack { reqId }` to the leader |

- `hasPosition: false`, with no `position` field, is the explicit "no position
  yet" (AC12). This keeps `null` usable as a real payload.
- `groupId` is length-bounded in the schema (<= 256 chars; longer gives
  `INVALID_MESSAGE`, which reveals nothing because real IDs are 43 chars). A value
  within the bound that is not exactly `^[A-Za-z0-9_-]{43}$` is answered with the
  same `GROUP_NOT_FOUND` as an unknown ID, so the format check is not an oracle
  (L3).

### Server -> client events

| type | Fields | To |
| --- | --- | --- |
| `position.updated` | `groupId`, `position` | Every member of the group except the leader (AC13). |
| `group.ended` | `groupId`, `reason: "leader_disconnected"` | Every remaining member (AC17). `reason` is a string union so #5 can add `ended_by_leader`, `max_session` and others. |
| `error` | `reqId?`, `code`, `message`, `details?` | The requester. |

### Error codes (`ErrorCode` in `@sync-system/protocol`)

| Code | When | Closes? | `details` |
| --- | --- | --- | --- |
| `INVALID_MESSAGE` | Bad JSON, binary frame, schema failure, depth > 64 | Before handshake: 4001 | - |
| `HANDSHAKE_REQUIRED` | Group action before `hello.ok` (AC10) | 4001 | - |
| `HANDSHAKE_TIMEOUT` | No hello within 5 s | 4002 | - |
| `ALREADY_AUTHENTICATED` | A second `hello` | no | - |
| `INVALID_API_KEY` | Missing or unknown key (AC7) | 4001 | - |
| `PROTOCOL_TOO_OLD` | Client protocol < minimum (AC8) | 4001 | `{ minProtocolVersion }` |
| `INVALID_APP_VERSION` | App version is not semver or too long (AC9) | 4001 | - |
| `APP_VERSION_TOO_OLD` | App version < minimum (AC9) | 4001 | `{ minAppVersion }` |
| `APP_CONNECTION_LIMIT` | App already has `maxConnections` sockets (M5) | 4003 | - |
| `GROUP_NOT_FOUND` | Unknown, malformed or other app's ID (AC12, AC18, L3) | no | - |
| `GROUP_FULL` | Join would exceed max size (AC21) | no | `{ maxGroupSize }` |
| `ALREADY_IN_GROUP` | Create or join while in a group | no | - |
| `NOT_IN_GROUP` | Update while not in a group | no | - |
| `NOT_LEADER` | A member sends an update (AC15) | no | - |
| `RATE_LIMITED` | Over the leader update rate (AC22) | no | `{ maxLeaderUpdatesPerSecond, retryAfterMs }` |
| `MESSAGE_TOO_LARGE` | Payload or metadata over the limit (AC27) | no | `{ field: "position" \| "metadata", limitBytes }` |
| `TOO_MANY_MESSAGES` | Per-connection inbound flood or queue overflow (H3) | 4008 | - |
| `INTERNAL_ERROR` | Unexpected exception in a handler (H4) | no | - |

`TOO_MANY_MESSAGES` is a separate code from `RATE_LIMITED`, so AC22's "rate
limited" stays specific to the leader update rate (see question Q1).

### Close codes (`CloseCode`)

| Code | Meaning |
| --- | --- |
| `4001` | Handshake rejected |
| `4002` | Handshake timeout |
| `4003` | App connection limit reached; retry later (M5) |
| `4008` | Policy violation: inbound flood / queue overflow (H3) |
| `1001` | Server shutting down |
| `1009` | Frame over `maxPayload` (from `ws`) |
| `1006` (client side) | Terminated without a close frame: slow consumer (H2), heartbeat timeout, protocol violation (H4) |

### Processing rules

- **Inbound limiter (H3).** Every frame, of any type and before or after the
  handshake, takes one token from the connection's bucket
  (`MAX_INBOUND_MESSAGES_PER_SECOND` refill, `MAX_INBOUND_BURST` size). The token
  is taken before JSON parsing. With an empty bucket the server sends
  `TOO_MANY_MESSAGES` once, closes with `4008`, and ignores any further frames
  from that socket (no amplification).
- **Bounded serial queue (H3, H4).** Messages from one connection are processed
  strictly in order through a promise queue. More than 32 pending entries:
  `TOO_MANY_MESSAGES`, close `4008`. Every handler runs inside `try/catch`, which
  maps errors to `INTERNAL_ERROR`. The queue tail has a `.catch` so the chain
  never rejects.
- **Parse pipeline.** token -> `JSON.parse` in `try/catch` -> `checkJson(frame,
  { maxDepth: 64 })` (iterative) -> shallow zod envelope schema -> handler.
  `position`/`metadata` are the original parsed references (M4, L6).
- `position.update` checks, in order: in a group -> is leader -> size -> leader
  rate. A rejected update does not use leader rate budget and does not touch
  stored state. It does use an inbound token.
- `group.create` checks the size of `metadata` and `position` before anything is
  stored. On failure no group exists and the connection stays groupless.
  `metadata` must be a non-array object.
- **Size** = `Buffer.byteLength(JSON.stringify(value), 'utf8')`, measured for each
  field separately against the app's `maxMessageBytes`. A value exactly at the
  limit is accepted. `JSON.stringify` only runs after the depth check passes.
- **Leader rate limit:** a sliding window of accepted update timestamps per group
  over the last 1000 ms. `count >= maxLeaderUpdatesPerSecond` gives
  `RATE_LIMITED`. Updates are never queued or coalesced.
- **Outbound (H2):** `send()` returns without action unless
  `readyState === OPEN`. If `ws.bufferedAmount + frameBytes > MAX_BUFFERED_BYTES`,
  it calls `ws.terminate()` instead of sending. The disconnect rules then run.
  Our code never queues outbound messages. Fan-out serializes the event once and
  sends the same string to each member.
- **Disconnect:**
  - A member is removed from the group.
  - A leader causes `group.ended` to be sent to all members, and the group is
    deleted. Members become groupless; their sockets stay open and can create or
    join again.
  - A group with zero participants is deleted.
  - Counters are decremented exactly once (a `closed` flag guards this).
- **Heartbeat (H2, AC17):** every 30 s:
  - If a ping is outstanding with no pong, terminate.
  - If `bufferedAmount > 0` and it has not dropped since the last tick,
    terminate.
  - Otherwise set `awaitingPong = true`, record `bufferedAmount`, and ping.

  A pong sets `awaitingPong = false` only while one is outstanding. Unsolicited
  pongs are ignored.
- **Error guards (H4):**
  - `ws.on('error')` on every socket.
  - `wss.on('error')`.
  - `httpServer.on('clientError', (err, socket) => socket.destroy())`.
  - `httpServer.on('error')` (logs `code`).
  - An `error` listener on the raw upgrade socket until `handleUpgrade`
    completes.

  Only `err.code`/`err.name` are logged. Client close `reason` strings are never
  logged (L8).

### HTTP

- `GET /health` returns `200`, `Content-Type: application/json`, body
  `{ "status": "ok", "protocolVersion": 1, "minProtocolVersion": 1 }`. It reports
  no counts of apps, groups or connections (AC23).
- Any other path or method returns `404` JSON `{ "error": "not_found" }`.
- `headersTimeout` is 10 s and `requestTimeout` is 15 s (H1).
- No listing endpoint or message exists (AC20).

## 6. Logging and privacy (AC24)

- Allowed log fields: event name, `namespace`, `groupRef` (hash prefix),
  `participantRef` (hash prefix), error `code`, error `name`, close `code`,
  counts, port.
- Never logged: IP or remote address, request headers, `apiKey`, `displayName`
  or any client-supplied name, `position`, `metadata`, raw `groupId`, raw
  messages, client close `reason` (L8), `err.message` of errors that may contain
  input (L5).
- The `upgrade` request object and `req.socket` are never passed to the logger.
  The startup line logs the port only, not the host.
- `safeErr(err)` logs `{ name, code, frames }`, where `frames` is the stack
  without its first line (that line holds the message). It is used for
  `INTERNAL_ERROR` and process-level handlers (L5).
- pino `redact` (`remove: true`) covers `apiKey`, `*.apiKey`, `position`,
  `*.position`, `metadata`, `*.metadata`, `ip`, `remoteAddress`, `headers`,
  `req`, `displayName`, `*.displayName`, `reason`, `message` as a second line of
  defense. Our own human-readable log text goes in pino's `msg`, which is not
  redacted.
- Config errors print to stderr through the same "no key values" formatter (M2).

## 7. Packaging, CI

### Dockerfile (`apps/sync-server/Dockerfile`, build context = repo root)

1. `base`: `node:24-alpine@sha256:<digest>`, pinned by digest (L8). The engineer
   resolves the current digest at implementation time and adds a comment with the
   tag. Then `corepack enable`.
2. `build`:
   - Copy only `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
     `tsconfig.base.json` and the `packages/*/package.json` and
     `apps/*/package.json` manifests.
   - `pnpm install --frozen-lockfile`.
   - Copy `packages/` and `apps/` only, never `COPY . .` (M1).
   - `pnpm --filter @sync-system/server... build`.
   - `pnpm --filter @sync-system/server deploy --prod --legacy /out`. This is
     pnpm 10 syntax and bundles the built protocol package.
3. `runtime`:
   - Same pinned base, `NODE_ENV=production`.
   - Copy `/out` only, then `USER node`, `EXPOSE 8080`,
     `CMD ["node", "dist/index.js"]`.
   - No config file or `.env` in any layer; config is mounted at runtime (M1).

### `compose.yaml`

- Service `sync-server`:
  - Build as above.
  - `ports: ["127.0.0.1:8080:8080"]`, bound to loopback only (M3).
  - Volume `./config/apps.dev.json:/config/apps.json:ro`.
  - Env: `SYNC_CONFIG_PATH=/config/apps.json`, `NODE_ENV=development` (so the dev
    key is warned about, not refused, M6), all ceilings and caps at their
    defaults, `LOG_LEVEL=info`.
- Healthcheck: `node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
  interval 10 s, timeout 3 s, retries 3, start period 5 s.
- `restart: unless-stopped`.

### CI (`.github/workflows/ci.yml`)

- Triggers: `push` and `pull_request`. Never `pull_request_target`.
- `permissions: contents: read`. No secrets.
- One job on `ubuntu-latest`. Actions are pinned to commit SHAs with a version
  comment (L8): `actions/checkout`, `pnpm/action-setup` (version from
  `packageManager`), and `actions/setup-node` (`node-version-file: .nvmrc`,
  `cache: pnpm`).
- Steps: `pnpm install --frozen-lockfile` -> `pnpm audit --audit-level=high`
  (L1) -> `pnpm lint` -> `pnpm typecheck` -> `pnpm test` -> `pnpm build`. Any
  failing step fails the job.
- A Docker build job is not in the spec and is left out. AC25 is verified
  manually.

## 8. Risks, edge cases, security notes

The full threat model is in `security.md`. These are residual notes:

- **API keys are not secrets in browser apps.** A key identifies an app and
  selects its config; anyone who opens a web client can see it. Group isolation
  relies on unguessable group IDs (256 bits). Join methods (#4) and tokens (#3)
  add real access control. The README documents this.
- **Per-IP limits** are delegated to the reverse proxy (README, H1). The app caps
  global, pending and per-app connections only.
- **No Origin check:** there are no cookies or ambient credentials, so
  cross-site WebSocket hijacking gains nothing. Revisit if #3 or #4 introduce
  cookies.
- **The group ID is a bearer secret in #1.** #7 and #8 must keep it out of URLs,
  analytics and logs. This is recorded for those issues.
- **Message size is measured on the re-serialized JSON**, not on raw frame bytes,
  so whitespace in the client's frame does not count. Documented.
- **Async store interleaving:** atomic store operations plus per-connection
  serial queues. A join racing a leader disconnect may get `group.joined`
  followed immediately by `group.ended`. This is acceptable and is tested not to
  crash.
- **Defaults vs ceilings:** if an operator lowers a ceiling below a default, an
  omitted field uses the ceiling. An explicit value over the ceiling still fails.
- **pnpm 10 `deploy`** needs `--legacy` (or `inject-workspace-packages`). The
  engineer verifies this in the Docker build.
- **`pnpm audit` in CI** can fail because of new advisories in dev-only tools,
  unrelated to the change. Such a failure is fixed by upgrading, or recorded as
  an accepted risk in STATE.md. It is never silenced.
- **The slow-reader integration test** depends on OS socket buffer sizes. A unit
  test of `send()` with a fake socket is the deterministic check. The
  integration test uses a small `MAX_BUFFERED_BYTES` and a bounded loop. If it is
  flaky on CI, the engineer keeps the unit test as the authoritative check and
  records a deviation.

## 9. Test plan (mapped to ACs and security controls)

Unit tests are fast and pure. Integration tests (`*.int.test.ts`) start a real
server on port 0 per test file, with a fresh store and small caps where needed.

### Acceptance criteria

| AC | How verified | Where |
| --- | --- | --- |
| AC1 | Files exist: `pnpm-workspace.yaml`, root `package.json`, and `tsconfig.base.json` extended by both packages. | Review |
| AC2 | CI run on the PR. Manual clean clone: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`. | CI + manual |
| AC3 | `apps/sync-server` is its own package, and `pnpm --filter @sync-system/server test` runs Vitest. | CI |
| AC4 | A valid file loads with all fields (including `maxConnections`) parsed. Defaults apply when optional fields are omitted. `SYNC_CONFIG_PATH` is honored. | `apps-config.test.ts`, `main.test.ts` |
| AC5 | Each of the four app limit fields above its ceiling gives a `ConfigError` naming the namespace and field. A value at the ceiling is accepted. Defaults are `min(default, ceiling)`. | `apps-config.test.ts`, `env.test.ts` |
| AC6 | Error cases: missing file, invalid JSON, missing field, wrong type, duplicate key, duplicate namespace. Each numeric env var set to `0`, `-1`, `abc`, `1.5` or `""` is an error, and each cross-field rule is an error. Every message is asserted not to contain any API key string. One child-process test (`tsx src/index.ts`) asserts a non-zero exit and the stderr message. | `apps-config.test.ts`, `env.test.ts`, `main.test.ts` |
| AC7 | Hello with an unknown key and with a missing key gives `INVALID_API_KEY` and close 4001. A follow-up group action is impossible because the socket is closed. | `handshake.int.test.ts` |
| AC8 | `welcome` arrives first with both versions. Hello with `protocolVersion: 0` gives `PROTOCOL_TOO_OLD` with `details.minProtocolVersion`. | `handshake.int.test.ts` |
| AC9 | App version below the minimum gives `APP_VERSION_TOO_OLD` with `details.minAppVersion`. Equal and higher versions are accepted. Semver ordering holds (`1.10.0 > 1.9.0`, prerelease below release). `"latest"` and a 65-char version give `INVALID_APP_VERSION`. A config minimum of `"1.0"` is a startup error. | `handshake.int.test.ts`, `apps-config.test.ts` |
| AC10 | `group.create`, `group.join` and `position.update` before hello give `HANDSHAKE_REQUIRED` and a close, and no group is created. Same after a failed hello. | `handshake.int.test.ts` |
| AC11 | Create with metadata and an initial position gives `group.created` with role leader, and the groupId matches `^[A-Za-z0-9_-]{43}$`. 1,000 generated IDs are unique. Create without a position works. | `groups.int.test.ts`, `ids.test.ts` |
| AC12 | Join gives `group.joined` with metadata and position. Joining a group created without a position gives `hasPosition: false`. | `groups.int.test.ts` |
| AC13 | The leader updates and two members both receive `position.updated`. A later joiner gets the latest payload in `group.joined`. The leader gets `position.ack` and not the broadcast. | `position.int.test.ts` |
| AC14 | Metadata without contentId, fingerprint or schemaVersion is accepted. Payloads cover nested objects and arrays, unicode and RTL text, emoji, numbers, booleans, `null`, a bare string, an array, and keys named `type`, `groupId`, `__proto__` and `constructor`. For create, join and update, the received value `toStrictEqual`s the sent one. Depth 64 is accepted. | `opaque-payload.int.test.ts` |
| AC15 | A member sending an update gets `NOT_LEADER`. Other members receive nothing (`expectNoMessage`). A late joiner sees the old payload. | `position.int.test.ts` |
| AC16 | Create a group, close the server, start a new server instance, then join with the old ID: `GROUP_NOT_FOUND`. | `restart.int.test.ts` |
| AC17 | A member disconnect frees a slot (a join succeeds afterwards in a size-2 group). A leader disconnect sends members `group.ended` with `leader_disconnected`; joining the ID afterwards gives `GROUP_NOT_FOUND`; the store is empty. Heartbeat termination is unit-tested with a short interval. | `lifecycle.int.test.ts`, `heartbeat.test.ts` |
| AC18 | App B joining app A's group ID gets an error deep-equal (except `reqId`) to joining a random nonexistent ID and to joining a malformed ID. B receives no `position.updated` after A's leader updates. | `isolation.int.test.ts` |
| AC19 | Groups X and Y in the same app, plus group Z in another app. Updates and a leader disconnect in X produce no messages for members of Y or Z. | `isolation.int.test.ts` |
| AC20 | Unknown message types such as `group.list` give `INVALID_MESSAGE`. `GET /groups` gives 404. `GroupStore` has no list method (type-level check). | `isolation.int.test.ts`, `http.int.test.ts` |
| AC21 | With app `maxGroupSize: 3`: the leader plus 2 joins succeed, and the 3rd join gives `GROUP_FULL` with `maxGroupSize`. Store `addParticipant` atomicity test. | `limits.int.test.ts`, `in-memory-group-store.test.ts` |
| AC22 | Injected clock, app rate 5: 5 updates are accepted, the 6th gives `RATE_LIMITED`, members get only 5, and a late joiner sees the 5th. After advancing the clock 1000 ms, an update is accepted. Rejected updates do not use budget. The connection stays open. | `limits.int.test.ts`, `rate-limiter.test.ts` |
| AC27 | With app `maxMessageBytes: 4096`: a payload of exactly 4096 bytes is accepted and 4097 gives `MESSAGE_TOO_LARGE` (`field: "position"`). Same for metadata on create. An oversized create leaves no group. An oversized update leaves the stored position unchanged and relays nothing. Multibyte characters count as bytes. | `limits.int.test.ts`, `json-size.test.ts` |
| AC23 | `GET /health` gives 200 JSON with `status` and `protocolVersion`. The body keys are exactly the documented ones, even with live groups. Other paths give 404. | `http.int.test.ts` |
| AC24 | Capture all log lines (`LOG_LEVEL=trace`) while running these flows with sentinel values (API key, a `displayName` extra field, payload and metadata strings, a client close reason): connect, bad-key hello, create, join, update, rate-limited, too-large, not-leader, flood close, malformed frame, a forced handler exception (`INTERNAL_ERROR`, L5), disconnect, and dev-key warning. Assert that none of these appear: the sentinels, the raw group ID, `127.0.0.1`, `::1`, `::ffff:`. | `privacy.int.test.ts` |
| AC25 | Manual: `docker compose up --build`, `docker compose ps` shows `healthy`, `curl 127.0.0.1:8080/health` succeeds, and the log shows the dev-key warning. Engineer pastes the output into the PR. `docker run -e NODE_ENV=production` with the dev config exits 1. | Manual |
| AC26 | README section reviewed against sections 4-5 and 7 of this doc. | Review |
| AC28 | Workflow file present, CI green on the PR, lockfile committed, audit step present. | CI |

### Security controls

| ID | Test | Where |
| --- | --- | --- |
| H1 | With `MAX_CONNECTIONS=3`: the 4th upgrade gets an HTTP 503 and the socket is destroyed; `/health` is still 200. With `MAX_PENDING_HANDSHAKES=2`: a 3rd un-helloed socket gets 503, but after one socket completes hello a new socket is accepted. Counters return to 0 after all close, including after abrupt `destroy()`. A socket that never sends hello is closed with 4002 after 5 s (injected short timeout in tests). Env validation of the new variables and cross-field rules. `headersTimeout`/`requestTimeout` values asserted on the server object. | `caps.int.test.ts`, `env.test.ts` |
| H2 | Unit: `send()` with a fake socket whose `bufferedAmount` exceeds the limit calls `terminate()` and does not call `send()`. Integration: a raw client completes hello, joins, then `pause()`s reading; the leader sends large updates (high test rate ceiling) in a bounded loop; the paused member is terminated; a second, normal member keeps receiving every update. Heartbeat: an unsolicited pong does not keep alive a socket that ignores pings; a stuck `bufferedAmount` causes termination. | `send.test.ts`, `slow-consumer.int.test.ts`, `heartbeat.test.ts` |
| H3 | With `MAX_INBOUND_MESSAGES_PER_SECOND=5`, `MAX_INBOUND_BURST=5`: the 6th frame in one tick gives one `TOO_MANY_MESSAGES` and close 4008; no further error frames are sent. Floods of `NOT_LEADER` updates, random `group.join`s and duplicate hellos are all counted. A queue overflow (handler blocked on a deferred store promise, 33 messages) closes with 4008. Another connection is unaffected during the flood. | `flood.int.test.ts`, `inbound-limiter.test.ts` |
| H4 | Raw frames, each followed by `GET /health` = 200 and a second normal socket completing create/update: (a) text frame with invalid UTF-8; (b) RSV1 bit set; (c) close frame with invalid code 1005; (d) length header over `maxPayload`; (e) unmasked client frame; (f) truncated frame then socket end; (g) binary frame; (h) invalid JSON; (i) `[[[[...]]]]` depth 10,000. Also: send to a member right after it closes; leader and member disconnect at the same instant; a handler that throws (test-only injected store failure) gives `INTERNAL_ERROR` and the socket stays usable. No `unhandledRejection` or `uncaughtException` fires during the suite (a test hook asserts this). | `malformed-frames.int.test.ts`, `robustness.int.test.ts` |
| M1 | `git check-ignore config/apps.json .env` succeeds, and `config/apps.dev.json` is not ignored. Review of `.dockerignore` and the Dockerfile COPY lines. Manual: `docker run --rm <image> ls /` and the app dir show no config. | `repo-hygiene.test.ts` (runs `git check-ignore`), manual |
| M2 | A config with a syntax error placed directly after an API key value: stderr contains `not valid JSON (line L, column C)` and does not contain the key. | `apps-config.test.ts`, `main.test.ts` |
| M3 | Review: README TLS section; `compose.yaml` port is `127.0.0.1:8080:8080`. | Review |
| M4 | Unit: `checkJson` on depth 10,000 returns `too_deep` without throwing; depth 64 is `ok`. Integration: covered in H4 (i). | `json-guard.test.ts` |
| M5 | App `maxConnections: 2`: a third hello gives `APP_CONNECTION_LIMIT` and close 4003, while another app still connects. After one socket closes, a new hello succeeds. Config ceiling tests are under AC5. | `caps.int.test.ts` |
| M6 | `run()` with the dev key and `NODE_ENV=production` returns 1 with a message naming the namespace and not the key. With `NODE_ENV=development` it starts and logs `warn` with the namespace only. | `dev-key.test.ts`, `main.test.ts` |
| L1 | `package.json` ranges `ws@^8.18`, `semver@^7.7`. The CI audit step passes. | Review, CI |
| L2 | A hello with a 257-char `apiKey` gives `INVALID_MESSAGE` (pre-handshake close 4001) and the hash function is not called (spy). A 65-char `appVersion` gives `INVALID_APP_VERSION`. | `schemas.test.ts`, `handshake.int.test.ts` |
| L3 | A `groupId` of 42 chars, 44 chars, or containing `/`: the error equals the unknown-ID error. A 5,000-char `groupId` gives `INVALID_MESSAGE` from the schema bound, and the store is not queried. | `isolation.int.test.ts` |
| L4 | A client offering `permessage-deflate` gets no extension in the response. | `caps.int.test.ts` |
| L5 | Covered in AC24 (forced `INTERNAL_ERROR` with a sentinel in the error message). | `privacy.int.test.ts` |
| L6 | `__proto__` key round-trips (AC14). `checkJson` does not copy the value (identity check). | `json-guard.test.ts`, `opaque-payload.int.test.ts` |
| L7 | A 31-char key is a startup error; 32 chars is accepted. README contains the `openssl rand -base64 32` instruction. | `apps-config.test.ts`, review |
| L8 | Dockerfile `FROM` lines use `@sha256:`; workflow `uses:` lines use 40-char SHAs. Close reason is not logged (AC24). | `repo-hygiene.test.ts` (regex over the files), review |

The protocol package also has `schemas.test.ts`: every message parses, extra
fields are ignored, invalid shapes and over-length strings are rejected, and the
`position` value passes through by reference.

## 10. Security controls (finding -> where handled)

| ID | Sev | Control | Plan section | Commit(s) |
| --- | --- | --- | --- | --- |
| H1 | High | `MAX_CONNECTIONS`, `MAX_PENDING_HANDSHAKES` checked before `handleUpgrade` (503); `server.maxConnections` backstop; handshake timeout 5 s; `headersTimeout` 10 s / `requestTimeout` 15 s; env validation; README proxy note | 4, 5 Upgrade/Handshake, HTTP | 6, 10, 11, 12, 24 |
| H2 | High | `send()` terminates when `bufferedAmount` > `MAX_BUFFERED_BYTES`; pong counts only while a ping is outstanding; stuck-buffer termination at heartbeat | 4, 5 Processing (Outbound, Heartbeat) | 6, 16, 17 |
| H3 | High | Per-connection token bucket on all frames (`MAX_INBOUND_MESSAGES_PER_SECOND`/`MAX_INBOUND_BURST`); queue cap 32; `TOO_MANY_MESSAGES` + close 4008, sent once | 4, 5 Processing (Inbound, Queue), error/close codes | 2, 6, 13 |
| H4 | High | `error` listeners on socket/wss/http/clientError/raw upgrade socket; handlers in try/catch -> `INTERNAL_ERROR`; queue tail never rejects; `send()` checks `readyState`; lint `no-floating-promises`; last-resort process handlers; raw malformed-frame tests | 5 Processing (Error guards), 2 | 1, 10, 11, 12, 13 |
| M1 | Med | `.gitignore` `config/*.json` with exceptions; `.dockerignore` excludes config, `.env*`, logs, coverage; Dockerfile copies only manifests, `packages/`, `apps/` | 2, 7 | 1, 22 |
| M2 | Med | JSON parse errors report only line/column; never `SyntaxError.message` | 4 | 7 |
| M3 | Med | README TLS (`wss://`) requirement + reverse-proxy example; compose binds `127.0.0.1` | 5, 7 | 22, 24 |
| M4 | Med | Iterative `checkJson` with max depth 64 before zod/stringify; no recursive schemas | 1, 5 Parse pipeline | 4 |
| M5 | Med | Per-app `maxConnections` (default 1000) under `MAX_APP_CONNECTIONS_CEILING` (10000), no clamping; `APP_CONNECTION_LIMIT` + close 4003 | 3, 4, 5 Handshake | 6, 7, 12 |
| M6 | Med | Dev key: `ConfigError` when `NODE_ENV=production`, `warn` (namespace only) otherwise; compose sets `NODE_ENV=development` | 4, 7 | 8, 22 |
| L1 | Low | `ws@^8.18`, `semver@^7.7`; CI `pnpm audit --audit-level=high` | 2, 7 | 5, 23 |
| L2 | Low | `apiKey` <= 256, `appVersion` <= 64, `reqId` <= 64, `groupId` <= 256 in schemas, checked before hashing/semver | 5 Handshake | 3 |
| L3 | Low | `groupId` bounded; malformed ID -> same `GROUP_NOT_FOUND` | 5 Client -> server | 3, 14 |
| L4 | Low | `perMessageDeflate: false` | 1, 5 | 11 |
| L5 | Low | `safeErr()` logs name + stack frames without the message line | 6 | 9 |
| L6 | Low | Payload/metadata never rebuilt by zod; stored as `JSON.parse` output; `__proto__` test | 1, 5 Parse pipeline | 3, 4 |
| L7 | Low | `apiKey` minimum 32 chars; README `openssl rand -base64 32` | 4 | 7, 24 |
| L8 | Low | Base image pinned by digest; actions pinned to SHAs; client close reasons never logged | 6, 7 | 9, 22, 23 |

## 11. Implementation chunks (planned commits)

Every commit leaves `pnpm lint/typecheck/test/build` green. Tests ship in the
same commit as the behavior they cover. Each commit has the footer `Refs #1`.

1. `build: scaffold pnpm workspace with typescript, eslint and prettier`
   Root files, `.gitignore`/`.dockerignore` (M1), lint `no-floating-promises`
   (H4), lockfile.
2. `feat(protocol): add protocol package with versions, error and close codes`
   Includes `TOO_MANY_MESSAGES`, `APP_CONNECTION_LIMIT`, close codes 4003/4008
   (H3, M5).
3. `feat(protocol): add message types and bounded zod schemas` (L2, L3, L6)
4. `feat(protocol): add iterative json depth guard` (M4, L6)
5. `build(server): add sync server package with vitest setup`
   `ws@^8.18`, `semver@^7.7` (L1); test helpers including the raw client.
6. `feat(server): validate env ceilings and connection limits`
   (AC5, AC6; H1/H2/H3/M5 env vars and cross-field rules)
7. `feat(server): load and validate client app registry config`
   (AC4-6, AC9 config; M2, M5 field, L7)
8. `feat(server): refuse the public dev api key in production` (M6)
9. `feat(server): add privacy-safe logger` (L5, L8)
10. `feat(server): add http server with health endpoint and startup errors`
    (AC23, AC6 exit code; H1 HTTP timeouts, H4 HTTP error listeners)
11. `feat(server): guard websocket upgrade with connection caps` (H1, H4, L4)
12. `feat(server): add websocket handshake with api key and version checks`
    (AC7-10; 5 s timeout, M5 per-app cap, H4 handler guards)
13. `feat(server): limit inbound messages per connection` (H3)
14. `feat(server): add in-memory group store and group create/join`
    (AC11, AC12, AC16, AC18, AC20, L3)
15. `feat(server): relay leader position updates to members` (AC13-15, AC19)
16. `feat(server): terminate slow consumers on outbound buffer limit` (H2)
17. `feat(server): end group on leader disconnect and add heartbeat` (AC17, H2)
18. `feat(server): enforce max group size` (AC21)
19. `feat(server): rate limit leader position updates` (AC22)
20. `feat(server): enforce max message size for payload and metadata` (AC27)
21. `test(server): add malformed frame and robustness tests` (H4 full matrix)
22. `build(docker): add sync server dockerfile and compose setup`
    (AC25; M1, M3, M6, L8)
23. `ci: add github actions workflow for lint, typecheck, test and build`
    (AC28; L1, L8)
24. `docs: document running, configuring and securing the sync server`
    (AC26; M3, H1 proxy note, L7)

## 12. Questions for Gate 2 (possible spec tension)

- **Q1 (H3 vs AC22 / AC17):** A connection that exceeds the per-connection
  inbound limit (default 20 msg/s, burst 40) is closed with `4008`. If that
  connection is a leader, AC17 then ends its group. AC22 only requires that
  over-rate *leader updates* be rejected and not relayed. That still holds for
  any leader sending under about 20 msg/s, which gets `RATE_LIMITED` and stays
  connected. Default proposed: close floods (security's recommendation) with a
  distinct `TOO_MANY_MESSAGES` code. Alternative: never close, only drop and
  reply less often. That is weaker against H3.
- **Q2 (M4 vs AC14):** AC14 says payloads may contain "arbitrary extra fields".
  The plan limits nesting depth to 64 for the whole frame, which leaves the
  payload about 62 levels. Real positions are a few levels deep. Default
  proposed: 64. Confirm a depth cap is acceptable.
- **Q3 (M5 vs AC5):** AC5 lists the client-set values for this issue as group
  size, update rate and message size. Adding the per-app `maxConnections` (with
  its ceiling and no-clamp rules) widens that list. The user already chose to
  include M5. This only confirms the defaults: app 1000, ceiling 10000.

## 13. Not in this plan

Everything listed under "Out of scope" in the spec. In particular: no client
package (#2), no tokens (#3), no join codes (#4), no timers or roles beyond
leader/member (#5), no Redis (#9). The forward-looking pieces are only the
`GroupStore`/`Notifier` interfaces and the shared protocol package.

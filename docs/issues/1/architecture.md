# Architecture: #1 Sync server core and monorepo scaffold

Issue: https://github.com/MosheRW/sync-system/issues/1
Spec: [`spec.md`](./spec.md) (28 ACs) | Path: full | Designer: skipped (no UI)
Status: **awaiting user approval (Gate 2)**

## 1. Approach

A pnpm-workspace TypeScript monorepo (ESM, Node 24 LTS, pnpm 10) with two
packages in this issue:

| Package | Path | Role |
| --- | --- | --- |
| `@sync-system/protocol` | `packages/protocol` | Isomorphic, framework-free. Protocol version constants, error codes, close codes, message types and zod schemas. Shared by the server now and by the core client (#2), React package (#6) and reading app (#7-8) later. |
| `@sync-system/server` | `apps/sync-server` | Node sync server: config loading, HTTP `/health`, WebSocket endpoint, handshake, groups, limits, logging. Deployable (Dockerfile). |

Layout convention for later issues: `packages/*` = publishable libraries
(`packages/client` in #2, `packages/react` in #6), `apps/*` = deployables
(`apps/reading-app` in #7). `pnpm-workspace.yaml` covers both globs from day one.

Server internals are layered so later issues extend rather than rewrite:

```
transport (http + ws)  ->  connection (state machine, per-conn serial queue)
                       ->  GroupService (business rules, limits)
                       ->  GroupStore (interface; InMemoryGroupStore now, Redis in #9)
                       ->  Notifier (interface; local fan-out now, pub/sub in #9)
```

- `GroupStore` is **async** and exposes **atomic** operations (e.g.
  `addParticipant(..., maxSize)` returns `ok | not_found | full`) so a Redis
  implementation (#9) can slot in with the same semantics.
- Groups are keyed internally by `namespace + groupId`, so a cross-app lookup is
  structurally impossible (AC18), not just filtered.
- A connection holds at most one group in #1. Roles are `leader | member` as a
  string union so #5 can add `vice-leader`.
- The position payload and metadata are stored as the parsed JSON value and
  re-serialized on relay. The server never reads fields inside them.

### WebSocket library: `ws` (Socket.IO rejected)

- **Plain WebSocket on the wire.** The core client (#2) can use the browser's
  native `WebSocket` with zero runtime dependency. Socket.IO forces its own
  client library and Engine.IO framing on every integrating app, which contradicts
  "any app can integrate through a package" with a small, documented protocol.
- **We own the protocol anyway.** Versioned handshake, explicit error codes,
  token-based reconnect (#3) are ours; Socket.IO's auto-reconnect, rooms and acks
  would duplicate or fight them. Rooms also make "list groups" trivially
  reachable, which AC20 forbids.
- **Transport limits.** `ws` has `maxPayload` and per-connection ping/pong for
  dead-peer detection, which is what we need.
- Socket.IO's main advantage (Redis adapter for multi-instance) is deferred to
  #9 and is replaceable with our `Notifier` + Redis pub/sub.

### Other choices

- **HTTP:** Node `http.createServer` (no Express/Fastify). One route
  (`GET /health`); the WebSocket upgrade is handled with
  `new WebSocketServer({ noServer: true })` on path `/ws` only.
- **Validation:** `zod` (v4) for env, the config file, and every inbound
  message. Error formatting is custom (paths and expectations only, never the
  received value) so API keys never appear in errors.
- **Semver:** `semver` package (`valid`, `lt`).
- **Logging:** `pino` with an injectable destination stream (for the AC24 test)
  and `redact` as defense in depth. Group IDs are logged only as `groupRef`
  (first 12 hex chars of sha256(groupId)), because in #1 the group ID is the join
  capability.
- **Tests:** Vitest per package. Integration tests start a real server on port 0
  and talk to it with a `ws` client. Time is injected (`now: () => number`) so the
  rate limiter is tested without fake timers interfering with socket I/O.
- **Lint/format:** ESLint 9 flat config + `typescript-eslint` + Prettier
  (`prettier --check` is part of `pnpm lint`).

### Workspace-internal imports without a build step

`@sync-system/protocol` `exports` uses a custom condition:

```json
".": { "@sync-system/source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
```

`tsconfig.base.json` sets `customConditions: ["@sync-system/source"]` and
Vitest sets `resolve.conditions` to the same, so typecheck and tests read
protocol sources directly. `tsconfig.build.json` per package overrides
`customConditions: []` and sets `rootDir`/`outDir`, so builds resolve the
built `dist` (pnpm `-r build` runs protocol first, topologically). At runtime
Node uses `default` -> `dist`. Fallback if this misbehaves: make `typecheck`
and `test` depend on `pnpm --filter @sync-system/protocol build`; record it as
a deviation.

### Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Socket.IO | See above. |
| Express/Fastify | One route; not worth the dependency. |
| API key in the WS URL query string | Ends up in proxy/access logs. Key goes in the first message instead. |
| Synchronous store | Simpler now, but a Redis store (#9) would force changing every call site. |
| Logging the raw group ID | It is a join capability in #1; logs must not grant access. |
| TS project references (`tsc -b`) | More config for two packages; the source-condition approach covers dev without builds. |

## 2. Files to create

Root:

| Path | What |
| --- | --- |
| `package.json` | Private root; `packageManager: pnpm@10.28.0`; `engines.node >=24`; scripts `lint`, `typecheck`, `test`, `build`, `format`; root devDeps (eslint, typescript-eslint, @eslint/js, eslint-config-prettier, prettier, typescript). |
| `pnpm-workspace.yaml` | `packages: [apps/*, packages/*]`. |
| `pnpm-lock.yaml` | Committed (AC28). |
| `tsconfig.base.json` | Strict, `module/moduleResolution: NodeNext`, `target: ES2023`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `customConditions`. |
| `eslint.config.js` | Flat config, type-aware rules for `apps/*` and `packages/*`, ignores `dist`, `coverage`. |
| `.prettierrc.json`, `.prettierignore` | Formatting; ignore `pnpm-lock.yaml`, `dist`, `docs/PRD*`. |
| `.gitignore` | `node_modules`, `dist`, `coverage`, `.env*`, `*.log`. |
| `.nvmrc` | `24`. |
| `.editorconfig` | LF, 2 spaces. |
| `.dockerignore` | `node_modules`, `**/dist`, `.git`, `.claude`, `docs`. |
| `compose.yaml` | `sync-server` service (see section 7). |
| `config/apps.dev.json` | Dev registry with one obviously fake app (`namespace: "dev-app"`, key `dev-only-api-key-change-me`), mounted by compose. |
| `config/apps.example.json` | Documented example with two apps. |
| `README.md` | Overview, workspace commands, "Sync server" section (AC26). |
| `.github/workflows/ci.yml` | CI (AC28). |

`packages/protocol`:

| Path | What |
| --- | --- |
| `package.json` | `@sync-system/protocol`, `type: module`, `exports` with source condition, dep `zod`; scripts `build`, `typecheck`, `test`. |
| `tsconfig.json` / `tsconfig.build.json` | Typecheck (src + test, noEmit) / build (src -> dist, declarations). |
| `vitest.config.ts` | Source condition. |
| `src/index.ts` | Public exports. |
| `src/version.ts` | `PROTOCOL_VERSION = 1`, `MIN_CLIENT_PROTOCOL_VERSION = 1`. |
| `src/errors.ts` | `ErrorCode` const object and type. |
| `src/close-codes.ts` | WebSocket close codes. |
| `src/json.ts` | `JsonValue`, `JsonObject` types. |
| `src/messages.ts` | TS discriminated unions `ClientMessage`, `ServerMessage`. |
| `src/schemas.ts` | zod schemas for every client and server message. |
| `test/schemas.test.ts` | Valid/invalid message parsing, unknown fields tolerated, payload untouched. |

`apps/sync-server`:

| Path | What |
| --- | --- |
| `package.json` | `@sync-system/server`; deps `@sync-system/protocol` (`workspace:*`), `ws`, `pino`, `semver`, `zod`; devDeps `@types/ws`, `@types/semver`, `@types/node`, `tsx`, `vitest`, `typescript`; scripts `dev` (tsx watch), `start` (node dist/index.js), `build`, `typecheck`, `test`. |
| `tsconfig.json` / `tsconfig.build.json` / `vitest.config.ts` | As for protocol. |
| `Dockerfile` | Multi-stage build (section 7). |
| `src/index.ts` | Process entry: calls `run(process.env)`, sets exit code, wires SIGTERM/SIGINT to graceful close. |
| `src/main.ts` | `run(env, io)`: parse env, load config, create logger, start server. On `ConfigError` prints `Config error: <message>` to stderr and returns exit code 1. |
| `src/config/env.ts` | Parse/validate env variables (section 4). |
| `src/config/apps-config.ts` | `parseAppsConfig(text, env)` and `loadAppsConfigFile(path, env)`: JSON parse, zod schema, defaults, ceilings, duplicates, semver. |
| `src/config/config-error.ts` | `ConfigError` with a human-readable message, never containing key values. |
| `src/apps/app-registry.ts` | `AppRegistry`: `findByApiKey(key)` (map keyed by sha256 of the key), immutable `AppConfig` records. |
| `src/server.ts` | `createSyncServer({ env, registry, logger, now, store?, heartbeatMs? })` -> `{ listen(port, host), close(), port }`. |
| `src/http/health.ts` | `GET /health` handler; 404 for everything else. |
| `src/ws/connection.ts` | Per-connection state (`awaiting_hello` -> `ready`), handshake timeout, serial message queue, dispatch, disconnect hook. |
| `src/ws/handshake.ts` | Hello validation: API key, protocol version, app version. |
| `src/ws/send.ts` | Typed `send(ws, ServerMessage)` and `sendErrorAndClose`. |
| `src/ws/heartbeat.ts` | Ping every 30 s; terminate sockets without a pong. |
| `src/groups/group-store.ts` | `GroupStore` interface + `GroupRecord` types. |
| `src/groups/in-memory-group-store.ts` | Map-based implementation. |
| `src/groups/group-service.ts` | Create/join/update/disconnect rules, limits, notifications. |
| `src/groups/notifier.ts` | `Notifier` interface + `LocalNotifier` (participantId -> connection). |
| `src/groups/ids.ts` | `newGroupId()` (32 random bytes, base64url, 43 chars), `newParticipantId()` (`randomUUID`). |
| `src/limits/rate-limiter.ts` | Sliding-window limiter keyed by group, injected clock. |
| `src/limits/json-size.ts` | `jsonByteLength(value)` = UTF-8 bytes of `JSON.stringify(value)`. |
| `src/logging/logger.ts` | pino factory (`level`, `destination`), redact paths, `groupRef()`. |
| `test/helpers/test-server.ts` | Start server on port 0 with an in-test registry, captured log stream, controllable clock. |
| `test/helpers/test-client.ts` | `ws` client wrapper: `hello()`, `send()`, `next(type)`, `expectNoMessage(ms)`, `closed()`. |
| `test/*.test.ts` | See test plan (section 8). |

No files are modified outside these (the repo currently contains only `docs/`
and `.claude/`).

## 3. Data model (in memory, no database, no migrations)

```ts
// apps
interface AppConfig {
  namespace: string;           // ^[a-z0-9][a-z0-9_-]{0,62}$
  apiKeyHash: string;          // sha256 hex; raw key not kept after load
  minAppVersion: string;       // valid semver
  maxGroupSize: number;        // effective, <= ceiling
  maxLeaderUpdatesPerSecond: number;
  maxMessageBytes: number;
}

// groups
type Role = 'leader' | 'member';
type StoredPosition = { has: false } | { has: true; payload: JsonValue };

interface GroupRecord {
  id: string;                  // 43-char base64url, 256 bits
  appNamespace: string;
  metadata: JsonObject;        // opaque
  position: StoredPosition;    // opaque payload
  leaderId: string;            // participant ID
  participantIds: string[];    // includes leader
  createdAt: number;           // epoch ms (used by #5 max session time)
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

There is no `list` method on the store (AC20). Records returned by `get` are
copies so callers cannot mutate stored state. Restart = new empty store (AC16).

Connection state (local only, never in the store): `participantId`, `app`,
`state`, `groupId?`, `role?`.

## 4. Configuration

### Env variables

| Variable | Default | Rule |
| --- | --- | --- |
| `SYNC_CONFIG_PATH` | `./config/apps.json` (relative to cwd) | Path to the apps JSON file. |
| `PORT` | `8080` | Integer 1-65535. |
| `HOST` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | pino level (`fatal`..`trace`, `silent`). |
| `MAX_GROUP_SIZE_CEILING` | `100` | Positive integer. |
| `MAX_LEADER_UPDATE_RATE_CEILING` | `10` | Positive integer (updates/second). |
| `MAX_MESSAGE_SIZE_CEILING` | `16384` | Positive integer (bytes). |

A ceiling that is empty, non-numeric, zero, negative or non-integer is a startup
error naming the variable (AC6). Unset = default.

### Apps file (`SYNC_CONFIG_PATH`)

```json
{
  "apps": [
    {
      "namespace": "reading-app",
      "apiKey": "replace-with-a-long-random-string",
      "minAppVersion": "1.0.0",
      "maxGroupSize": 30,
      "maxLeaderUpdatesPerSecond": 5,
      "maxMessageBytes": 4096
    }
  ]
}
```

| Field | Required | Default | Validation |
| --- | --- | --- | --- |
| `namespace` | yes | - | string, `^[a-z0-9][a-z0-9_-]{0,62}$`, unique |
| `apiKey` | yes | - | string, >= 16 chars, unique |
| `minAppVersion` | yes | - | valid semver |
| `maxGroupSize` | no | 30 | positive integer, >= 2, <= `MAX_GROUP_SIZE_CEILING` |
| `maxLeaderUpdatesPerSecond` | no | 5 | positive integer, <= `MAX_LEADER_UPDATE_RATE_CEILING` |
| `maxMessageBytes` | no | 4096 | positive integer, <= `MAX_MESSAGE_SIZE_CEILING` |

- `apps` must be a non-empty array. Unknown fields in an app entry are rejected
  (catches typos such as `maxGroupsize`).
- An explicit value above its ceiling is a startup error, e.g.
  `apps[0] (namespace "reading-app"): maxGroupSize 150 exceeds MAX_GROUP_SIZE_CEILING 100`.
  Never clamped (AC5).
- An omitted value uses `min(default, ceiling)`, so lowering a ceiling below a
  default does not break apps that did not set the field. (This is a default,
  not a clamp of an app-set value.)
- Duplicate key error: `apps[2] (namespace "b") has the same apiKey as apps[0] (namespace "a")`.
- Errors identify file path, JSON parse position, array index, namespace (when
  known) and field. They never contain an API key value; error formatting never
  echoes received values for `apiKey`.

## 5. Wire protocol (v1)

Endpoint: `ws://<host>:<port>/ws`. Text frames only, each one JSON object with a
`type` field. Client requests may carry `reqId` (string, <= 64 chars); every
direct response or error echoes it. Unknown extra fields in client messages are
ignored (forward compatibility). Binary frames, invalid JSON or schema failures
-> `INVALID_MESSAGE`.

### Handshake

1. On connect the server sends
   `{ "type": "welcome", "protocolVersion": 1, "minProtocolVersion": 1 }` (AC8).
2. Client sends
   `{ "type": "hello", "protocolVersion": 1, "appVersion": "1.4.0", "apiKey": "..." }`.
3. Server checks, in order: message shape -> protocol version -> API key ->
   app version is semver -> app version >= app minimum.
4. Success: `{ "type": "hello.ok", "participantId": "...", "limits": { "maxGroupSize": 30, "maxLeaderUpdatesPerSecond": 5, "maxMessageBytes": 4096 } }`.
5. Failure: `error` message, then close with code `4001` (reason = error code).
6. No `hello` within 10 s: `HANDSHAKE_TIMEOUT` error and close `4002`.
7. Any other message before `hello.ok`: `HANDSHAKE_REQUIRED` and close `4001` (AC10).

### Client -> server (after handshake)

| type | Fields | Success response |
| --- | --- | --- |
| `group.create` | `reqId?`, `metadata: JsonObject`, `position?: JsonValue` | `group.created { reqId, groupId, participantId, role: "leader" }` |
| `group.join` | `reqId?`, `groupId: string` | `group.joined { reqId, groupId, participantId, role: "member", metadata, hasPosition, position? }` |
| `position.update` | `reqId?`, `position: JsonValue` | `position.ack { reqId }` to the leader |

`hasPosition: false` (and no `position` field) is the explicit "no position yet"
(AC12). This keeps `null` usable as a real payload.

### Server -> client events

| type | Fields | To |
| --- | --- | --- |
| `position.updated` | `groupId`, `position` | Every member of the group except the leader (AC13). |
| `group.ended` | `groupId`, `reason: "leader_disconnected"` | Every remaining member (AC17). `reason` is a string union so #5 can add `ended_by_leader`, `max_session`, etc. |
| `error` | `reqId?`, `code`, `message`, `details?` | Requester. |

### Error codes (`ErrorCode` in `@sync-system/protocol`)

| Code | When | Fatal (closes) | `details` |
| --- | --- | --- | --- |
| `INVALID_MESSAGE` | Bad JSON, binary frame, schema failure | before handshake | - |
| `HANDSHAKE_REQUIRED` | Group action before `hello.ok` (AC10) | yes | - |
| `HANDSHAKE_TIMEOUT` | No hello in 10 s | yes | - |
| `ALREADY_AUTHENTICATED` | Second `hello` | no | - |
| `INVALID_API_KEY` | Missing/unknown key (AC7) | yes | - |
| `PROTOCOL_TOO_OLD` | Client protocol < min (AC8) | yes | `{ minProtocolVersion }` |
| `INVALID_APP_VERSION` | App version not semver (AC9) | yes | - |
| `APP_VERSION_TOO_OLD` | App version < minimum (AC9) | yes | `{ minAppVersion }` |
| `GROUP_NOT_FOUND` | Unknown ID or other app's ID (AC12, AC18) | no | - |
| `GROUP_FULL` | Join would exceed max size (AC21) | no | `{ maxGroupSize }` |
| `ALREADY_IN_GROUP` | Create/join while in a group | no | - |
| `NOT_IN_GROUP` | Update while not in a group | no | - |
| `NOT_LEADER` | Member sends update (AC15) | no | - |
| `RATE_LIMITED` | Over the leader rate (AC22) | no | `{ maxLeaderUpdatesPerSecond, retryAfterMs }` |
| `MESSAGE_TOO_LARGE` | Payload or metadata over limit (AC27) | no | `{ field: "position" \| "metadata", limitBytes }` |
| `INTERNAL_ERROR` | Unexpected exception | no | - |

Close codes: `4001` handshake rejected, `4002` handshake timeout, `1001` server
shutting down, `1009` frame over transport limit (from `ws`).

### Processing rules

- Messages from one connection are processed strictly in order through a
  per-connection promise queue (the store is async; ordering of a leader's
  updates must hold).
- `position.update` checks, in order: in group -> is leader -> size -> rate.
  Rejected updates do not consume rate budget and do not touch stored state.
- `group.create` checks size of `metadata` and `position` before anything is
  stored; on failure no group exists and the connection stays groupless.
- Size = `Buffer.byteLength(JSON.stringify(value), 'utf8')`, each field
  separately against the app's `maxMessageBytes`. Exactly at the limit is
  accepted.
- Transport `maxPayload` = `2 * MAX_MESSAGE_SIZE_CEILING + 8192`, so any frame
  that could still be legal reaches the app-level check and gets
  `MESSAGE_TOO_LARGE`; only absurd frames are dropped by `ws` with 1009.
- Rate limit: sliding window of accepted update timestamps per group over the
  last 1000 ms; `count >= maxLeaderUpdatesPerSecond` -> `RATE_LIMITED`.
  Never queued or coalesced.
- Disconnect: member -> removed from the group. Leader -> `group.ended` to all
  members, group deleted, members become groupless (socket stays open and can
  create/join again). Group with zero participants -> deleted.
- Heartbeat: ping every 30 s; a socket without a pong since the last ping is
  terminated, which triggers the disconnect rules (covers phones that vanish
  without a close frame).

### HTTP

- `GET /health` -> `200`, `Content-Type: application/json`,
  `{ "status": "ok", "protocolVersion": 1, "minProtocolVersion": 1 }`. No counts
  of apps, groups or connections (AC23).
- Any other path or method -> `404` JSON `{ "error": "not_found" }`. Upgrades on
  any path other than `/ws` -> socket destroyed with 404.
- No listing endpoint or message exists (AC20).

## 6. Logging and privacy (AC24)

- Logged fields allowed: event name, `namespace`, `groupRef` (hash prefix),
  `participantRef` (hash prefix), error `code`, counts, port.
- Never logged: IP/remote address, request headers, `apiKey`, `displayName` or
  any client-supplied name, `position`, `metadata`, raw `groupId`, raw messages.
- The `ws` `upgrade` request object is never passed to the logger. The startup
  line logs the port only (not the host).
- pino `redact` (`remove: true`) on `apiKey`, `*.apiKey`, `position`,
  `*.position`, `metadata`, `*.metadata`, `ip`, `remoteAddress`, `headers`,
  `req`, `displayName`, `*.displayName` as a second line of defense.
- Config errors print to stderr through the same "no key values" formatter.

## 7. Packaging, CI

### Dockerfile (`apps/sync-server/Dockerfile`, build context = repo root)

1. `base`: `node:24-alpine`, `corepack enable`.
2. `build`: copy workspace manifests + lockfile, `pnpm install --frozen-lockfile`,
   copy sources, `pnpm --filter @sync-system/server... build`, then
   `pnpm --filter @sync-system/server deploy --prod --legacy /out` (pnpm 10;
   bundles the built protocol package).
3. `runtime`: `node:24-alpine`, `NODE_ENV=production`, copy `/out`, `USER node`,
   `EXPOSE 8080`, `CMD ["node", "dist/index.js"]`.

### `compose.yaml`

- Service `sync-server`: build as above, `ports: ["8080:8080"]`,
  volume `./config/apps.dev.json:/config/apps.json:ro`,
  env `SYNC_CONFIG_PATH=/config/apps.json`, the three ceilings at their defaults,
  `LOG_LEVEL=info`.
- Healthcheck: `node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
  interval 10 s, timeout 3 s, retries 3, start period 5 s.
- `restart: unless-stopped`.

### CI (`.github/workflows/ci.yml`)

On `push` and `pull_request`; one job on `ubuntu-latest`:
`actions/checkout@v4` -> `pnpm/action-setup@v4` (version from
`packageManager`) -> `actions/setup-node@v4` (`node-version-file: .nvmrc`,
`cache: pnpm`) -> `pnpm install --frozen-lockfile` -> `pnpm lint` ->
`pnpm typecheck` -> `pnpm test` -> `pnpm build`. Any failing step fails the job.
`permissions: contents: read`. A Docker build job is not in the spec; it is
left out (AC25 is verified manually).

## 8. Test plan (mapped to ACs)

Unit tests are fast and pure; integration tests (`*.int.test.ts`) start a real
server on port 0 per test file with a fresh store.

| AC | How verified | Where |
| --- | --- | --- |
| AC1 | Files exist; `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json` extended by both packages. | Review |
| AC2 | CI run on the PR; manual clean clone: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`. | CI + manual |
| AC3 | `apps/sync-server` is its own package; `pnpm --filter @sync-system/server test` runs Vitest. | CI |
| AC4 | Valid file loads; all fields parsed; defaults applied when optional fields omitted; `SYNC_CONFIG_PATH` honored. | `config/apps-config.test.ts`, `main.test.ts` |
| AC5 | Each of the three fields above its ceiling -> `ConfigError` naming namespace and field; at ceiling accepted; defaults `min(default, ceiling)`. | `apps-config.test.ts`, `env.test.ts` |
| AC6 | Missing file; invalid JSON; missing field; wrong type; duplicate key; duplicate namespace; ceiling `0`, `-1`, `abc`, `1.5`, `""` -> error. Every message asserted not to contain the API key strings. One child-process test (`tsx src/index.ts`) asserts non-zero exit and stderr message. | `apps-config.test.ts`, `env.test.ts`, `main.test.ts` |
| AC7 | Hello with unknown key and with missing key -> `INVALID_API_KEY`, close 4001; a follow-up group action is impossible (socket closed). | `handshake.int.test.ts` |
| AC8 | `welcome` received first with both versions; hello with `protocolVersion: 0` -> `PROTOCOL_TOO_OLD` with `details.minProtocolVersion`. | `handshake.int.test.ts` |
| AC9 | App version below min -> `APP_VERSION_TOO_OLD` with `details.minAppVersion`; equal and higher accepted; semver ordering (`1.10.0 > 1.9.0`, prerelease below release); `"latest"` -> `INVALID_APP_VERSION`; config min `"1.0"` -> startup error. | `handshake.int.test.ts`, `apps-config.test.ts` |
| AC10 | `group.create`, `group.join`, `position.update` before hello -> `HANDSHAKE_REQUIRED`, close; no group created. Also: after a failed hello. | `handshake.int.test.ts` |
| AC11 | Create with metadata and initial position -> `group.created`, role leader, groupId matches `^[A-Za-z0-9_-]{43}$`; 1,000 created IDs are unique. Create without position works. | `groups.int.test.ts`, `ids.test.ts` |
| AC12 | Join -> `group.joined` with metadata + position; join group created without position -> `hasPosition: false`. | `groups.int.test.ts` |
| AC13 | Leader updates; two members both receive `position.updated`; a later joiner gets the latest payload in `group.joined`; leader gets `position.ack` and not the broadcast. | `position.int.test.ts` |
| AC14 | Metadata without contentId/fingerprint/schemaVersion accepted; payloads covering nested objects/arrays, unicode/RTL text, emoji, numbers, booleans, `null`, a bare string, an array, keys named `type`, `groupId`, `__proto__`, `constructor` -> received `toStrictEqual` sent, for create, join and update. | `opaque-payload.int.test.ts` |
| AC15 | Member sends update -> `NOT_LEADER`; other members receive nothing (`expectNoMessage`); late joiner sees the old payload. | `position.int.test.ts` |
| AC16 | Create group, close server, start a new server instance, join with the old ID -> `GROUP_NOT_FOUND`. | `restart.int.test.ts` |
| AC17 | Member disconnect frees a slot (join succeeds in a size-2 group afterwards). Leader disconnect -> members receive `group.ended` with `leader_disconnected`; join the ID afterwards -> `GROUP_NOT_FOUND`; store empty. Heartbeat termination unit-tested with a short interval. | `lifecycle.int.test.ts`, `heartbeat.test.ts` |
| AC18 | App B joins app A's group ID -> error deep-equal (except `reqId`) to joining a random nonexistent ID; B receives no `position.updated` after A's leader updates. | `isolation.int.test.ts` |
| AC19 | Groups X and Y in the same app plus group Z in another app; updates and leader disconnect in X produce no messages for Y or Z members. | `isolation.int.test.ts` |
| AC20 | Unknown message types such as `group.list` -> `INVALID_MESSAGE`; `GET /groups` -> 404; `GroupStore` has no list method (type-level). | `isolation.int.test.ts`, `http.int.test.ts` |
| AC21 | App `maxGroupSize: 3`: leader + 2 joins ok, 3rd join -> `GROUP_FULL` with `maxGroupSize`; ceiling test covered under AC5. Store `addParticipant` atomic test. | `limits.int.test.ts`, `in-memory-group-store.test.ts` |
| AC22 | Injected clock, app rate 5: 5 updates accepted, 6th -> `RATE_LIMITED`, members get only 5, late joiner sees the 5th; advance clock 1000 ms -> accepted. Rejected updates do not consume budget. | `limits.int.test.ts`, `rate-limiter.test.ts` |
| AC27 | App `maxMessageBytes: 4096`: payload at exactly 4096 bytes accepted, 4097 -> `MESSAGE_TOO_LARGE` (`field: "position"`); same for metadata on create; oversized create -> no group (connection can still create a valid one; join of nothing returns not found); oversized update -> stored position unchanged and nothing relayed; multibyte characters counted as bytes. | `limits.int.test.ts`, `json-size.test.ts` |
| AC23 | `GET /health` -> 200 JSON with `status` and `protocolVersion`; body keys are exactly the documented ones even with live groups; other paths 404. | `http.int.test.ts` |
| AC24 | Capture all log lines (`LOG_LEVEL=trace`) while running connect, bad-key hello, create, join, update, rate-limited, too-large, not-leader, disconnect flows using sentinel values (API key, `displayName` extra field, payload and metadata strings). Assert none of the sentinels, the raw group ID, `127.0.0.1`, `::1` or `::ffff:` appear. | `privacy.int.test.ts` |
| AC25 | Manual: `docker compose up --build`; `docker compose ps` shows `healthy`; `curl localhost:8080/health`. Engineer pastes the output into the PR. | Manual |
| AC26 | README section reviewed against sections 4-5 of this doc. | Review |
| AC28 | Workflow file present; CI green on the PR; lockfile committed. | CI |

Protocol package: `schemas.test.ts` (every message parses; extra fields ignored;
invalid shapes rejected; `position` value passes through untouched).

## 9. Risks, edge cases, security

- **API keys are not secrets in browser apps.** They identify an app and select
  its config; they are visible to anyone who opens a web client. Group isolation
  relies on unguessable group IDs (256 bits). Join methods (#4) and tokens (#3)
  add real access control. Documented in the README.
- **Unauthenticated socket DoS:** handshake timeout (10 s) and `maxPayload` bound
  per-socket cost. A global connection cap / per-IP limits are not in scope;
  noted for #9 / reverse-proxy docs.
- **No Origin check** in #1 (non-browser clients are valid); revisit in #4.
- **Prototype pollution:** payloads are never merged or spread into server
  objects; stored as parsed values and only re-serialized. Test includes
  `__proto__` keys.
- **Message size is measured on the re-serialized JSON**, not raw frame bytes, so
  whitespace in the client's frame does not count. Documented.
- **Async store interleaving:** atomic store ops + per-connection serial queues.
  A join racing a leader disconnect may get `group.joined` followed immediately
  by `group.ended`; acceptable and tested to not crash.
- **Log leakage via errors:** zod errors are formatted by our code, never logged
  raw; `INTERNAL_ERROR` logs the stack but not the message that caused it.
- **Defaults vs ceilings:** if an operator lowers a ceiling below a default, an
  omitted field uses the ceiling (section 4). An explicit over-ceiling value
  still fails.
- **`apiKey` minimum length 16** and **`maxGroupSize >= 2`** are small additions
  beyond the spec text to prevent obviously broken configs. Easy to drop if the
  user disagrees.
- **pnpm 10 `deploy`** needs `--legacy` (or `inject-workspace-packages`); the
  engineer verifies in the Docker build.
- **Windows dev machines:** scripts avoid shell-specific syntax; `.gitattributes`
  enforcing LF is not added (existing `.claude/.gitattributes` untouched);
  Prettier `endOfLine: lf`.

## 10. Implementation chunks (planned commits)

Each commit leaves `pnpm lint/typecheck/test/build` green. Tests ship in the same
commit as the behavior they cover. Footer `Refs #1` on each.

1. `build: scaffold pnpm workspace with typescript, eslint and prettier`
   root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
   `eslint.config.js`, Prettier files, `.gitignore`, `.nvmrc`,
   `.editorconfig`, `pnpm-lock.yaml`.
2. `feat(protocol): add protocol package with versions and error codes`
   package setup, `version.ts`, `errors.ts`, `close-codes.ts`, `json.ts`.
3. `feat(protocol): add message types and zod schemas`
   `messages.ts`, `schemas.ts`, `schemas.test.ts`.
4. `build(server): add sync server package with vitest setup`
   package/tsconfig/vitest files, test helpers skeleton.
5. `feat(server): validate env ceilings and server settings` (AC5, AC6)
6. `feat(server): load and validate client app registry config` (AC4-6, AC9 config)
7. `feat(server): add privacy-safe logger` (logger + `groupRef`, redact)
8. `feat(server): add http server with health endpoint and startup errors` (AC23, AC6 exit code; `main.ts`, `index.ts`, `server.ts`)
9. `feat(server): add websocket handshake with api key and version checks` (AC7-10)
10. `feat(server): add in-memory group store and group create/join` (AC11, AC12, AC16, AC18, AC20)
11. `feat(server): relay leader position updates to members` (AC13-15, AC19)
12. `feat(server): end group on leader disconnect and add heartbeat` (AC17)
13. `feat(server): enforce max group size` (AC21)
14. `feat(server): rate limit leader position updates` (AC22)
15. `feat(server): enforce max message size for payload and metadata` (AC27)
16. `test(server): assert logs exclude ips, names, keys and payloads` (AC24)
17. `build(docker): add sync server dockerfile and compose setup` (AC25)
18. `ci: add github actions workflow for lint, typecheck, test and build` (AC28)
19. `docs: document running and configuring the sync server` (AC26)

## 11. Not in this plan

Everything listed under "Out of scope" in the spec. In particular: no client
package (#2), no tokens (#3), no join codes (#4), no timers/roles beyond
leader/member (#5), no Redis (#9). The `GroupStore`/`Notifier` interfaces and
the shared protocol package are the only forward-looking pieces.

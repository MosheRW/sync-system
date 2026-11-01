# Architecture: #3 Framework-free core client package

Issue: https://github.com/MosheRW/sync-system/issues/3
Spec: `docs/issues/3/spec.md` (32 ACs; Gate 1 accepted every proposed default)
Path: full | Branch: `feat/3-core-client` | Builds on: #1 (`packages/protocol`, `apps/sync-server`)

"Item N" means PRD item N of 9, as in the spec.

Revision 2: folds in the security plan review round 1 (`security.md`: H1, H2 required; M1-M5 and L1-L8 recommended). The mapping is in section 11 "Security controls". New questions Q-D and Q-E are in section 14.

## 1. Approach

A new workspace library `packages/client` (`@sync-system/client`) holds one
public class, `SyncClient`, plus types. It is built the same way as
`@sync-system/protocol`: TypeScript, ESM, `tsc` to `dist/`, and the
`@sync-system/source` export condition so workspace consumers and tests use
`src/` with no build step (the pattern from #1 architecture, section 1).

Inside, the client is split into small modules that each do one thing
(transport, handshake, requests, throttle, backoff, state) and are tested on
their own with a fake socket and fake timers. `SyncClient` connects them. Then
integration tests run the client against the real `apps/sync-server`, started
in-process.

Main design decisions:

1. **No DOM or Node types in `src/`.** `tsconfig.build.json` uses `lib:
   ["ES2023"]` and `types: []`. Then any `import 'node:...'` or stray use of
   `window`/`document` fails the typecheck, which enforces AC1. The few host
   globals the client needs (`WebSocket`, `setTimeout`, `clearTimeout`,
   `TextEncoder`, `URL`) are read **lazily, at call time**, through one typed
   accessor (`src/host.ts`). Nothing runs at import time (AC7), and vitest
   fake timers work because `globalThis.setTimeout` is looked up on each call.
2. **Snapshot store for React (item 6).** `getSnapshot()` returns an immutable
   object that keeps its identity until something changes. `subscribe(listener)`
   returns an unsubscribe function. This is exactly the contract
   `useSyncExternalStore` needs. Typed events (`on(event, fn)`) sit next to it
   for things that happen once (position received, group ended, rejoined,
   error).
3. **Fail fast, no hidden queue (Q6).** Group calls made while not `connected`
   reject with `NOT_CONNECTED`. Nothing is ever sent before `hello.ok` (AC11).
4. **Local checks mirror the server's.** Before a message is sent, the client
   checks role, group, JSON validity and size, using the same byte measure as
   the server. It still handles the server's answer if limits change (AC23).
5. **Request timeouts (Q-C, refined by M4).**
   - `hello`, `group.create`, `group.join`: no reply within
     `requestTimeoutMs` (10 s) -> reject with `REQUEST_TIMEOUT`, drop the
     socket and reconnect. This catches half-open TCP connections, which a
     browser cannot detect itself (it cannot send pings). It also keeps client
     and server state consistent: a late `group.created` would otherwise
     leave an orphan group on the server.
   - `position.update`: no `position.ack` within `2 x requestTimeoutMs`
     (20 s) -> an `error` event with `REQUEST_TIMEOUT`. The socket is dropped
     **only if** nothing at all came from the server during the last
     `requestTimeoutMs`. Any inbound frame proves the link is alive. Dropping
     a leader's socket ends its group, so a merely slow server must not cause
     it.
   - Every drop caused by a timeout counts as a failed attempt for backoff
     (section 4, H1). It never resets the counter.
6. **The client must not harm anything outside itself (H1, H2).**
   - A flapping server gets growing backoff: the counter resets only after
     a connection has stayed up for `stableAfterMs` (10 s).
   - A Node host process is never crashed by an injected `ws` socket: every
     socket keeps an `error` listener for its whole life, and `close()` /
     `send()` calls are wrapped in `try/catch` (section 4).
7. **Built to be extended.** Items 3 and 4 plug in at three internal seams:
   - `buildHello()`, so a token can be added to `hello`;
   - a `RejoinStrategy` interface (`src/rejoin.ts`). Today it is
     member-rejoin-by-group-ID (Q1); item 3 swaps in token rejoin;
   - a generic internal `request(message)` method. Item 4 adds new join
     methods as thin public wrappers over it.

   None of these seams is public API yet.

### Decisions the spec left to the architect

**AC10, unknown server message types: ignore them; reject invalid known
types.** Every inbound frame goes through: text check -> length guard ->
`JSON.parse` -> `checkJson` (depth 64) -> `parseServerMessage`.

- An object whose `type` is a string the client does not know is **ignored**
  and only logged at debug level through the optional logger. The type is
  logged only if it matches `/^[a-z.]{1,64}$/`, otherwise as `"(invalid)"`
  (L2).
  Why: a newer server may add new event types (for example item 5's "leader
  offline") without bumping the protocol version, and an older client must keep
  working. Breaking changes bump `protocolVersion`, and AC12 catches those.
- A frame with a **known** `type` that fails its schema, or that is binary,
  not JSON, too deep or too long, is a protocol violation. It never reaches the
  app as a typed event. The client emits an `error` event with code
  `INVALID_SERVER_MESSAGE` (details: schema issue paths only, never values,
  at most 10 entries, L2).
  If the raw frame has a string `reqId` that matches a pending request, that
  request is rejected with the same error. Before `hello.ok`, an invalid frame
  ends the attempt: the socket is closed, and the client reconnects with
  backoff, since the cause may be a proxy problem that goes away.

**AC24, connection-state names.** `ConnectionState` is a discriminated union
on `status`:

| `status`       | Extra fields                                                     | Meaning |
| -------------- | ---------------------------------------------------------------- | ------- |
| `idle`         | none                                                             | Created; `connect()` not called yet. |
| `connecting`   | none                                                             | First attempt after `connect()`: socket opening + handshake. |
| `connected`    | `participantId`, `limits`                                        | `hello.ok` received. Group calls allowed. |
| `reconnecting` | `attempt` (1-based), `delayMs`, `retryAt` (epoch ms), `attempting` (bool) | Waiting for the backoff timer (`attempting: false`), or retrying (`attempting: true`). Also used when the first attempt fails with a retryable error. |
| `closed`       | `reason: 'client' \| 'fatal' \| 'gave_up'`, `error?: SyncClientError` | Terminal until the app calls `connect()` again. |

Why these names: they are the spec's own words (AC24), so the README, the
React hooks and the reading app can use one vocabulary. There is one
`reconnecting` state with an `attempting` flag instead of two states, so the
indicator does not flicker between "waiting" and "trying". `connected` means
the handshake is done, not just the socket open, because the socket being
open is not useful to an app.

`connect()` is allowed from `idle` and `closed`. From `connecting`,
`reconnecting` or `connected` it returns the current attempt's promise, or
resolves at once. A client is never reconnected automatically out of
`closed` (AC14, AC28).

`connect()` does **not** reset the backoff (M5). The client keeps two
counters:

- `failureStreak` sets the delay. It grows on every failed attempt (fatal
  ones included) and resets only through the stability rule (section 4, H1),
  or when a new `SyncClient` is created.
- `runAttempts` counts attempts against `maxAttempts` and is the `attempt`
  shown in the state. `connect()` resets it.

So `connect()` from `closed(client)` with `failureStreak === 0` opens a socket
right away. `connect()` from `closed(fatal)` or `closed(gave_up)` goes to
`reconnecting` and waits the backoff delay for `failureStreak + 1` first.
That way an app (or the item 6 hooks) that calls "if closed, connect" cannot
hammer the server after a fatal error. The README says apps must not retry
fatal errors automatically.

### Alternatives rejected

- **A function-based store (`createSyncClient()` returning closures)**: works
  too. A class with `#private` fields keeps the API key out of
  `util.inspect`, `JSON.stringify` and devtools object previews, and makes
  `instanceof SyncClientError` style checks natural. We do export a
  `createSyncClient(options)` alias for apps that prefer factories.
- **Queueing calls until connected**: rejected at Gate 1 (Q6). Hidden queues
  hide bad state and make "did my page turn get through?" unanswerable.
- **A Promise per `updatePosition` call**: coalescing means most calls are
  never sent, so each promise would need a "superseded" result. The call is
  synchronous instead: it throws for local errors, and server rejections come
  through the `error` event.
- **An event-emitter library or RxJS**: an extra runtime dependency for about
  40 lines of code.
- **Moving `jsonByteLength` into `@sync-system/protocol` and switching the
  server to it**: cleaner, but it changes server code, and the spec rules that
  out. The client gets its own `TextEncoder` version, plus a parity test
  against the server's `Buffer.byteLength` version.
- **Using the `ws` package in `src/` as a fallback**: it is Node-only and
  would break AC1. Node apps inject it, or use the global `WebSocket` that
  Node 22+ provides.

## 2. Package layout and files

### Create

| Path | What |
| ---- | ---- |
| `packages/client/package.json` | `@sync-system/client`, private, ESM. `exports` with `@sync-system/source` -> `src/index.ts`, `types`, `default` (same shape as protocol). Deps: `@sync-system/protocol: workspace:*`. Dev deps: `@sync-system/server: workspace:*`, `ws`, `@types/ws`, `@types/node`, `typescript`, `vitest` (same versions already in the lockfile). Scripts: `build`, `typecheck`, `test`. |
| `packages/client/tsconfig.json` | Typecheck for src + test + config. `types: ["node"]` is needed for the tests only. |
| `packages/client/tsconfig.build.json` | Builds `src` -> `dist` with `types: []`, `lib: ["ES2023"]`, `customConditions: []`. This is the AC1 guard. |
| `packages/client/vitest.config.ts` | Same conditions as protocol, plus `setupFiles: ['test/setup.ts']`. |
| `packages/client/README.md` | AC31 docs (section 9). |
| `packages/client/src/index.ts` | Public exports only (section 3). |
| `packages/client/src/client.ts` | `SyncClient` class: life cycle, state, group calls, wiring of the modules below. |
| `packages/client/src/options.ts` | `SyncClientOptions`, defaults, validation that throws `INVALID_OPTIONS` (key and version lengths, number ranges, M1). Copies what it needs; the options object is never stored (L4). |
| `packages/client/src/url-policy.ts` | `checkServerUrl(url, allowInsecureTransport)`: the exact `wss://` / loopback rules (M2, Q-B). |
| `packages/client/src/host.ts` | Lazy typed access to `globalThis` (`WebSocket`, timers, `Date.now`, `TextEncoder`, `URL`), plus the `WebSocketLike` and `WebSocketConstructorLike` types. Never touched at import. `setClampedTimeout(fn, ms)` is the only way the client starts a timer: it clamps `ms` to `[0, 2^31-1]` and turns `NaN` into 0 (M1). |
| `packages/client/src/limits.ts` | Client-side sanity bounds for values from `hello.ok` and server `details` (M1, section 6). |
| `packages/client/src/version.ts` | `CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION` (1), `MIN_SERVER_PROTOCOL_VERSION = 1` (Q5). |
| `packages/client/src/errors.ts` | `SyncClientError`, `ClientErrorCode`, the per-code details map, `isSyncClientError()`, `fromServerError()`, fatal-code set. |
| `packages/client/src/state.ts` | `ConnectionState`, `GroupState`, `SyncClientSnapshot`, `indicatorOf()`. |
| `packages/client/src/emitter.ts` | Small typed emitter. Listener exceptions are caught and reported to the logger by `err.name` only (L4), never rethrown. |
| `packages/client/src/logger.ts` | `SyncClientLogger` type, no-op default, `LogFields` (primitives only). |
| `packages/client/src/transport.ts` | One socket attempt: open, `sendJson`, inbound decode (section 6), close classification. Each attempt has a generation number, so events from an old socket are ignored. Socket retirement keeps a no-op `error` listener attached forever; `send()`/`close()` in `try/catch` (H2, section 4). |
| `packages/client/src/handshake.ts` | `checkWelcome()` (pure, AC12), `buildHello()`, `classifyHandshakeError()` (fatal vs retryable). |
| `packages/client/src/requests.ts` | `RequestTracker`: `reqId` counter (`c1`, `c2`, ...), pending map, per-request timeout with two kinds (`drop` for hello/create/join, `ack` for position updates, M4), `rejectAll(error)`. Internal promises always have a handler (L6). |
| `packages/client/src/throttle.ts` | `PositionThrottle`: sliding window over a ring buffer of at most `L` timestamps, coalescing, trailing send, bounded `RATE_LIMITED` re-queue (section 5, M1, L5). |
| `packages/client/src/backoff.ts` | `nextDelay(streak, policy, random, signal)`: pure full-jitter exponential backoff, with the busy-signal floor (M3) and the stability rule helper `streakAfterDrop(streak, connectedForMs, stableAfterMs)` (H1). |
| `packages/client/src/json-size.ts` | `jsonByteLength(value)` = UTF-8 bytes of `JSON.stringify(value)` via `TextEncoder`. |
| `packages/client/src/rejoin.ts` | `RejoinStrategy` interface + `memberRejoinByGroupId` (Q1). |
| `packages/client/test/setup.ts` | No unhandled rejections or uncaught exceptions per file (same as the server's). |
| `packages/client/test/helpers/fake-websocket.ts` | A controllable `WebSocketLike` (records sends, lets the test deliver frames and close/error events). |
| `packages/client/test/helpers/blackhole-server.ts` | `node:net` server that accepts TCP and never answers the HTTP upgrade (H2 tests with injected `ws`). |
| `packages/client/test/helpers/tcp-proxy.ts` | `node:net` proxy between client and real server that can cut every connection, or cut each one a set time after it opens (flapping server for H1, abnormal drops for reconnect tests). |
| `packages/client/test/helpers/real-server.ts` | Starts the real server in-process from `@sync-system/server` src modules (`createSyncServer`, `parseEnv`, `parseAppsConfig`, `AppRegistry`, `createLogger`). Supports a fixed `port` (for restart tests) and per-app limits. Its silent log sink is collected for privacy assertions. |
| `packages/client/test/*.test.ts`, `test/integration/*.int.test.ts` | See section 10. |

### Modify

| Path | Change |
| ---- | ------ |
| `pnpm-lock.yaml` | New importer `packages/client` (no new third-party packages; `ws`, `@types/ws`, `@types/node`, `vitest`, `typescript` resolve to versions already locked). |
| `eslint.config.js` | Block for `packages/client/src/**`: `no-console: error` (AC32), and `no-restricted-imports` for `node:*`, `ws`, `react`, `react-dom`, `vue` (AC1). Also `no-restricted-globals` for `window`, `document`, `navigator`, `localStorage` in `src` (AC7). |
| `apps/sync-server/Dockerfile` | Add `COPY packages/client/package.json packages/client/` next to the other manifests, so `pnpm install --frozen-lockfile` sees every lockfile importer. Build-only; the runtime image is unchanged (it still deploys only `@sync-system/server`). |
| `README.md` | Add the client to the workspace table and link its README. |
| `docs/issues/3/STATE.md` | Phase updates. |

No server source changes. No `packages/protocol` changes.

## 3. Public API (`src/index.ts`)

```ts
export class SyncClient {
  constructor(options: SyncClientOptions);           // validates options; touches no globals except URL parsing
  connect(): Promise<ConnectedInfo>;                  // { participantId, limits }
  close(): void;                                      // idempotent, synchronous
  createGroup(metadata: JsonObject, initialPosition?: JsonValue): Promise<CreatedGroup>;
  joinGroup(groupId: string): Promise<JoinedGroup>;
  updatePosition(position: JsonValue): void;          // throws SyncClientError for local errors
  getState(): ConnectionState;                        // same as getSnapshot().connection
  getSnapshot(): SyncClientSnapshot;                  // stable identity until a change
  subscribe(listener: () => void): () => void;        // snapshot changes (useSyncExternalStore)
  on<E extends keyof SyncClientEvents>(event: E, listener: (p: SyncClientEvents[E]) => void): () => void;
  off<E extends keyof SyncClientEvents>(event: E, listener: (p: SyncClientEvents[E]) => void): void;
}
export function createSyncClient(options: SyncClientOptions): SyncClient;
export function indicatorOf(snapshot: SyncClientSnapshot): SyncIndicator;
export { SyncClientError, isSyncClientError, ClientErrorCode, CLIENT_PROTOCOL_VERSION, MIN_SERVER_PROTOCOL_VERSION };
export type {
  SyncClientOptions, ReconnectOptions, SyncClientLogger, LogFields,
  WebSocketLike, WebSocketConstructorLike,
  ConnectionState, ClosedReason, GroupState, GroupEndedInfo, SyncClientSnapshot, SyncIndicator,
  ConnectedInfo, CreatedGroup, JoinedGroup, SyncClientEvents, ErrorDetailsMap,
};
// Re-exported for convenience: JsonValue, JsonObject, AppLimits, Role (types only).
```

### Options

```ts
interface SyncClientOptions {
  url: string;                       // wss://... (ws:// only for loopback, or with allowInsecureTransport)
  apiKey: string;                    // 1..MAX_API_KEY_LENGTH chars
  appVersion: string;                // 1..MAX_APP_VERSION_INPUT_LENGTH chars; semver is checked by the server
  WebSocket?: WebSocketConstructorLike;   // injection (AC5); default globalThis.WebSocket, read in connect()
  reconnect?: {
    initialDelayMs?: number;         // 500
    maxDelayMs?: number;             // 10_000
    maxAttempts?: number;            // Infinity (per connect() run)
    stableAfterMs?: number;          // 10_000: connected this long before the backoff resets (H1)
  };
  requestTimeoutMs?: number;         // 10_000; also the timeout for open + handshake; ack timeout is 2x (M4)
  allowInsecureTransport?: boolean;  // false; must be exactly `true` to allow non-loopback ws:// (M2)
  logger?: SyncClientLogger;         // default: no-op (AC32)
  random?: () => number;             // default Math.random, read lazily; injected by tests
}
```

`WebSocketLike` is the WHATWG subset the client uses: `readyState`, `send(string)`,
`close(code?, reason?)`, `addEventListener/removeEventListener` for `open`,
`message`, `close`, `error`. Both the browser `WebSocket`, Node's global
`WebSocket` (undici) and `ws` 8 (whose `EventTarget` API gives text frames as
strings) fit it.

Option validation (M1), all failures throw `INVALID_OPTIONS { field }` from
the constructor:

- Every `*Ms` value must be a finite number in `[0, 2^31-1]`.
  `initialDelayMs >= 1`, `maxDelayMs >= initialDelayMs`,
  `requestTimeoutMs >= 1` and `2 * requestTimeoutMs <= 2^31-1`.
- `maxAttempts` must be an integer `>= 1` or `Infinity`.
- `allowInsecureTransport` must be a boolean if given. `random`, `logger` and
  `WebSocket` must have the right `typeof` if given.
- `apiKey`, `appVersion`: non-empty strings within the protocol's lengths.
- `url`: `checkServerUrl` (section 11, M2).

The constructor copies these values into private fields and keeps no
reference to the options object (L4).

### Snapshot, group state, indicator

```ts
interface SyncClientSnapshot {
  connection: ConnectionState;
  group: GroupState | null;          // null = never in a group (or after a new connect())
}
type GroupState =
  | { status: 'active'; groupId: string; role: 'leader' | 'member'; metadata: JsonObject | null;
      hasPosition: boolean; position: JsonValue | undefined }   // leader: last value it set
  | { status: 'rejoining'; groupId: string; role: 'member'; metadata: JsonObject; hasPosition: boolean; position: JsonValue | undefined }
  | { status: 'ended'; groupId: string; reason: GroupEndedInfo['reason']; code?: ErrorCode };
type SyncIndicator = 'none' | 'following' | 'leading' | 'reconnecting' | 'leader_offline';
```

`metadata` is `null` for a leader (it created the metadata and already has
it). We do not keep a copy, so the opaque data has a single owner.

`indicatorOf` (documented in the README, AC25):

| Snapshot | Indicator |
| -------- | --------- |
| `group.status === 'ended'` (any connection state) | `leader_offline` (in #1 a leader drop ends the group; item 5 adds a grace period) |
| connection `connecting`/`reconnecting` and group `active`/`rejoining` | `reconnecting` |
| connection `connected`, group `rejoining` | `reconnecting` |
| connection `connected`, group `active`, role `member` | `following` |
| connection `connected`, group `active`, role `leader` | `leading` |
| anything else (no group, idle, closed without group) | `none` |

A closed client with an active group cannot happen: `close()` and terminal
failures clear the group as below.

### Events (`SyncClientEvents`)

| Event | Payload | When |
| ----- | ------- | ---- |
| `state` | `ConnectionState` | Every connection-state change (AC19, AC24). |
| `positionUpdated` | `{ groupId, position }` (the parsed reference, untouched) | Member receives `position.updated` for its current group. |
| `groupEnded` | `{ groupId, reason: 'leader_disconnected' \| 'rejoin_failed', code?: ErrorCode }` | Server `group.ended`; the leader's own socket dropped; rejoin failed (Q1). |
| `rejoined` | `JoinedGroup` | Member auto-rejoin succeeded after a reconnect (Q1). |
| `error` | `SyncClientError` | Errors not tied to a pending promise: server errors without a matching request, server rejections of position updates (`RATE_LIMITED`, `MESSAGE_TOO_LARGE`, ...), `INVALID_SERVER_MESSAGE`, retryable connection failures (each failed attempt, so an app can show "server busy"). |

Order inside one inbound message: update state -> notify snapshot subscribers
-> emit events -> settle the promise. `subscribe`/`on` return an unsubscribe
function, and `off` exists as well. Listeners are stored in a `Set`, and a
removed listener is skipped even if it is removed while an emit is running
(AC19).

## 4. Connection life cycle and state machine

```
idle --connect()--> connecting --hello.ok--> connected
connecting --retryable failure--> reconnecting(attempt 1, waiting)
connected --unexpected close / timeout drop--> reconnecting(attempt n+1, waiting)   (streak reset first only if connected >= stableAfterMs, H1)
reconnecting(waiting) --timer--> reconnecting(attempting) --hello.ok--> connected
reconnecting(attempting) --retryable failure--> reconnecting(attempt n+1, waiting) | closed(gave_up) if n == maxAttempts
any --fatal--> closed(fatal, error)
any --close()--> closed(client)
closed(client), streak 0 --connect()--> connecting
closed(fatal | gave_up), or streak > 0 --connect()--> reconnecting(attempt 1, waiting)   (M5)
```

One attempt (`transport.ts` + `handshake.ts`):

1. Resolve the constructor (`options.WebSocket ?? globalThis.WebSocket`). If
   there is none: `closed(fatal, NO_WEBSOCKET)` and `connect()` rejects (AC6).
   The constructor never throws for this, so creating a client in SSR code is
   safe.
2. `new WS(url)`. Start the attempt timer (`requestTimeoutMs`), which covers
   open + `welcome` + `hello.ok`.
3. On `welcome`: run `checkWelcome`. If `welcome.minProtocolVersion >
   CLIENT_PROTOCOL_VERSION` or `welcome.protocolVersion <
   MIN_SERVER_PROTOCOL_VERSION`, close with code 1000 and reason
   `SERVER_UNSUPPORTED`, without sending `hello`. This is fatal and carries
   `{ clientProtocolVersion, minServerProtocolVersion, serverProtocolVersion,
   serverMinProtocolVersion }` (AC12). Otherwise send `hello { reqId,
   protocolVersion, apiKey, appVersion }` (AC8).
4. On `hello.ok`: check `limits` against the client bounds (section 6, M1).
   Then store `participantId` and `limits`, record `connectedAt`, and set
   `connected` (AC9). The backoff is **not** reset here (H1). Then run the
   rejoin strategy (section 7).
5. A message other than `welcome` first, or other than `hello.ok`/`error`
   while waiting for it, is a protocol violation (retryable, as for invalid
   frames).
6. After `connected`, a `welcome` or `hello.ok` is an `INVALID_SERVER_MESSAGE`
   and is ignored. It never replaces `participantId` or `limits`, so a
   confused server cannot raise the client's limits mid-session (L8).

### Failure classification (Q4, AC14)

| Signal | Class | Client error code |
| ------ | ----- | ----------------- |
| `error` in handshake with `INVALID_API_KEY`, `INVALID_APP_VERSION`, `PROTOCOL_TOO_OLD` (`details.minProtocolVersion`), `APP_VERSION_TOO_OLD` (`details.minAppVersion`) | **fatal** | same code, typed details (AC13) |
| Client `checkWelcome` failure | **fatal** | `SERVER_UNSUPPORTED` |
| `error` in handshake with `INVALID_MESSAGE`, `HANDSHAKE_REQUIRED`, `ALREADY_AUTHENTICATED`, or close 4001 with no error frame | **fatal** (see Q-A) | the server code, or `HANDSHAKE_REJECTED` |
| No WebSocket implementation | **fatal** | `NO_WEBSOCKET` |
| `error` `APP_CONNECTION_LIMIT` / close 4003 | retryable | `APP_CONNECTION_LIMIT` |
| `error` `HANDSHAKE_TIMEOUT` / close 4002 | retryable | `HANDSHAKE_TIMEOUT` |
| `error` `INTERNAL_ERROR` during the handshake | retryable | `INTERNAL_ERROR` |
| close 4008 (`TOO_MANY_MESSAGES`) | retryable | `TOO_MANY_MESSAGES` |
| close 1001 `GOING_AWAY` | retryable | `CONNECTION_LOST` |
| HTTP 503 on upgrade (browser and `ws` both report error + close 1006) | retryable | `CONNECTION_LOST` |
| Any other close, socket error, open failure, attempt timeout, invalid server frame | retryable | `CONNECTION_LOST` / `REQUEST_TIMEOUT` / `INVALID_SERVER_MESSAGE` |

For a fatal case the client closes the socket itself right away and does not
wait for the server's close. Fatal is decided by error code first and close
code second, because the server always sends the `error` frame before
closing.

### Backoff (Q3, AC26, H1, M3)

`delay(n) = floor(random() * min(cap, initialDelayMs * 2^(n-1)))`, where `n` is
the `failureStreak` after this failure and `cap` is `maxDelayMs` (10 s).
Defaults: 500 ms, 10 s, unlimited attempts. The result goes through
`setClampedTimeout` (M1).

- **Stability rule (H1).** The streak resets only when a connection that
  reached `connected` drops after it has been up for at least
  `stableAfterMs` (default 10 s): `streakAfterDrop` sets the streak to 0, and
  then the drop counts as failure 1. A drop sooner than that continues the
  sequence (`n + 1`). It is a timestamp comparison at drop time
  (`now - connectedAt`), so no extra timer exists. A server that completes
  the handshake and then drops every socket therefore gets delays with caps
  of 0.5, 1, 2, 4, 8, 10, 10 s ..., not a 0-500 ms loop. The handshake and
  version checks still run on every reconnect (AC27). See Q-D.
- **Busy signals (M3).** For close 1001, 4003 and 4008 (which the client can
  tell apart), the streak is raised to at least 3 before the delay is
  computed, so the first wait has a 2 s cap, not 0.5 s. A 503 on upgrade
  looks like a plain network error in browsers, so it stays on the normal
  sequence. Also proposed, but it needs the user because it changes the Q3
  cap: 4003 uses a 30 s cap instead of 10 s (Q-E).
- **Timeouts count as failures.** Every drop caused by a timeout (attempt
  timeout, `hello`/create/join timeout, the silent-link rule for position
  acks) is a failure: the streak grows (M4).
- **`maxAttempts`** counts `runAttempts` (attempts since the last
  `connect()`). When it would be exceeded, the client goes to
  `closed(gave_up)` with `RECONNECT_FAILED`, and a pending `connect()`
  rejects with it.

With the defaults the 10 s cap is reached on failure 6 (about 5 s into an
outage), and the client keeps trying every 0 to 10 s, so it is still
retrying at 30 s (the lock tolerance).

### On every disconnect (unexpected or `close()`)

- All pending requests are rejected: `CONNECTION_LOST` (unexpected) or
  `CLOSED` (`close()`) (AC17, AC28).
- The throttle is cancelled and its pending position dropped.
- The attempt timer and all request timers are cleared.
- The generation number is bumped, so late events from the old socket are
  ignored.
- **Socket retirement (H2).** The `open`, `message` and `close` handlers are
  removed, but a no-op `error` listener is attached **before** `close()` is
  called, and it stays attached for good. `ws` is an `EventEmitter`: if it
  emitted `'error'` with no listener (for example when a socket still
  `CONNECTING` is closed, or on a late protocol error), Node would throw and
  end the whole host process. Every `socket.close()` and `socket.send()`
  call is in `try/catch`. Some implementations throw on invalid state or
  close codes; such a throw is treated like a socket error (retryable), and
  the client never rethrows it.
- Group handling: see section 7.

`close()` also cancels the reconnect timer, closes the socket with 1000, and
sets `closed(client)`; a pending `connect()` rejects with `CLOSED`. After
`close()`, `vi.getTimerCount()` is 0 (AC28).

## 5. Leader throttling and size checks

### `PositionThrottle` (Q2, AC21)

- Keeps the client-side send times of the last `L` sends in a ring buffer of
  at most `L` entries, where `L = limits.maxLeaderUpdatesPerSecond`. `L` was
  already checked against the client bound (100, M1), and nothing is
  preallocated from an unchecked value.
- Window `W = 1000 ms + 100 ms` (`THROTTLE_SAFETY_MS`). The server counts with
  a sliding 1 s window at *its* receive time, and network jitter can bring two
  sends closer together on arrival. The margin absorbs that, at the cost of
  about 9% of peak rate (5/s becomes 5 per 1.1 s).
- `submit(position)`: store it as `pending` (replacing any older pending).
  If fewer than `L` sends fall inside `W`, send now. Otherwise, if no timer is
  set, schedule one at `oldestSend + W`. When the timer fires, send whatever
  is `pending` then (always the latest). One timer at most.
- Server `RATE_LIMITED` for a position the client sent (matched by `reqId`):
  emit the `error` event (AC23). If nothing newer is pending, put that
  position back as pending and schedule it at `retryAfterMs` clamped to
  `[next window slot, 10 s]`. A missing or invalid `retryAfterMs` (not an own
  property, not finite, negative) means "next window slot" (M1, L1). The same
  position is re-queued at most 3 times (L5). So the group still lands on the
  leader's last page even if limits changed mid-session, and a buggy or
  hostile server cannot turn the re-queue into a send loop.
- Cancelled on disconnect, `close()`, or when the group ends.

### Size and JSON checks (AC22)

`jsonByteLength(v) = new TextEncoder().encode(JSON.stringify(v)).length`. This
matches the server's `Buffer.byteLength(JSON.stringify(v), 'utf8')`:
`JSON.stringify` escapes lone surrogates (ES2019), so both see the same
well-formed string. A parity test covers ASCII, multi-byte, emoji and lone
surrogates.

Order of checks, before anything is queued or sent:

1. Connection (`NOT_CONNECTED`), then group and role (`NOT_IN_GROUP`,
   `NOT_LEADER`, `ALREADY_IN_GROUP` for create/join while `active` or
   `rejoining`). Only one `group.create`/`group.join` may be in flight
   (including an automatic rejoin). A second one is rejected locally with
   `REQUEST_IN_PROGRESS`, and nothing is sent. A buggy app loop then cannot
   flood the server into a 4008 close (L5).
2. `checkJson(value, { maxDepth: MAX_JSON_DEPTH - 1 })` must be `ok`, else
   `INVALID_PAYLOAD`. This also stops `JSON.stringify` on cycles or
   `BigInt`, and keeps the frame within the server's depth limit.
3. Size `> limits.maxMessageBytes` -> `MESSAGE_TOO_LARGE { field, sizeBytes,
   limitBytes }`. A value exactly at the limit is allowed. Checked for
   `metadata` and the initial position on create, and for the position on
   update.

`updatePosition` throws these synchronously. `createGroup`/`joinGroup`
return rejected promises (`joinGroup` also checks that `groupId` is a string
of at most `MAX_GROUP_ID_INPUT_LENGTH` characters; it does not check the
format, so the server stays the only judge of "not found").

## 6. Inbound frame handling (untrusted server input)

1. `typeof data !== 'string'` (binary) -> invalid.
2. Length guard: `data.length > maxInboundChars` -> invalid, not parsed.
   Before `hello.ok`: 8192. After: `2 * maxMessageBytes + 8192`, since
   `group.joined` can carry metadata and a position of up to
   `maxMessageBytes` each. String length in UTF-16 units is never more than
   the UTF-8 byte count, so the guard cannot reject a legal frame.
   `maxMessageBytes` is bounded (below), so the server cannot switch the
   guard off.
3. `JSON.parse` in try/catch -> invalid on failure.
4. `checkJson(frame, { maxDepth: MAX_JSON_DEPTH })` -> invalid unless `ok`.
5. If `frame.type` is a string not in the known set -> ignored (AC10).
6. `parseServerMessage(frame)` -> invalid on failure. Opaque fields pass
   through by reference, because the protocol schemas use `z.custom` (AC20).
7. Dispatch: `reqId` replies go to `RequestTracker`. Unknown `reqId`s are
   ignored: a late `position.ack` after an ack timeout that did not drop the
   socket (M4) is harmless. A late create/join reply cannot happen, because
   those timeouts drop the socket. `position.updated` / `group.ended` for a
   `groupId` other than the current group are ignored. A server `error`
   without `reqId` goes to the `error` event. Every inbound frame, valid or
   not, updates `lastInboundAt` (used by the position-ack rule, M4).

**Client bounds for server numbers (M1, `limits.ts`).** `hello.ok.limits`
values must be positive safe integers within `maxMessageBytes <= 1 MiB`,
`maxLeaderUpdatesPerSecond <= 100` and `maxGroupSize <= 10_000`. These are
far above the server ceilings from #1 (16 KiB, 10/s, 100). Outside that range,
`hello.ok` is an `INVALID_SERVER_MESSAGE` and the attempt is retried with
backoff. Numeric `details` values are read only if `Object.hasOwn`, `typeof
=== 'number'`, `Number.isFinite` and `>= 0`; otherwise they are left out.

`SyncClientError.message` is a fixed text per code. The server's `message`
text is kept in `serverMessage`, cut to 256 characters (L2). Neither ever
includes payloads, metadata, group IDs or the API key.

## 7. Groups and reconnect behavior (Q1, AC15-AC18, AC29)

- `createGroup` -> `group.created` -> group `active` (leader). Resolves
  `{ groupId, role: 'leader', participantId }`.
- `joinGroup` -> `group.joined` -> group `active` (member). Resolves
  `{ groupId, role: 'member', participantId, metadata, hasPosition, position? }`
  (the explicit "no position yet" is `hasPosition: false`).
- Server error replies reject with `SyncClientError` (`source: 'server'`,
  `code`, typed `details`, e.g. `GROUP_FULL { maxGroupSize }`).
- Server `group.ended` -> group `ended { reason: 'leader_disconnected' }`, a
  `groupEnded` event, throttle cancelled.

**On unexpected disconnect:**

- **Leader**: the server ends the group as soon as the leader's socket
  closes, so the client marks the group `ended { reason:
  'leader_disconnected' }` and emits `groupEnded` **at the moment of the
  drop**. That way the app never believes it still leads a group. After
  reconnect it is `connected` with the ended group shown and no new group.
- **Member**: the group becomes `rejoining` (last metadata and position
  kept, so the UI can keep showing the page). After the next `hello.ok`, the
  `memberRejoinByGroupId` strategy sends `group.join(groupId)` through the
  normal request path:
  - `group.joined`: group `active` and a `rejoined` event with the current
    position.
  - `GROUP_NOT_FOUND` or any other error / timeout: group `ended { reason:
    'rejoin_failed', code }` and a `groupEnded` event.

  While `rejoining`, `createGroup`/`joinGroup` fail locally with
  `ALREADY_IN_GROUP`.
- **Ended group, closed client**: an `ended` group stays in the snapshot until
  the next successful create/join, or until `connect()` is called on a closed
  client (which resets the group to `null`). `close()` and a terminal failure
  turn an `active`/`rejoining` group into `ended`, so a closed client never
  shows a live group.

Item 3 replaces `memberRejoinByGroupId` with a token strategy (same
interface: `onDisconnected(group)` -> next group state; `onReady(ctx)` ->
promise of the outcome).

## 8. Errors (`errors.ts`)

```ts
class SyncClientError<C extends ClientErrorCode = ClientErrorCode> extends Error {
  readonly name = 'SyncClientError';
  readonly code: C;
  readonly source: 'client' | 'server';
  readonly fatal: boolean;
  readonly details: ErrorDetailsMap[C];
  readonly request?: 'hello' | 'group.create' | 'group.join' | 'position.update';
  readonly serverMessage?: string;
}
function isSyncClientError<C extends ClientErrorCode>(e: unknown, code?: C): e is SyncClientError<C>;
```

`ClientErrorCode` = every protocol `ErrorCode` plus the client codes
`NOT_CONNECTED`, `CLOSED`, `CONNECTION_LOST`, `REQUEST_TIMEOUT`,
`RECONNECT_FAILED`, `SERVER_UNSUPPORTED`, `HANDSHAKE_REJECTED`,
`NO_WEBSOCKET`, `INVALID_OPTIONS`, `INVALID_PAYLOAD`,
`INVALID_SERVER_MESSAGE`, `REQUEST_IN_PROGRESS` (L5). Local checks reuse protocol codes where the meaning
is the same (`NOT_LEADER`, `NOT_IN_GROUP`, `ALREADY_IN_GROUP`,
`MESSAGE_TOO_LARGE`) with `source: 'client'`.

Typed details: `PROTOCOL_TOO_OLD { minProtocolVersion }`,
`APP_VERSION_TOO_OLD { minAppVersion }`, `SERVER_UNSUPPORTED {...4 versions}`,
`MESSAGE_TOO_LARGE { field, limitBytes, sizeBytes? }`, `RATE_LIMITED {
maxLeaderUpdatesPerSecond, retryAfterMs }`, `GROUP_FULL { maxGroupSize }`,
`INVALID_SERVER_MESSAGE { issues: string[] }`, `INVALID_OPTIONS { field }`.
Others are `undefined`. Server `details` are untrusted (L1, M1): each known
key is read only if `Object.hasOwn(details, key)` and it has the expected
primitive type (numbers also finite and `>= 0`). The result is a fresh object
literal with fixed keys; nothing is spread or `Object.assign`ed from the
server object. Strings in details are capped at 64 characters.

Errors never get a `cause` holding a raw frame, a server object, a payload
or a group ID, so `SyncClientError` objects are safe to send to an error
reporter (L3).

## 9. Logging and README

- Logging (AC32): no `console` anywhere in `src/` (ESLint `no-console`). The
  optional `logger` has `debug/info/warn/error(event: string, fields?:
  LogFields)`, where `LogFields` values are only `string | number |
  boolean`. The client only ever passes fixed event names and safe fields
  (state names, attempt, delay, error code, close code, message type). It
  never passes the API key, URL query string, group ID, participant ID,
  metadata, positions or server message text.
- README (AC31): install (workspace), browser usage, Node usage (inject
  `ws`, or Node's global `WebSocket`), SSR note, full API, events, error codes
  and which are fatal, connection states and the `indicatorOf` table,
  reconnect defaults (including `stableAfterMs` and the busy-signal floor),
  throttling and size checks, logging, and the reconnect/rejoin behavior
  (Q1). Security notes in the README:
  - `wss://` is required; the exact URL rules and `allowInsecureTransport`
    ("local development or private networks only"); never put the API key in
    the URL (M2).
  - Never retry fatal errors automatically; `connect()` after a fatal error
    waits for the backoff anyway (M5).
  - `serverMessage` is untrusted text: never render it as HTML (L2).
  - Treat `groupId` like a password: do not log it, do not send it to error
    reporters or analytics, do not put it in URLs (item 4 defines share
    flows). `SyncClientError` objects are safe to report (L3).
  - `connect()` rejects on failure, so always `catch` it (Node 22+ exits on
    unhandled rejections) (L6).
  - SSR: do not create a client at module scope on the server, and never
    call `connect()` during SSR. Create it in the browser (item 6:
    `getServerSnapshot` returns a constant idle snapshot). In Node, inject a
    small `ws` subclass that passes `{ maxPayload: 1 MiB }`, since `ws`
    buffers frames up to 100 MiB before the client's length guard runs (L7).
  - Members get no liveness check from the client in this issue (see
    section 12).

## 10. Test plan

Runner: vitest 4 (as in protocol and server); `pnpm test` runs it through
`pnpm -r test`. Unit tests use `FakeWebSocket` and `vi.useFakeTimers()`.
Integration tests (`test/integration/*.int.test.ts`) use the real server on
`127.0.0.1:0` with test apps (keys of 32+ chars, chosen limits) and inject `ws`,
except where noted. `test/setup.ts` fails a file on any unhandled rejection.

| AC | Test(s) |
| -- | ------- |
| AC1 | `package.test.ts`: `package.json` has only `@sync-system/protocol` in `dependencies`; scans `src/**` for `node:`/`ws`/`react`/`vue` imports. `tsconfig.build.json` with `types: []` plus ESLint restrictions enforce it at build/lint time. |
| AC2 | CI (`pnpm lint`, `typecheck`, `test`, `build` from root; unchanged workflow). Manual: `docker build -f apps/sync-server/Dockerfile .` still succeeds. |
| AC3 | `package.test.ts`: imports `../src/index.js` and checks every public runtime export; `package.json` `exports` has `types` and `default` pointing into `dist`. The CI build step proves `dist/index.js` and `dist/index.d.ts` are emitted. |
| AC4 | `environment.test.ts`: `vi.stubGlobal('WebSocket', FakeWebSocket)`, `connect()` constructs it with the URL. `integration/native-websocket.int.test.ts`: full handshake + create/join/update using Node's global (WHATWG) `WebSocket`, no injection. |
| AC5 | `integration/*`: every other integration test injects `ws`. |
| AC6 | `environment.test.ts`: global `WebSocket` stubbed `undefined`, no injection: constructor does not throw; `connect()` rejects `NO_WEBSOCKET` (`isSyncClientError`), state `closed(fatal)`, never a `ReferenceError`. |
| AC7 | `ssr-import.test.ts`: `vi.resetModules()`, removes `WebSocket` from `globalThis`, installs throwing getters for `window`, `document`, `navigator`, `location`, `localStorage`, `WebSocket`, spies on `setTimeout`/`setInterval`/`queueMicrotask`, then `await import('../src/index.js')`: no throw, no getter hit, no timer, `vi.getTimerCount() === 0`. Also creates a `SyncClient` without connecting: still no access. |
| AC8 | `client.handshake.test.ts`: waits for `welcome`; `hello` has `protocolVersion: 1`, `apiKey`, `appVersion`; `connect()` resolves only after `hello.ok`. Integration: `handshake.int`. |
| AC9 | Same: `participantId` and `limits` in the resolved value, the `connected` state and the snapshot. |
| AC10 | `client.inbound.test.ts`: unknown `type` is ignored (no event, no error, still connected); a known type with a bad shape, binary, non-JSON, too deep and too long frames each emit `INVALID_SERVER_MESSAGE` and no typed event; a bad frame with a pending `reqId` rejects that request; an invalid `welcome` triggers reconnect. |
| AC11 | `client.requests.test.ts`: `createGroup`/`joinGroup`/`updatePosition` in `idle`, `connecting`, `reconnecting`, `closed` fail with `NOT_CONNECTED`, and the fake socket recorded no group frame. |
| AC12 | Unit: `checkWelcome` table (server min above client, server below client min, equal). `client.handshake.test.ts` (fake socket, since the real server always sends protocol 1): no `hello` sent, socket closed, `SERVER_UNSUPPORTED` with the 4 versions, `closed(fatal)`. |
| AC13 | `versions.int`: app `minAppVersion: '2.0.0'` + client `1.0.0` -> `APP_VERSION_TOO_OLD { minAppVersion: '2.0.0' }`. `PROTOCOL_TOO_OLD`: fake-socket test (the real client cannot send an old protocol), with `details.minProtocolVersion`. Bad key -> `INVALID_API_KEY`; `appVersion: 'nope'` -> `INVALID_APP_VERSION` (both against the real server). |
| AC14 | `versions.int` + unit: after each fatal code, advance fake timers by 10 min / wait 2 s real: exactly one socket constructed, state `closed(fatal)`, `connect()` rejected. |
| AC15 | `groups.int`: `createGroup` resolves `{ groupId, role: 'leader' }`; unit: server error reply rejects with that code. |
| AC16 | `groups.int`: join with and without an initial position (`hasPosition` true/false); `GROUP_NOT_FOUND`, `GROUP_FULL` (`maxGroupSize: 2`), `ALREADY_IN_GROUP` (forced through a fake socket, since the client blocks it locally). |
| AC17 | `client.requests.test.ts`: two overlapping requests (a `group.join` and a `position.update`, since only one group request may be in flight) answered in reverse order settle correctly; a drop rejects pending ones with `CONNECTION_LOST`; no reply to create/join in 10 s gives `REQUEST_TIMEOUT` and a reconnect (M4 cases in the security table). |
| AC18 | Unit + `groups.int`: member and groupless `updatePosition` throw `NOT_LEADER`/`NOT_IN_GROUP` and nothing is sent. |
| AC19 | `client.events.test.ts`: each event fires with the right payload; unsubscribe (both `on()`'s return value and `off`) and unsubscribe during an emit; a throwing listener does not break other listeners or the client. `groups.int`: member receives `positionUpdated` deep-equal; `groupEnded` on leader disconnect. |
| AC20 | `opaque.int`: metadata and positions with nested arrays, unicode, `null`s, extra fields and a `__proto__` key arrive deep-equal (`toStrictEqual`) at the member, in `group.joined`, `positionUpdated` and the snapshot. |
| AC21 | `throttle.test.ts` (fake timers): 50 submits in 1 s at limit 5 -> at most 5 sends in any 1.1 s window; the last send is the last value; one timer at most; `RATE_LIMITED` puts it back. `throttle.int`: real server, `maxLeaderUpdatesPerSecond: 5`, 50 updates over 1 s, then wait: no `RATE_LIMITED` error event, the member's last `positionUpdated` equals the last value. |
| AC22 | `json-size.test.ts` (parity with `Buffer.byteLength`); unit: exactly-at-limit passes, one over throws `MESSAGE_TOO_LARGE` and sends nothing (update, create metadata, create position). `limits.int`: same against the real server with `maxMessageBytes: 256`. |
| AC23 | Unit (fake socket): server `RATE_LIMITED` and `MESSAGE_TOO_LARGE` replies to a `position.update` give typed `error` events, the client stays `connected`. |
| AC24 | `client.state.test.ts`: full sequence of `state` events and `getState()` values: `idle -> connecting -> connected -> reconnecting(attempting false/true) -> connected -> closed(client)`; `closed(fatal)` and `closed(gave_up)`; snapshot identity is stable with no change and new after a change. |
| AC25 | `state.test.ts`: `indicatorOf` table from section 3, every row. README has the table (reviewed). |
| AC26 | `backoff.test.ts`: with `random = () => 1` delays are 500, 1000, 2000, 4000, 8000, 10000, 10000; with `0` all 0; with `0.5` half; never above the cap; busy-signal floor (M3). `client.reconnect.test.ts`: for close 1006, 1001, 4003, 4008, 4002 and an open error, a new socket is constructed after the timer; `maxAttempts: 3` leads to `closed(gave_up)` with `RECONNECT_FAILED`. `reconnect.int`: server closed (1001) and restarted on the same port, and abnormal drops through `tcp-proxy`; the client is `connected` again. `caps.int`: `MAX_CONNECTIONS=1` (503) and app `maxConnections: 1` (4003) keep the client retrying, and it connects once the slot is free. |
| AC27 | `client.reconnect.test.ts`: after a reconnect that stays up for `stableAfterMs`, the next drop starts at attempt 1 again (H1 timing in the security table); a second `welcome` and `hello` are sent on each reconnect, and a server that now answers with an unsupported `welcome` gives `SERVER_UNSUPPORTED`. |
| AC28 | `client.close.test.ts` (fake timers): `close()` during `connecting`, `connected` with a pending request and a throttled update, and `reconnecting`: socket closed with 1000, pending rejected `CLOSED`, `connect()` rejected `CLOSED`, `vi.getTimerCount() === 0`, and no socket constructed after advancing 1 h. `close.int` against the real server. |
| AC29 | `client.rejoin.test.ts` + `reconnect.int`: member drop -> `rejoining` -> `rejoined` with the current position (leader still connected through another client), or `groupEnded { reason: 'rejoin_failed', code: 'GROUP_NOT_FOUND' }` when the group is gone. Leader drop -> `groupEnded { reason: 'leader_disconnected' }` at the drop; after reconnect `connected`, group `ended`, no `group.join` sent. |
| AC30 | `test/integration/*.int.test.ts` as listed above: handshake, versions, groups, opaque, throttle, limits, reconnect, caps, close, native-websocket, flapping (H1). |
| AC31 | README review in QA, plus `readme.test.ts`: README mentions every exported error code and every connection state (cheap drift guard). |
| AC32 | `logging.test.ts`: spies on all `console` methods during a full fake-socket flow (connect, create, update, reconnect, fatal): zero calls. A recording logger over the same flow: no entry contains the API key, a group ID, or a marker string placed in metadata/position. ESLint `no-console` in `src`. |

### Security control tests

| Finding | Test(s) |
| ------- | ------- |
| H1 | `client.reconnect.test.ts` (fake socket, fake timers): the handshake completes and the socket closes 100 ms later, five times in a row; the delay caps grow 500, 1000, 2000, 4000, 8000 (checked with `random = () => 1`), never reset. A drop after `stableAfterMs` starts at attempt 1. A timeout-caused drop grows the streak. `integration/flapping.int.test.ts`: `tcp-proxy` cuts each connection 100 ms after it opens; over 3 s the client makes at most 4 connection attempts (instead of the about 12 a reset-on-`hello.ok` client would make). |
| H2 | `ws-safety.int.test.ts` with injected `ws` (not the fake socket): attempt timeout while `CONNECTING` against `blackhole-server`; `close()` while `CONNECTING`; a socket whose `close()` and `send()` throw (fake). `test/setup.ts` fails the file on any uncaught exception, and the process survives. |
| M1 | `limits.test.ts` / `client.inbound.test.ts`: `hello.ok` with `maxMessageBytes: 2**53`, `maxLeaderUpdatesPerSecond: 1e6`, `0`, `1.5` -> `INVALID_SERVER_MESSAGE` and retry. `throttle.test.ts`: `retryAfterMs` of `1e12`, `-1`, `"5"`, missing -> delay within `[slot, 10 s]`. `options.test.ts`: `Infinity`, `NaN`, `-1`, `2**31` for every `*Ms` option -> `INVALID_OPTIONS`; `maxAttempts: Infinity` accepted. `host.test.ts`: `setClampedTimeout` clamps. |
| M2 | `url-policy.test.ts`: rejected: `ws://localhost.attacker.example`, `ws://127.0.0.1.nip.io`, `ws://user@localhost@host`, `ws://user:pw@localhost`, `wss://host/#x`, `https://host`, `http://localhost`, `ftp://x`, `ws://example.com` (without opt-out), `allowInsecureTransport: 'true'` (string). Accepted: `wss://example.com`, `WS://LOCALHOST`, `ws://127.0.0.1:8080/ws`, `ws://[::1]:8080`, `ws://example.com` with `allowInsecureTransport: true`. |
| M3 | `backoff.test.ts`: close 1001/4003/4008 start with a 2 s cap; 1006 starts with 0.5 s. |
| M4 | `client.requests.test.ts`: `position.update` without ack for 20 s while other frames arrive -> `error` event `REQUEST_TIMEOUT`, still `connected`, no new socket; without any inbound frame for 10 s -> drop and reconnect, and the streak grows. `hello`/create/join timeout -> drop. |
| M5 | `client.close.test.ts`: after `closed(fatal)` (`INVALID_API_KEY`), calling `connect()` in a loop 20 times inside 1 s (fake timers) constructs at most 1 new socket; the state is `reconnecting` with a delay; after `closed(gave_up)` the same holds. `connect()` after `close()` with streak 0 connects at once. |
| L1 | `errors.test.ts`: `{"details":{"__proto__":{"retryAfterMs":1}}}` and inherited props give no `retryAfterMs`; the result object has only fixed keys. |
| L2 | `errors.test.ts`: a 10 KB server `message` is cut to 256 chars; 50 schema issues are cut to 10. `client.inbound.test.ts`: unknown type `"<script>"` is logged as `"(invalid)"`. |
| L3 | `errors.test.ts`: `JSON.stringify(error)` and `error.cause` contain no group ID or payload marker. |
| L4 | `client.events.test.ts`: `JSON.stringify(client)`, `Object.keys(client)` and `util.inspect(client)` do not contain the API key; a throwing listener's message is not logged, only its `name`. |
| L5 | `client.requests.test.ts`: a second `joinGroup` while one is pending -> `REQUEST_IN_PROGRESS`, one frame sent. `throttle.test.ts`: the same position is re-queued at most 3 times. |
| L6 | `client.close.test.ts`: fatal error, gave-up, `close()` during connect and rejoin failure, with the app's `connect()` promise caught but nothing else: no unhandled rejection (setup check). |
| L7 | README review (QA). |
| L8 | `client.inbound.test.ts`: `hello.ok` with bigger limits and a new `participantId` after `connected` -> `INVALID_SERVER_MESSAGE`, snapshot unchanged. |

## 11. Security-sensitive areas

Security-sensitive: yes

- **Secrets (API key)**: kept in a `#private` field. It is never put in the
  snapshot, errors, events or logs, and is sent only in `hello`
  (`options.ts`, `client.ts`, `logger.ts`). The key is public for browser
  apps (see #1 `security.md`), but may be private for Node/native apps.
- **Transport security (M2, Q-B)**: `checkServerUrl` in `url-policy.ts`
  runs in the constructor and fails closed with `INVALID_OPTIONS { field:
  'url' }`. Without these rules the key, group IDs (which work like bearer
  capabilities in #1) and reading positions could travel unencrypted. The
  rules:
  - Parse with `new URL(url)`; a parse failure is rejected.
  - `protocol` must be `wss:` or `ws:`. `http:`, `https:` (which WHATWG
    `WebSocket` now accepts) and everything else are rejected.
  - `ws:` only when `hostname` is exactly `localhost`, `127.0.0.1` or
    `[::1]` (how `URL` reports IPv6), compared after `URL` lowercases it.
    No prefix/substring checks and no DNS. Otherwise only with
    `allowInsecureTransport === true` (strict boolean).
  - URLs with `username`, `password` or a `hash` are rejected.
- **Untrusted server input**: every frame goes through the length guard,
  `JSON.parse` in try/catch, iterative depth check and schema; unknown types
  are ignored; server `details` are copied field by field with type checks;
  opaque data is never read or merged into client objects (no prototype
  pollution: the client never `Object.assign`s server objects) (`transport.ts`,
  `errors.ts`).
- **Resource use and the server's limits**: backoff with full jitter (no
  thundering herd after a server restart), reset only after a stable
  connection (H1), a floor for busy signals (M3), fatal codes stop
  reconnects, `connect()` after a fatal error still waits (M5), position-ack
  timeouts do not end groups on a slow server (M4), leader throttling keeps
  under the rate limit, one group request in flight (L5), and all timers are
  clamped (M1) (`backoff.ts`, `throttle.ts`, `requests.ts`, `host.ts`).
- **Host process safety (H2)**: a `ws` socket always has an `error` listener,
  and `send`/`close` never throw out of the client (`transport.ts`). Internal
  promises always have handlers (L6).
- **Privacy in logs**: no logging by default; the logger allowlist excludes
  key, group IDs, participant IDs, payloads and metadata (`logger.ts`).
- **Dependencies**: runtime adds only the workspace `@sync-system/protocol`
  (which brings `zod`, already used). Dev only: `ws`, `@types/ws`,
  `@types/node`, `vitest`, `typescript`, workspace `@sync-system/server`, all
  at versions already in the lockfile. `pnpm audit` in CI covers them.
- **Build file**: Dockerfile adds one manifest `COPY`; the runtime image is
  unchanged.

### Security controls (finding -> plan section -> commit)

Required (high, blocking):

| Finding | Control | Plan section | Commit |
| ------- | ------- | ------------ | ------ |
| H1 | Backoff resets only after `stableAfterMs` (10 s) connected; drops before that continue the sequence; timeout drops grow the streak | 1 (decision 6), 4 Backoff | 7, 16 (tests 16, 20) |
| H2 | Every socket keeps a no-op `error` listener forever; `send`/`close` in `try/catch`; tests with injected `ws` against a TCP server that never upgrades | 1 (decision 6), 4 On every disconnect | 11, 12 |

Recommended (medium/low; folded in, the user can drop any at Gate 2):

| Finding | Control | Plan section | Commit |
| ------- | ------- | ------------ | ------ |
| M1 | `hello.ok` limits bounded (1 MiB, 100/s, 10,000); numeric details own-property + finite + `>= 0` + clamp; `*Ms` options in `[0, 2^31-1]`; one `setClampedTimeout`; throttle ring buffer | 3 Options, 5, 6 | 2, 3, 4, 9, 11 |
| M2 | Exact URL rules: `new URL`, `ws:`/`wss:` only, exact loopback hostnames, no userinfo/hash, strict boolean opt-out | 11 | 5 |
| M3 | Busy signals 1001/4003/4008 start at a 2 s cap (4003 30 s cap is Q-E) | 4 Backoff | 7 |
| M4 | `position.update` timeout (20 s) only emits an error, and drops only if nothing was received for `requestTimeoutMs`; hello/create/join timeouts drop; timeout drops count toward backoff | 1 (decision 5), 4, 6 | 10, 16 |
| M5 | `connect()` does not reset the backoff; after `closed(fatal\|gave_up)` it waits the next delay; README warns | 1 (AC24 notes), 4 | 18, 21 |
| L1 | `Object.hasOwn` + `typeof` reads of `details`, fresh fixed-key objects | 8 | 2 |
| L2 | `serverMessage` <= 256 chars, issues <= 10, unknown types logged only if `/^[a-z.]{1,64}$/`; README: never render as HTML | 1 (AC10), 6, 8, 9 | 2, 11, 21 |
| L3 | No `cause` with raw data; README: treat `groupId` like a password | 8, 9 | 2, 21 |
| L4 | Options object not stored; listener errors logged by `name` only | 2, 3 Options | 4, 14 |
| L5 | One group request in flight (`REQUEST_IN_PROGRESS`); `RATE_LIMITED` re-queue at most 3 times | 5 | 9, 15 |
| L6 | Internal promises always handled; README: `catch` `connect()` | 2, 9 | 10, 14, 21 |
| L7 | README: no SSR singletons, no `connect()` in SSR; `ws` `maxPayload` wrapper for Node | 9 | 21 |
| L8 | `welcome`/`hello.ok` after `connected` -> `INVALID_SERVER_MESSAGE`, ignored | 4 | 13 |

## 12. Risks and edge cases

- **Network jitter vs. the server's sliding window**: handled by the 100 ms
  margin plus putting a rate-limited position back. The integration test runs
  on loopback, so the margin is not stressed there; the unit test covers the
  re-queue.
- **Half-open connections for a member who only listens**: a member sends
  nothing, so no request timeout applies to it. A silent dead link is only
  noticed when the OS reports it. Browsers cannot see server pings. Item 5
  (keep-alive) is the place for an app-level ping; noted in the README.
- **Position-ack rule on a stalled server (M4)**: a stall longer than
  `requestTimeoutMs` with no inbound frames at all still drops the leader's
  socket after the 20 s ack timeout. That is a dead link for practical
  purposes, and the drop counts toward backoff.
- **Restart on the same port in tests** can fail with `EADDRINUSE` on some
  hosts. The helper retries `listen` a few times over about 1 s. Abnormal
  drops and the flapping test use `tcp-proxy`, which needs no restart.
  Test-only either way.
- **Timing-based tests (H1 flapping, throttle)** on slow CI machines: the
  integration assertions use upper bounds with slack (for example "at most 4
  attempts in 3 s"). The exact sequences are checked in the fake-timer unit
  tests.
- **Clock jumps (phone sleep)**: timers may fire late after a screen lock.
  Backoff and throttling only need "not earlier than", so late timers are
  safe. The throttle uses the timer, not wall-clock math, for the next send.
- **Listener re-entrancy**: an app calling `close()` or `createGroup()` inside
  a listener. The emitter iterates over a copy, and state is updated before
  emitting, so re-entrant calls see consistent state.
- **Importing `@sync-system/server` src in client tests**: the server package
  has no `exports` map, so deep imports work for vitest and `tsc`. If
  resolution fails, the helper falls back to relative imports
  (`../../../../apps/sync-server/src/...`). Either way it is test-only.
- **Dockerfile frozen install**: without the added manifest `COPY`, the
  frozen install could fail on the new lockfile importer. Verified manually
  (see AC2).

## 13. Implementation chunks (planned commits)

Each `feat` commit includes the unit tests for that module.

1. `build(client): scaffold @sync-system/client workspace package` (package.json, tsconfigs, vitest config, setup, empty index, lockfile, ESLint block, Dockerfile manifest copy)
2. `feat(client): add typed client errors and error codes` (L1, L2, L3, M1 details)
3. `feat(client): add lazy host globals and clamped timers` (AC7 SSR test, M1 `setClampedTimeout`)
4. `feat(client): add client options with defaults and validation` (M1 ranges, L4)
5. `feat(client): enforce wss and exact loopback rules for server urls` (M2)
6. `feat(client): add exponential backoff with full jitter` (Q3)
7. `feat(client): add backoff stability window and busy-signal floor` (H1 helper, M3)
8. `feat(client): add json byte length matching the server measure`
9. `feat(client): add leader position throttle with trailing send` (M1 ring buffer and clamp, L5 re-queue cap)
10. `feat(client): add request tracker with reqid matching and timeouts` (M4 timeout kinds, L6)
11. `feat(client): add transport with inbound frame validation` (AC10, M1 bounds, L2)
12. `feat(client): keep an error listener on every websocket` (H2, `blackhole-server` helper, `ws-safety.int` test)
13. `feat(client): add handshake and server version checks` (AC12-AC14, Q-A, L8)
14. `feat(client): add sync client connect, state snapshot and events`
15. `feat(client): add group create, join and position updates` (L5 one group request in flight)
16. `feat(client): add automatic reconnect with stability window` (H1, M3, M4 drop rules)
17. `feat(client): add member rejoin after reconnect` (Q1, AC29)
18. `feat(client): delay connect after a fatal or gave-up close` (M5)
19. `feat(client): add connection indicator helper`
20. `test(client): add integration tests against the real sync server` (incl. `tcp-proxy`, flapping H1)
21. `docs(client): add client package readme` (security notes M2, M5, L2, L3, L6, L7)
22. `docs: list the client package in the root readme`

## 14. Questions for Gate 2

- **Q-A. Other handshake rejections are fatal.** Q4 does not cover
  `INVALID_MESSAGE`, `HANDSHAKE_REQUIRED`, `ALREADY_AUTHENTICATED`, or a bare
  close 4001. Proposed: fatal, because the same `hello` always gets the same
  answer, so retrying would loop forever. `HANDSHAKE_TIMEOUT` (4002),
  `APP_CONNECTION_LIMIT` (4003), `TOO_MANY_MESSAGES` (4008) and
  `INTERNAL_ERROR` during the handshake stay retryable. This depends on M5
  (`connect()` after a fatal error still waits for the backoff), so an app
  cannot turn "fatal" back into a loop. Security agrees. Confirm.
- **Q-B. `wss://` required for non-loopback hosts**, with the exact M2 URL
  rules (section 11) and the strict-boolean opt-out `allowInsecureTransport`.
  This is not in the spec. Security agrees strongly. Confirm, or drop the
  check.
- **Q-C. Request timeouts** (section 1, decision 5, refined by M4):
  `hello`/create/join timeouts (10 s) reject and drop the socket.
  `position.update` ack timeouts (20 s) only emit `REQUEST_TIMEOUT`, and drop
  only if nothing at all was received from the server for the last 10 s.
  Every timeout-caused drop counts toward backoff. This goes beyond the
  spec's "typed timeout error". Confirm.
- **Q-D. AC27 "after a successful reconnect the backoff resets" (H1).** The
  plan reads "successful" as "stayed connected for `stableAfterMs` (10 s)".
  The handshake still repeats on every reconnect. This is a required security
  control. Confirm this reading of AC27.
- **Q-E. 30 s cap for `APP_CONNECTION_LIMIT` (4003) (M3).** Gate 1 Q3 set a
  10 s max delay. Proposed: keep 10 s for everything else, but use 30 s for
  4003 (the app is at its connection cap, so retrying faster only adds
  rejected handshakes). The 2 s first-wait floor for 1001/4003/4008 stays
  inside the Q3 cap and is planned either way. Confirm or keep 10 s.

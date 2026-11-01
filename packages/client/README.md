# @sync-system/client

Framework-free TypeScript client for the sync server. It works in browsers and
Node, and is safe to import during server-side rendering. It handles the
connection life cycle, the handshake and version checks, typed group calls and
events, leader throttling, size checks, and reconnects with backoff. The React
package (item 6) builds on its snapshot/subscribe API.

Runtime dependency: `@sync-system/protocol` only. No UI framework, no
Node-only module.

## Install

It is a workspace package (not published yet):

```jsonc
// package.json of an app in this repo
{ "dependencies": { "@sync-system/client": "workspace:*" } }
```

## Browser usage

```ts
import { SyncClient, indicatorOf, isSyncClientError } from '@sync-system/client';

const client = new SyncClient({
  url: 'wss://sync.example.com/ws',
  apiKey: 'your-app-key', // sent only in the handshake; never put it in the URL
  appVersion: '1.4.0', // your app's semver version
});

client.on('positionUpdated', ({ position }) => showPage(position));
client.on('groupEnded', ({ reason }) => showGroupEnded(reason));
client.subscribe(() => renderIndicator(indicatorOf(client.getSnapshot())));

try {
  await client.connect();
  const { groupId } = await client.createGroup({ book: 'moby-dick' }, { page: 1 });
  client.updatePosition({ page: 2 });
} catch (error) {
  if (isSyncClientError(error, 'APP_VERSION_TOO_OLD')) askUserToUpdate();
}
```

The browser's global `WebSocket` is used by default (read when `connect()`
runs, not at import).

## Node usage

Node 22+ has a global WHATWG `WebSocket`, which works with no options. You can
also inject the `ws` package. `ws` buffers frames up to 100 MiB before the
client's own length guard runs, so pass a smaller `maxPayload`:

```ts
import { WebSocket } from 'ws';
import { SyncClient } from '@sync-system/client';

class SmallWs extends WebSocket {
  constructor(url: string) {
    super(url, { maxPayload: 1024 * 1024 });
  }
}

const client = new SyncClient({ url, apiKey, appVersion: '1.0.0', WebSocket: SmallWs });
```

Any constructor that fits the WHATWG subset in `WebSocketLike` works.

If no `WebSocket` exists and none is injected, the constructor still works and
`connect()` rejects with `NO_WEBSOCKET` (never a `ReferenceError`).

## Server-side rendering

Importing the package has no side effects: no globals are read, no timers
start, no socket opens. This covers the whole import graph: the protocol
schemas are built in zod's `jitless` mode, so zod never reads `navigator` or
calls `new Function` (also safe under a CSP without `unsafe-eval`). Still:

- Do not create a client at module scope on an SSR server: it would be shared
  by every request and user.
- Never call `connect()` during SSR. Create the client in the browser (item 6:
  `getServerSnapshot` returns a constant idle snapshot).

## API

### `new SyncClient(options)` / `createSyncClient(options)`

Validates the options and throws `INVALID_OPTIONS` (with `details.field`) on a
bad value. The options object is not kept; the API key lives in a private
field and never appears in `JSON.stringify`, `util.inspect`, the snapshot,
errors, events or logs.

| Option                     | Default            | Notes                                                                  |
| -------------------------- | ------------------ | ---------------------------------------------------------------------- |
| `url`                      | required           | `wss://...`. See "Transport security".                                 |
| `apiKey`                   | required           | 1 to 256 characters.                                                   |
| `appVersion`               | required           | 1 to 256 characters; the server checks semver.                         |
| `WebSocket`                | global `WebSocket` | Constructor to use (`ws`, a wrapper, a test fake).                     |
| `reconnect.initialDelayMs` | `500`              | First backoff cap. At least 100.                                       |
| `reconnect.maxDelayMs`     | `10000`            | Largest backoff cap. At least 1000 and at least `initialDelayMs`.      |
| `reconnect.maxAttempts`    | `Infinity`         | Reconnect attempts per `connect()` run (reset by a stable connection). |
| `reconnect.stableAfterMs`  | `10000`            | Connected this long before the backoff resets. At least 1000.          |
| `requestTimeoutMs`         | `10000`            | Open + handshake, create and join. Position acks wait twice this.      |
| `allowInsecureTransport`   | `false`            | Must be exactly `true` to allow `ws://` to a non-loopback host.        |
| `logger`                   | none               | Opt-in logger, see "Logging".                                          |
| `random`                   | `Math.random`      | Jitter source in `[0, 1)`; tests inject it.                            |

Every `*Ms` value must be a finite number up to 2^31-1 ms.

### Methods

| Method                                         | Returns                       | Notes                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                                    | `Promise<ConnectedInfo>`      | Resolves on `hello.ok` with `{ participantId, limits }`. Returns the current attempt if one is running. Rejects on a fatal error, `close()` or giving up: always `catch` it. |
| `close()`                                      | `void`                        | Idempotent. Closes the socket (1000), rejects pending requests and `connect()` with `CLOSED`, stops every timer. Never reconnects by itself.                                 |
| `createGroup(metadata, initialPosition?)`      | `Promise<CreatedGroup>`       | `{ groupId, role: 'leader', participantId }`.                                                                                                                                |
| `joinGroup(groupId)`                           | `Promise<JoinedGroup>`        | `{ groupId, role: 'member', participantId, metadata, hasPosition, position? }`. `hasPosition: false` means "no position yet".                                                |
| `updatePosition(position)`                     | `void`                        | Leader only. Throws local errors synchronously; server rejections arrive as `error` events.                                                                                  |
| `getState()`                                   | `ConnectionState`             | Same as `getSnapshot().connection`.                                                                                                                                          |
| `getSnapshot()`                                | `SyncClientSnapshot`          | `{ connection, group }`, frozen, same object until something changes.                                                                                                        |
| `subscribe(listener)`                          | unsubscribe function          | Called after every snapshot change. Fits `useSyncExternalStore`.                                                                                                             |
| `on(event, listener)` / `off(event, listener)` | unsubscribe function / `void` | Typed events, below.                                                                                                                                                         |

Group calls made while not `connected` fail at once with `NOT_CONNECTED`;
nothing is queued, and nothing is ever sent before `hello.ok`. Only one
`createGroup`/`joinGroup` may be in flight; another one fails locally with
`REQUEST_IN_PROGRESS`.

Metadata and positions are opaque: the client never reads or changes their
fields, and passes the received objects through as they are.

### Events

| Event             | Payload                      | When                                                                                                                        |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `state`           | `ConnectionState`            | Every connection-state change.                                                                                              |
| `positionUpdated` | `{ groupId, position }`      | A member receives the leader's position.                                                                                    |
| `groupEnded`      | `{ groupId, reason, code? }` | `leader_disconnected` (server `group.ended`, or the leader's own socket dropped), `rejoin_failed`, or `closed` (`close()`). |
| `rejoined`        | `JoinedGroup`                | A member got back into its group after a reconnect.                                                                         |
| `error`           | `SyncClientError`            | Errors not tied to a promise: each failed connection attempt, server rejections of position updates, invalid server frames. |

A listener that throws does not affect other listeners or the client. A
listener removed during an emit is not called.

Listeners (and `subscribe` callbacks) may call `close()` or `connect()`. The
client stops what it was doing at once: a `close()` from a `groupEnded`,
`state` or `subscribe` callback during a drop leaves `closed(client)` with no
timer and no new socket. A `connect()` from a `closed` listener starts a new
run with its own promise; the promise of the run that just ended still
settles with that run's outcome.

When a listener's `close()` or `connect()` cuts a fatal error or a
give-up short, the client does not emit the `error` event for that
failure. A call from a `closed` state listener comes after the failure was
recorded, so the `closed` state's `error` and the rejected `connect()`
promise still carry it. A call made earlier (for example from `groupEnded`)
replaces the failure: the run ends the way that `close()` or `connect()`
ends it. Read failures from the `closed` state or the `connect()` promise,
not only from `error` events.

## Connection states

`ConnectionState` is a union on `status`:

| `status`       | Fields                                        | Meaning                                                                             |
| -------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `idle`         |                                               | Created; `connect()` not called yet.                                                |
| `connecting`   |                                               | First attempt after `connect()`: socket opening and handshake.                      |
| `connected`    | `participantId`, `limits`                     | `hello.ok` received; group calls are allowed.                                       |
| `reconnecting` | `attempt`, `delayMs`, `retryAt`, `attempting` | Waiting for the backoff timer (`attempting: false`) or retrying (`true`).           |
| `closed`       | `reason`, `error?`                            | `reason` is `client` (`close()`), `fatal` or `gave_up`. Terminal until `connect()`. |

`GroupState` (in `snapshot.group`) is `active` (with `role`, `metadata`,
`hasPosition`, `position`), `rejoining` (a member waiting to get back in), or
`ended` (with `reason` and `code?`). It is `null` before any group, and again
after `connect()` on a closed client.

### Indicator mapping

`indicatorOf(snapshot)` gives the PRD's sync indicator:

| Snapshot                                                              | Indicator        |
| --------------------------------------------------------------------- | ---------------- |
| group `ended` (any connection state), except reason `closed`          | `leader_offline` |
| connection `connecting`/`reconnecting`, group `active` or `rejoining` | `reconnecting`   |
| connection `connected`, group `rejoining`                             | `reconnecting`   |
| connection `connected`, group `active`, role `member`                 | `following`      |
| connection `connected`, group `active`, role `leader`                 | `leading`        |
| anything else (no group, idle, closed, group ended by `close()`)      | `none`           |

In this version a leader disconnect ends the group, so `leader_offline` means
"group ended". Item 5 adds a grace period on top.

## Reconnect and groups

After an unexpected disconnect the client reconnects by itself, and repeats
the handshake and version checks every time.

- **Leader:** the server ends the group as soon as the leader's socket
  closes. The client marks the group `ended` (`leader_disconnected`) and emits
  `groupEnded` at the moment of the drop. After reconnecting it is
  `connected` with no group; it never re-creates one.
- **Member:** the group becomes `rejoining`, keeping the last metadata and
  position. After the next `hello.ok` the client sends `group.join` for the
  same group ID. Success: the group is `active` again and `rejoined` carries
  the current position. Any error or timeout (for example `GROUP_NOT_FOUND`):
  the group is `ended` (`rejoin_failed`, with the code) and `groupEnded` fires.
- `close()`, a fatal error and giving up turn an `active` or `rejoining` group
  into `ended`, so a closed client never shows a live group.

### Backoff

`delay = floor(random() * min(maxDelayMs, initialDelayMs * 2^(n-1)))`, where
`n` is the failure streak. With the defaults the caps are 0.5, 1, 2, 4, 8, 10,
10 s ..., so the client is still retrying 30 s into an outage.

- **Stability window:** the streak resets only after a connection stayed
  `connected` for `reconnect.stableAfterMs` (10 s). A server that accepts the
  handshake and then drops every socket gets growing delays, not a tight loop.
  The same rule resets the `maxAttempts` count.
- **Busy signals:** close 1001 (server going away), 4003
  (`APP_CONNECTION_LIMIT`) and 4008 (`TOO_MANY_MESSAGES`) start at a 2 s cap.
  After 4003 the largest cap is 30 s. An HTTP 503 on upgrade looks like a
  network error and stays on the normal sequence.
- **Timeouts count as failures:** a timeout that drops the socket grows the
  streak.
- **`maxAttempts`:** when used up, the client goes to `closed(gave_up)` with
  `RECONNECT_FAILED`. After `closed(fatal)` or `closed(gave_up)`, the first
  socket of the next `connect()` run already counts as reconnect attempt 1
  (it waits the backoff), so that run opens at most `maxAttempts` sockets,
  one fewer than a run started from `idle`.
- **`connect()` does not reset the backoff.** After `closed(fatal)`,
  `closed(gave_up)` or recent failures, `connect()` first waits the next
  backoff delay (state `reconnecting`). Through `close()` + `connect()`, two
  sockets are never opened less than `initialDelayMs` apart.

### Request timeouts

- Open + handshake, `group.create`, `group.join`: no reply within
  `requestTimeoutMs` (10 s) rejects with `REQUEST_TIMEOUT` and drops the
  socket, then reconnects (this detects half-open connections and avoids
  orphan groups).
- `position.update`: no ack within twice that (20 s) emits an `error` event
  with `REQUEST_TIMEOUT`. The socket is dropped only if nothing at all came
  from the server for `requestTimeoutMs`, so a slow server does not end the
  leader's group.
- A member that only listens sends nothing, so it gets no liveness check in
  this version; a dead link is noticed only when the OS reports it. Item 5
  adds an app-level keep-alive.

## Throttling and size checks

- **Leader throttling:** updates are limited to `limits.maxLeaderUpdatesPerSecond`
  from `hello.ok`, counted over a 1.1 s window (100 ms margin for network
  jitter). Faster calls are coalesced: only the latest position is kept and
  it is always sent once the rate allows (trailing send). If the server still
  answers `RATE_LIMITED`, the client emits the `error` event and re-sends that
  position after `retryAfterMs` (clamped to 10 s, at most 3 times) unless a
  newer one is pending.
- **Size checks:** before sending, the client measures the UTF-8 bytes of
  `JSON.stringify(value)` (the server's measure) for the position, and for
  the metadata and initial position on create. Over `limits.maxMessageBytes`
  fails locally with `MESSAGE_TOO_LARGE { field, sizeBytes, limitBytes }`; a
  value exactly at the limit is allowed. Values that are not JSON (cycles,
  `BigInt`, `undefined`, class instances, too deep) fail with
  `INVALID_PAYLOAD`.
- **Limits the client accepts** from `hello.ok`: `maxMessageBytes` up to
  1 MiB, `maxLeaderUpdatesPerSecond` up to 100, `maxGroupSize` up to 10 000.
  Larger values mean the server is not supported by this client: fatal
  `SERVER_UNSUPPORTED` with `details.limit`.

## Errors

Every error is a `SyncClientError` with `code`, `source` (`client` or
`server`), `fatal`, typed `details`, `request?` and `serverMessage?`. Use
`isSyncClientError(error, code?)` to narrow it. The `message` is a fixed text
per code.

**Fatal** (the client closes and does not reconnect): `INVALID_API_KEY`,
`INVALID_APP_VERSION`, `PROTOCOL_TOO_OLD` (`details.minProtocolVersion`),
`APP_VERSION_TOO_OLD` (`details.minAppVersion`), `SERVER_UNSUPPORTED` (the
four protocol versions, and `limit` for out-of-range limits),
`INVALID_MESSAGE`, `HANDSHAKE_REQUIRED`, `ALREADY_AUTHENTICATED`,
`HANDSHAKE_REJECTED` (close 4001 with no error frame) and `NO_WEBSOCKET`.
Apps must not retry fatal errors automatically; tell the user to update or
fix the configuration.

| Code                     | Source | When                                                                    |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| `INVALID_OPTIONS`        | client | Bad constructor option (`details.field`).                               |
| `NO_WEBSOCKET`           | client | No WebSocket implementation. Fatal.                                     |
| `NOT_CONNECTED`          | client | Group call while not `connected`.                                       |
| `CLOSED`                 | client | The app called `close()`.                                               |
| `CONNECTION_LOST`        | client | The socket dropped or failed. Retryable.                                |
| `REQUEST_TIMEOUT`        | client | No reply in time (`request` says which).                                |
| `RECONNECT_FAILED`       | client | `maxAttempts` used up.                                                  |
| `SERVER_UNSUPPORTED`     | client | Server protocol versions or limits not supported. Fatal.                |
| `HANDSHAKE_REJECTED`     | client | Close 4001 without an error frame. Fatal.                               |
| `INVALID_PAYLOAD`        | client | Metadata, position or group ID is not valid input.                      |
| `INVALID_SERVER_MESSAGE` | client | The server sent an invalid frame (`details.issues`: schema paths only). |
| `REQUEST_IN_PROGRESS`    | client | A create/join is already in flight.                                     |
| `INVALID_API_KEY`        | server | Unknown or missing key. Fatal.                                          |
| `INVALID_APP_VERSION`    | server | `appVersion` is not semver. Fatal.                                      |
| `PROTOCOL_TOO_OLD`       | server | This client's protocol is too old. Fatal.                               |
| `APP_VERSION_TOO_OLD`    | server | This app version is too old. Fatal.                                     |
| `INVALID_MESSAGE`        | server | The server rejected a message. Fatal during the handshake.              |
| `HANDSHAKE_REQUIRED`     | server | Fatal.                                                                  |
| `ALREADY_AUTHENTICATED`  | server | Fatal.                                                                  |
| `HANDSHAKE_TIMEOUT`      | server | Close 4002. Retryable.                                                  |
| `APP_CONNECTION_LIMIT`   | server | Close 4003, the app is at its connection cap. Retryable (busy).         |
| `TOO_MANY_MESSAGES`      | server | Close 4008. Retryable (busy).                                           |
| `INTERNAL_ERROR`         | server | Retryable during the handshake.                                         |
| `GROUP_NOT_FOUND`        | server | Unknown group ID.                                                       |
| `GROUP_FULL`             | server | `details.maxGroupSize`.                                                 |
| `ALREADY_IN_GROUP`       | both   | Create/join while in a group (also checked locally).                    |
| `NOT_IN_GROUP`           | both   | Position update outside a group.                                        |
| `NOT_LEADER`             | both   | Position update by a member.                                            |
| `RATE_LIMITED`           | server | `details.maxLeaderUpdatesPerSecond`, `details.retryAfterMs`.            |
| `MESSAGE_TOO_LARGE`      | both   | `details.field`, `details.limitBytes`, `details.sizeBytes?`.            |
| `LEADER_CANNOT_LEAVE`    | both   | The leader called `leaveGroup()`; it ends the group with `endGroup()`.  |

Unknown server message types are ignored, so a newer server can add events
without breaking older clients. A known type with a bad shape, a binary,
non-JSON, too deep or too long frame never reaches app callbacks: it gives
`INVALID_SERVER_MESSAGE` (and ends the attempt if it arrives before
`hello.ok`).

## Logging

The client logs nothing by default and never uses `console`. Pass a logger to
opt in:

```ts
const client = new SyncClient({
  ...options,
  logger: { warn: (event, fields) => myLog(event, fields) },
});
```

`debug`, `info`, `warn` and `error` are all optional. Each call gets a fixed
event name and fields with primitive values only (state names, attempt
numbers, delays, error and close codes, message types). The API key, the URL,
group and participant IDs, metadata, positions and server message text are
never passed.

## Security notes

- **Transport security:** `wss://` is required. `ws://` is accepted only for
  the exact hosts `localhost`, `127.0.0.1` and `[::1]`, or with
  `allowInsecureTransport: true` (local development or private networks
  only). `http(s)://` URLs, URLs with a username or password and URLs with a
  `#fragment` are rejected. The client connects to the URL exactly as it was
  checked. Never put the API key in the URL; it is sent only in `hello`.
- **Fatal errors:** do not retry them automatically. `connect()` after a
  fatal error waits for the backoff anyway.
- **`serverMessage` is untrusted text** from the server: never render it as
  HTML.
- **Treat `groupId` like a password:** in this version it is the only thing
  needed to join a group. Do not log it, do not send it to error reporters or
  analytics, and do not put it in URLs (item 4 defines share flows).
  `SyncClientError` objects carry no group ID, payload or key, so they are
  safe to report.
- **Always `catch` `connect()`:** it rejects on failure, and Node 22+ exits on
  unhandled rejections.
- **SSR:** see "Server-side rendering". In Node, inject `ws` with a small
  `maxPayload` (see "Node usage").

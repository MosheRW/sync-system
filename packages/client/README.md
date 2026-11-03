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

| Option                     | Default            | Notes                                                                        |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `url`                      | required           | `wss://...`. See "Transport security".                                       |
| `apiKey`                   | required           | 1 to 256 characters.                                                         |
| `appVersion`               | required           | 1 to 256 characters; the server checks semver.                               |
| `WebSocket`                | global `WebSocket` | Constructor to use (`ws`, a wrapper, a test fake).                           |
| `reconnect.initialDelayMs` | `500`              | First backoff cap. At least 100.                                             |
| `reconnect.maxDelayMs`     | `10000`            | Largest backoff cap. At least 1000 and at least `initialDelayMs`.            |
| `reconnect.maxAttempts`    | `Infinity`         | Reconnect attempts per `connect()` run (reset by a stable connection).       |
| `reconnect.stableAfterMs`  | `10000`            | Connected this long before the backoff resets. At least 1000.                |
| `requestTimeoutMs`         | `10000`            | Open + handshake, create and join. Position acks wait twice this.            |
| `allowInsecureTransport`   | `false`            | Must be exactly `true` to allow `ws://` to a non-loopback host.              |
| `logger`                   | none               | Opt-in logger, see "Logging".                                                |
| `random`                   | `Math.random`      | Jitter source in `[0, 1)`; tests inject it.                                  |
| `storage`                  | `'local'`          | Token storage: `'local'`, `'memory'` or a custom store. See "Token storage". |

Every `*Ms` value must be a finite number up to 2^31-1 ms.

### Methods

| Method                                                                                         | Returns                        | Notes                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                                                                                    | `Promise<ConnectedInfo>`       | Resolves on `hello.ok` with `{ participantId, limits }`. Returns the current attempt if one is running. Rejects on a fatal error, `close()` or giving up: always `catch` it. |
| `close()`                                                                                      | `void`                         | Idempotent. Closes the socket (1000), rejects pending requests and `connect()` with `CLOSED`, stops every timer. Never reconnects by itself.                                 |
| `createGroup(metadata, initialPosition?)`                                                      | `Promise<CreatedGroup>`        | `{ groupId, role: 'leader', participantId }`.                                                                                                                                |
| `joinGroup(groupId)`                                                                           | `Promise<JoinedGroup>`         | `{ groupId, role: 'member', participantId, metadata, hasPosition, position? }`. `hasPosition: false` means "no position yet".                                                |
| `updatePosition(position)`                                                                     | `void`                         | Leader only. Throws local errors synchronously; server rejections arrive as `error` events.                                                                                  |
| `getState()`                                                                                   | `ConnectionState`              | Same as `getSnapshot().connection`.                                                                                                                                          |
| `getSnapshot()`                                                                                | `SyncClientSnapshot`           | `{ connection, group }`, frozen, same object until something changes.                                                                                                        |
| `subscribe(listener)`                                                                          | unsubscribe function           | Called after every snapshot change. Fits `useSyncExternalStore`.                                                                                                             |
| `on(event, listener)` / `off(event, listener)`                                                 | unsubscribe function / `void`  | Typed events, below.                                                                                                                                                         |
| `checkTokens()`                                                                                | `Promise<StoredGroupStatus[]>` | See "Stored groups and recovery".                                                                                                                                            |
| `resumeGroup(groupId, options?)`                                                               | `Promise<ResumedGroup>`        | See "Stored groups and recovery".                                                                                                                                            |
| `endGroup()`                                                                                   | `Promise<void>`                | Leader ends the group for everyone.                                                                                                                                          |
| `leaveGroup()`                                                                                 | `Promise<void>`                | Member leaves (or stops waiting).                                                                                                                                            |
| `getBlockList(groupId)` / `addToBlockList(groupId, ids)` / `removeFromBlockList(groupId, ids)` | `Promise<string[]>`            | See "Block list".                                                                                                                                                            |
| `forgetGroup(groupId, namespace?)` / `forgetAllGroups(namespace?)`                             | `Promise<void>`                | Delete stored tokens locally, no server call.                                                                                                                                |

Group calls made while not `connected` fail at once with `NOT_CONNECTED`;
nothing is queued, and nothing is ever sent before `hello.ok`. Only one
`createGroup`/`joinGroup` may be in flight; another one fails locally with
`REQUEST_IN_PROGRESS`.

Metadata and positions are opaque: the client never reads or changes their
fields, and passes the received objects through as they are.

### Events

| Event             | Payload                      | When                                                                                                                                               |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`           | `ConnectionState`            | Every connection-state change.                                                                                                                     |
| `positionUpdated` | `{ groupId, position }`      | A member receives the leader's position.                                                                                                           |
| `groupEnded`      | `{ groupId, reason, code? }` | `ended_by_leader`, `leader_timeout`, `max_session`, `removed`, `replaced`, `left`, `rejoin_failed` or `closed` (see "Stored groups and recovery"). |
| `rejoined`        | `ResumedGroup`               | Leader or member got back into its group after a reconnect, or a waiting member was admitted.                                                      |
| `leaderStatus`    | `{ groupId, online }`        | A member's leader went offline (group frozen) or came back.                                                                                        |
| `error`           | `SyncClientError`            | Errors not tied to a promise: each failed connection attempt, server rejections of position updates, invalid server frames.                        |

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
| `connected`    | `participantId`, `namespace`, `limits`        | `hello.ok` received; group calls are allowed.                                       |
| `reconnecting` | `attempt`, `delayMs`, `retryAt`, `attempting` | Waiting for the backoff timer (`attempting: false`) or retrying (`true`).           |
| `closed`       | `reason`, `error?`                            | `reason` is `client` (`close()`), `fatal` or `gave_up`. Terminal until `connect()`. |

`GroupState` (in `snapshot.group`) is `active` (with `role`, `metadata`,
`hasPosition`, `position`, `leaderOnline`), `rejoining` (leader or member,
resuming after a drop), `waiting` (a member parked until its leader recreates
the group), or `ended` (with `reason` and `code?`). It is `null` before any
group, and again after `connect()` on a closed client.

### Indicator mapping

`indicatorOf(snapshot)` gives the PRD's sync indicator:

| Snapshot                                                                         | Indicator        |
| -------------------------------------------------------------------------------- | ---------------- |
| no group, or group `ended` (any reason)                                          | `none`           |
| connection `connecting`/`reconnecting`, group `active`, `rejoining` or `waiting` | `reconnecting`   |
| connection `connected`, group `rejoining`                                        | `reconnecting`   |
| connection `connected`, group `waiting`                                          | `leader_offline` |
| connection `connected`, group `active`, role `member`, `leaderOnline: false`     | `leader_offline` |
| connection `connected`, group `active`, role `member`, `leaderOnline: true`      | `following`      |
| connection `connected`, group `active`, role `leader`                            | `leading`        |
| anything else (idle, closed)                                                     | `none`           |

A leader disconnect freezes the group (`leader_offline` for members); an
`ended` group is really over.

## Reconnect and groups

After an unexpected disconnect the client reconnects by itself, and repeats
the handshake and version checks every time.

- **Leader and member:** the group becomes `rejoining`, keeping the last
  metadata and position. After the next `hello.ok` the client sends
  `group.resume` with the stored token (a leader adds its saved metadata,
  latest position and block list, read from storage). Success: the group is
  `active` again (the server's position wins) and `rejoined` fires; a member
  whose group is not in memory becomes `waiting` and is admitted when the
  leader comes back. `TOKEN_INVALID`, `TOKEN_EXPIRED`, `GROUP_ENDED`,
  `PARTICIPANT_BLOCKED` (token deleted), `GROUP_FULL`, `TOKEN_NOT_FOUND` or a
  timeout: the group is `ended` (`rejoin_failed`, with the code).
- A group ended with `replaced` is never resumed automatically.
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

| Code                      | Source | When                                                                        |
| ------------------------- | ------ | --------------------------------------------------------------------------- |
| `INVALID_OPTIONS`         | client | Bad constructor option (`details.field`).                                   |
| `NO_WEBSOCKET`            | client | No WebSocket implementation. Fatal.                                         |
| `NOT_CONNECTED`           | client | Group call while not `connected`.                                           |
| `CLOSED`                  | client | The app called `close()`.                                                   |
| `CONNECTION_LOST`         | client | The socket dropped or failed. Retryable.                                    |
| `REQUEST_TIMEOUT`         | client | No reply in time (`request` says which).                                    |
| `RECONNECT_FAILED`        | client | `maxAttempts` used up.                                                      |
| `SERVER_UNSUPPORTED`      | client | Server protocol versions or limits not supported. Fatal.                    |
| `HANDSHAKE_REJECTED`      | client | Close 4001 without an error frame. Fatal.                                   |
| `INVALID_PAYLOAD`         | client | Metadata, position or group ID is not valid input.                          |
| `INVALID_SERVER_MESSAGE`  | client | The server sent an invalid frame (`details.issues`: schema paths only).     |
| `REQUEST_IN_PROGRESS`     | client | A create/join is already in flight.                                         |
| `TOKEN_NOT_FOUND`         | client | No stored token for that group (`resumeGroup`, block-list methods, rejoin). |
| `BLOCK_LIST_FULL`         | client | The block list would hold more than 256 IDs (`details.limit`).              |
| `INVALID_API_KEY`         | server | Unknown or missing key. Fatal.                                              |
| `INVALID_APP_VERSION`     | server | `appVersion` is not semver. Fatal.                                          |
| `PROTOCOL_TOO_OLD`        | server | This client's protocol is too old. Fatal.                                   |
| `APP_VERSION_TOO_OLD`     | server | This app version is too old. Fatal.                                         |
| `INVALID_MESSAGE`         | server | The server rejected a message. Fatal during the handshake.                  |
| `HANDSHAKE_REQUIRED`      | server | Fatal.                                                                      |
| `ALREADY_AUTHENTICATED`   | server | Fatal.                                                                      |
| `HANDSHAKE_TIMEOUT`       | server | Close 4002. Retryable.                                                      |
| `APP_CONNECTION_LIMIT`    | server | Close 4003, the app is at its connection cap. Retryable (busy).             |
| `TOO_MANY_MESSAGES`       | server | Close 4008. Retryable (busy).                                               |
| `INTERNAL_ERROR`          | server | Retryable during the handshake.                                             |
| `GROUP_NOT_FOUND`         | server | Unknown group ID.                                                           |
| `GROUP_FULL`              | server | `details.maxGroupSize`.                                                     |
| `ALREADY_IN_GROUP`        | both   | Create/join while in a group (also checked locally).                        |
| `NOT_IN_GROUP`            | both   | Position update outside a group.                                            |
| `NOT_LEADER`              | both   | Position update, `endGroup()` or block list change by a member.             |
| `RATE_LIMITED`            | server | Position updates or `checkTokens()`. `details.retryAfterMs` (+ max rate).   |
| `MESSAGE_TOO_LARGE`       | both   | `details.field`, `details.limitBytes`, `details.sizeBytes?`.                |
| `LEADER_CANNOT_LEAVE`     | both   | The leader called `leaveGroup()`; it ends the group with `endGroup()`.      |
| `TOKEN_INVALID`           | server | The stored token is not valid here (any cause, same answer). Deleted.       |
| `TOKEN_EXPIRED`           | server | The token is past its group's limits. Deleted.                              |
| `GROUP_ENDED`             | server | The group ended on this server. Deleted.                                    |
| `PARTICIPANT_BLOCKED`     | server | The leader blocked this participant. Deleted.                               |
| `JOIN_METHOD_NOT_ALLOWED` | server | `createGroup()` with join methods the app does not allow.                   |
| `CODES_EXHAUSTED`         | server | No free join code; try again. Nothing was created.                          |
| `CODE_NOT_FOUND`          | server | No live group of this app has that code (one answer for every cause).       |
| `DOOR_CODE_REQUIRED`      | server | A method A group code without the door code. Ask for it and send both.      |
| `DOOR_CODE_WRONG`         | server | Wrong door code. Five wrong codes rotate it.                                |

Unknown server message types are ignored, so a newer server can add events
without breaking older clients. A known type with a bad shape, a binary,
non-JSON, too deep or too long frame never reaches app callbacks: it gives
`INVALID_SERVER_MESSAGE` (and ends the attempt if it arrives before
`hello.ok`).

## Stored groups and recovery

The client stores each participant token it gets (create, join, resume,
refresh), one per group, plus, for a leader, the group's metadata, latest
position and block list. With these a leader can recreate its group after a
server restart or a page reload.

### Token storage

One versioned JSON document per server and app, under the key
`sync-system:v1:<namespace>@<host[:port]>`. The `storage` option picks where:

- `'local'` (default): the browser's `localStorage`, looked up on first use
  (never at import). If it is missing or throws, memory is used and a
  `storage_unavailable` warning is logged.
- `'memory'`: lost with the page; nothing persists.
- a custom store with `getItem`, `setItem` and `removeItem` (sync or async),
  for example `sessionStorage` or React Native `AsyncStorage`.

At most 20 tokens are kept; tokens past their group's max session time are
dropped on load, then the oldest. Corrupt stored data is discarded. Storage
failures never reject a call (`storage_error` is logged).

**XSS caveat:** anything stored in `localStorage` can be read by any script
on the page. A stolen leader token lets its holder take the lead until the
group ends. Use a strict Content Security Policy, and pick `'memory'` or
`sessionStorage` when tokens should not outlive the tab. **Shared devices:**
call `forgetAllGroups()` on "log out" or when the device is shared (works
without a connection; pass the namespace if the client never connected).
Call it with the app's other tabs closed: a tab that stays open keeps its
tokens in memory and can still write one back in the case described below.

**Multiple tabs** share one document. Writes re-read the document first, so
tabs rarely overwrite each other, but custom async stores can still race. If
another tab resumes the same group, this tab's group ends with `replaced`
(token kept, not resumed automatically): show "opened on another device". For
a leader this may also signal a stolen token.

When a write fails (for example a full quota), the tab keeps that group's
change in memory and writes it with its next successful write. Another tab's
later change still wins: a group the other tab forgot (`forgetGroup()` or
`forgetAllGroups()`) is not written back, and a newer token it stored for the
same group is kept. The remaining cross-tab limits:

- Outside that case the last writer wins; there is no live sync between tabs
  (the client does not listen to the `storage` event). Another tab's changes
  are picked up on this tab's next storage operation.
- A token this tab stored for a group that had no stored entry yet, whose
  write failed, can still be written back after another tab's
  `forgetAllGroups()`: always if the document did not exist at the failed
  write, otherwise only if some tab wrote the document again before this
  tab's next storage operation. Closing the other tabs before
  `forgetAllGroups()` avoids it.
- If this tab has never read storage successfully (every read failed since
  it started), it cannot tell what other tabs stored, so a change it made
  then wins over theirs until its next successful write: a group it forgot
  stays forgotten, and a token it stored is written over theirs. Such a
  token also undoes another tab's `forgetGroup()` or `forgetAllGroups()` for
  that group: the group is stored again.
- If `forgetAllGroups()` can neither delete nor read the stored document, the
  tab cannot list the groups other tabs stored. It remembers the time of the
  call instead: until its next successful write, every successful read drops
  stored tokens issued at or before that second, and that write removes them
  from storage. Tokens issued strictly later (stored by another tab after the
  call) are kept. The time is this device's clock against the server's
  issue time, so a large clock difference can keep an older token or drop
  one issued in the same few seconds.

### `checkTokens()`

Sends all stored tokens (up to 20) and resolves with `{ groupId, role,
status }` each: `live`, `recoverable` (leader, group not in memory),
`waiting` (member, group not in memory), `blocked`, `ended`, `expired` or
`invalid`. The last four delete the token. It is never called
automatically; call it at startup to offer "return to your group". The server
allows 10 checks per minute (`RATE_LIMITED`).

### `resumeGroup(groupId, options?)`

Resumes a stored group. A leader returns to it, or recreates it with its
saved metadata, position and block list (`options.metadata` /
`options.position` override them). A member rejoins, or resolves with
`status: 'waiting'` until its leader recreates the group. Rejects with
`TOKEN_NOT_FOUND`, or the server's code.

### Ending and leaving

`endGroup()` (leader) ends the group for everyone; `leaveGroup()` (member)
leaves it, and a leader gets `LEADER_CANNOT_LEAVE`. Both delete the token.
The token is also deleted on every `group.ended` except `replaced`; `close()`
keeps tokens ("resume later").

### Block list

`addToBlockList(groupId, ids)` and `removeFromBlockList(groupId, ids)` change a
leader group's stored list (participant IDs, at most 256: `BLOCK_LIST_FULL`).
While the group is active and led by this client the full list is sent to
the server, which removes blocked members (`groupEnded` reason `removed`);
otherwise it is sent with the next resume. `getBlockList(groupId)` reads it.
Until join codes (item 4), a blocked person can still join again by group ID
with a new identity.

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
group and participant IDs, tokens, block lists, storage keys, metadata,
positions and server message text are never passed.

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

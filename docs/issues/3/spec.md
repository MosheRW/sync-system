# Spec: #3 Framework-free core client package

Issue: https://github.com/MosheRW/sync-system/issues/3
Source PRD: `docs/PRD Group Reading Sync.md` (Deliverable 2, "Framework-free JS package")
Path: full | Type: feat | PRD item 2 of 9 (GitHub issue #3)
Numbering: "item N" below means PRD item N of 9, not GitHub issue N. Item 1 is GitHub #1 (merged in PR #2).
Builds on: #1 (merged in PR #2): `@sync-system/protocol` and `apps/sync-server`

## Problem / motivation

The sync server from #1 speaks a WebSocket protocol (welcome -> hello -> hello.ok, then `group.create` / `group.join` / `position.update` and server events). Today every client app would have to write its own socket handling, handshake, version checks, reconnect logic and rate limiting to use it, and would get them wrong in different ways. The PRD lists a **framework-free JS package (the core)** as a deliverable: "sockets, reconnects, tokens, version checks and join flows for any client". This issue builds the first slice of that package: a typed, framework-free TypeScript client that works in browsers and Node, handles the connection life cycle and version checks, behaves well within the server's limits, and gives apps a connection-state signal for the PRD's "following / reconnecting / leader offline" indicator.

The React/Next package (item 6) and the reading app (item 7, item 8) will integrate only through this package, so its API must be framework-free and safe to import during server-side rendering.

**Note:** the PRD assigns tokens (item 3) and join flows (item 4) to this same core package. Those issues will **extend** `@sync-system/client`; this issue must not make choices that block them (for example, the connection and group API should leave room for token-based rejoin and code-based joins).

## User stories

- As a **client app developer**, I want one package that connects to the sync server, does the handshake and exposes typed `createGroup` / `joinGroup` / `updatePosition` calls and typed events, so that I can add group sync without learning the wire protocol.
- As a **client app developer**, I want "protocol too old", "app version too old" and "server unsupported" surfaced as distinct typed errors, so that my app can tell the user to update instead of failing silently.
- As a **group member on a phone**, I want the client to reconnect automatically after a network drop or a brief screen lock, so that I keep following the leader without doing anything.
- As a **client app developer**, I want an observable connection state (connecting, connected, reconnecting, closed, plus whether the group/leader is live), so that I can show the PRD's "following / reconnecting / leader offline" indicator.
- As a **leader**, I want rapid page turns to be smoothed by the client so that the group still ends up on my latest page instead of my updates being rejected as rate limited.
- As a **client app developer**, I want oversized payloads caught locally with a clear error before they are sent, so that I find the problem in development rather than from a server rejection.
- As a **React/Next developer (item 6)**, I want to import the package in server-side code without it touching `window` or opening sockets, so that SSR does not crash.
- As a **Node developer or test author**, I want to inject a WebSocket implementation (for example `ws`), so that the same client runs in Node.

## Acceptance criteria

### Package and build
- [ ] AC1. A new workspace package `@sync-system/client` (in `packages/client`) is written in TypeScript, depends on `@sync-system/protocol` for types, constants and server-message validation, and has **no** runtime dependency on any UI framework (React, Vue, etc.) or on a Node-only module.
- [ ] AC2. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` at the repo root include the new package and exit 0; CI from #1 runs them unchanged.
- [ ] AC3. The package builds ESM output with type declarations, and its public API (the client factory/class, option types, event types, error types, connection-state type) is exported from the package entry point.

### Environment support
- [ ] AC4. In a browser-like environment the client uses the global `WebSocket` by default.
- [ ] AC5. The client accepts an injected WebSocket implementation (constructor) in its options; a test runs the full flow in Node using `ws` injected this way.
- [ ] AC6. When no global `WebSocket` exists and none is injected, creating/connecting the client fails with a typed, descriptive error (not a `ReferenceError`).
- [ ] AC7. SSR-safe import: importing the package in a Node environment without `window`, `document` or a global `WebSocket` has no side effects: it does not throw, opens no connection, starts no timers and does not read browser globals at import time. A test proves this.

### Connect and handshake
- [ ] AC8. The client connects to a configured server URL, waits for `welcome`, sends `hello` with its protocol version, the app's API key and the app's version (semver string supplied by the app), and resolves the connect step only on `hello.ok`.
- [ ] AC9. After `hello.ok` the client exposes the participant ID and the app limits from `hello.ok` (`maxGroupSize`, `maxLeaderUpdatesPerSecond`, `maxMessageBytes`).
- [ ] AC10. Every server message is validated with the protocol package's server-message schemas; an invalid or unknown message never reaches app callbacks as a typed event and is surfaced as a typed protocol error (or ignored for forward-compatible unknown types; the architect decides and documents which).
- [ ] AC11. Group calls made before the handshake completes either wait for it or fail with a typed "not connected" error (the architect decides and documents which); they are never sent to the server before `hello.ok`.

### Client-side version checks
- [ ] AC12. The client refuses a server whose `welcome` is unsupported: if the server's `minProtocolVersion` is above the client's protocol version, or the server's `protocolVersion` is below the minimum server protocol the client supports, the client does not send `hello`, closes the socket, and reports a typed `SERVER_UNSUPPORTED` error that includes both sides' versions.
- [ ] AC13. A server `PROTOCOL_TOO_OLD` rejection is surfaced as a typed "protocol too old" error carrying the server's minimum, and an `APP_VERSION_TOO_OLD` rejection as a typed "app version too old" error carrying the minimum app version, so apps can prompt the user to update.
- [ ] AC14. `INVALID_API_KEY`, `INVALID_APP_VERSION`, `PROTOCOL_TOO_OLD`, `APP_VERSION_TOO_OLD` and `SERVER_UNSUPPORTED` are **fatal**: the client moves to a terminal state and does **not** reconnect automatically. Tests prove no further connection attempt is made.

### Groups and positions
- [ ] AC15. `createGroup(metadata, initialPosition?)` resolves with the group ID and the participant's role (`leader`) on `group.created`, or rejects with a typed error carrying the server error code.
- [ ] AC16. `joinGroup(groupId)` resolves with the group ID, role (`member`), metadata and current position (or an explicit "no position yet") on `group.joined`, or rejects with a typed error (`GROUP_NOT_FOUND`, `GROUP_FULL`, `ALREADY_IN_GROUP`, ...).
- [ ] AC17. Each request is matched to its reply by `reqId`, so concurrent or overlapping calls resolve/reject the correct promise; a pending request is rejected with a typed error if the connection drops before its reply.
- [ ] AC18. `updatePosition(position)` is allowed only for the leader; called by a member or outside a group it fails locally with a typed error and sends nothing.
- [ ] AC19. Typed events are emitted for: position updated (payload deep-equal to what the leader sent), group ended (with reason), errors not tied to a request, and connection-state changes. Apps can subscribe and unsubscribe; an unsubscribed listener is never called again.
- [ ] AC20. The client never reads or alters fields inside position payloads or group metadata (opaque passthrough); tests assert deep equality including arbitrary extra fields.

### Client-side limits
- [ ] AC21. Leader updates are throttled to the `maxLeaderUpdatesPerSecond` from `hello.ok`. When the leader calls `updatePosition` faster than that, intermediate updates are coalesced and the **latest** position is always sent once the rate allows (trailing send). A test drives a burst of updates (for example 50 in 1 second with a limit of 5/s) and asserts: the server never answers `RATE_LIMITED`, and every member's final received position equals the last one the leader set.
- [ ] AC22. Before sending, the client measures the serialized size of the position payload (and of group metadata on create) against `maxMessageBytes` using the same measure as the server, and rejects oversized values locally with a typed `MESSAGE_TOO_LARGE` error without sending them.
- [ ] AC23. If the server still answers `RATE_LIMITED` or `MESSAGE_TOO_LARGE` (for example limits changed), the error is surfaced as a typed error and the client stays connected.

### Connection state and reconnect
- [ ] AC24. The client exposes its current connection state synchronously and emits an event on every change. States cover at least: `idle`, `connecting`, `connected` (handshake done), `reconnecting` (with attempt number and next delay), and `closed` (with reason: closed by app, fatal rejection, or gave up). The exact names are the architect's choice and are documented.
- [ ] AC25. The state API gives an app enough to drive the PRD indicator: following (connected and in a live group), reconnecting, and leader offline / group ended (in #1 a leader disconnect ends the group; item 5 will add a "leader offline, grace period" state on top of this). The mapping from client state to these three indicator values is documented in the package README.
- [ ] AC26. After an unexpected disconnect (socket error, abnormal close, server `GOING_AWAY` 1001, `APP_CONNECTION_LIMIT` 4003, connection-cap 503 on upgrade, `TOO_MANY_MESSAGES` 4008), the client reconnects automatically with exponential backoff and full jitter, using configurable initial delay, max delay and max attempts (defaults proposed below). Tests use fake timers or short delays to prove the delays grow, are randomized within bounds, and stop at the max attempts with a `closed` (gave up) state.
- [ ] AC27. After a successful reconnect the backoff resets; the client repeats the handshake (including version checks) on every reconnect.
- [ ] AC28. `close()` by the app stops the client: it closes the socket, cancels any pending reconnect timer and throttled update, rejects pending requests with a typed "closed" error, and never reconnects. After `close()` no timers are left running (test asserts this with fake timers or handle checks).
- [ ] AC29. Group membership on reconnect follows the behavior confirmed at Gate 1 (see open question Q1). Whatever is chosen, the app is told explicitly through typed events whether it is back in its group or not; it is never left believing it is in a group that it is no longer in.

### Testing and docs
- [ ] AC30. Integration tests run against the **real** `apps/sync-server` started in-process (random port, test app config), covering: handshake, each version-check failure, create/join/update/events, throttling (AC21), size pre-check (AC22), reconnect after a server-side drop, no reconnect after fatal errors, group ended on leader disconnect, and `close()`.
- [ ] AC31. A package README documents installation, browser and Node usage (with WebSocket injection), the API, the event and error types, connection states and the indicator mapping, the reconnect defaults, and the throttling behavior.
- [ ] AC32. The client logs nothing by default (no `console` output); any logging is opt-in through an injected logger, and never includes the API key, position payloads or metadata.

## Proposed defaults (to confirm at Gate 1)

| Setting | Proposed default |
| --- | --- |
| Reconnect initial delay | 500 ms |
| Reconnect max delay | 10 s |
| Backoff | exponential x2, full jitter (random between 0 and the current cap) |
| Max reconnect attempts | unlimited while the app keeps the client open (configurable) |
| Request timeout (no reply) | 10 s, then typed timeout error |

The 30 s lock-tolerance criterion (confirmed in #1) means a client must still be retrying at 30 s after a drop; the defaults above satisfy that.

## Out of scope (and which later issue covers it)

- JWT tokens, token storage in the browser, sending stored tokens to find live groups, restart recovery, block list / removed members -> **item 3** (extends this package).
- Join methods A-D (group + door code, code + approval, alphanumeric code, QR) and their client flows -> **item 4** (extends this package). The group-ID join here mirrors #1's temporary mechanism.
- Roles beyond leader/member (vice-leader, remove, lock, preview mode), timers, keep-alive prompts, leader grace period and handoff, display names -> **item 5**.
- React/Next hooks and components -> **item 6**.
- Reading app and its sync UX (prompts, indicator UI) -> **item 7, item 8**.
- Redis, multi-instance, public docs site, changelog and release process / npm publishing -> **item 9**.
- Any server change, except a small fix strictly needed for a client test and called out in the architecture plan.

## Open questions (Gate 1)

- **Q1. Group membership on reconnect before tokens exist.** In #1 a leader disconnect ends the group, a member's join by group ID is temporary, and the server gives a new participant ID on each connection. Proposed default: on reconnect a **member** automatically re-sends `group.join` for its last group ID; if it succeeds the client emits a "rejoined" event with the current position, and if the group is gone (`GROUP_NOT_FOUND`) it emits "group ended" and clears its group. A **leader** is never auto-rejoined: its group already ended when it dropped, so after reconnect the client reports "group ended" (reason: leader disconnected) and stays connected with no group. Item 3 replaces this with token-based rejoin. Confirm or change.
- **Q2. Throttling: coalesce vs. reject.** #1 decided the server rejects over-rate updates. Proposed default: the client coalesces and sends the latest position with a trailing send (AC21), so the group always lands on the leader's last page. Should the client also expose an option to disable coalescing? Proposed: no option in this issue.
- **Q3. Reconnect defaults.** Confirm the table above (500 ms initial, 10 s max, full jitter, unlimited attempts while open, 10 s request timeout).
- **Q4. `APP_CONNECTION_LIMIT` (4003) and HTTP 503 on upgrade.** Proposed: treat as retryable with backoff (server is busy), not fatal. Confirm.
- **Q5. Minimum server protocol the client supports.** Proposed: the client supports exactly protocol 1 (`PROTOCOL_VERSION` from the protocol package) as both its version and its minimum server version for now; the constant lives in the client package so a future client can support a range.
- **Q6. Calls before connect.** Proposed default for AC11: `connect()` is explicit and returns a promise; group calls made before `connected` fail fast with a typed `NOT_CONNECTED` error (no hidden queue). Calls made while `reconnecting` also fail fast. Confirm or prefer queuing.
- **Q7. Browser tests.** Proposed: Node-only tests (with `ws` injected and an SSR-import test) in this issue; real-browser tests (Playwright) come with the reading app in item 7/item 8. Confirm.

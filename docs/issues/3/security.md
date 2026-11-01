# Security review (plan): #3 Framework-free core client package

Issue: https://github.com/MosheRW/sync-system/issues/3 | PR: #4 (draft)
Reviewed: [`architecture.md`](./architecture.md) against [`spec.md`](./spec.md),
the Gate 1 decisions in [`STATE.md`](./STATE.md), the #1 review
([`../1/security.md`](../1/security.md)) and the current `packages/protocol`
and `apps/sync-server` code.
Reviewer: security | Mode: plan | Round: 1 | Result: **FAIL** (0 critical,
2 high, 5 medium, 8 low)

The plan already gets most things right: the API key in a `#private` field
and only in `hello`, nothing at import time, lazy host globals, no logging by
default with a primitives-only logger, fixed error messages that never echo
values, the iterative depth check and length guard before the schema, unknown
types ignored, server `details` copied field by field, opaque data passed by
reference and never merged, no new third-party runtime dependency, a
generation number per socket, and full-jitter backoff.

The two blocking findings are both about the client hurting something outside
itself: H1 can turn a flapping server into a reconnect storm from every
client at once, and H2 can crash a Node process that uses the client. Both
have small fixes that fit the planned commits (5, 9, 13).

## 1. Assets and trust boundaries

| Asset | Why it matters |
| --- | --- |
| Shared server availability | One process serves every app. Clients must not make an incident worse (retry storms, reconnect loops). |
| Group ID | In #1 the only join capability (bearer secret) for a group that may contain minors. It sits in the snapshot, in `CreatedGroup`/`JoinedGroup` and in events. |
| Positions and metadata | Show what a group (possibly minors) reads and when. |
| API key | Public in browser bundles, but may be private for Node/native apps. |
| Host process / page | A Node service or a browser tab using the client. The client must not crash it, leak timers or block it. |

Trust boundaries:
1. **Server -> client**: every inbound frame is untrusted (buggy server, a
   proxy, or a MITM when `ws://` is used).
2. **Network**: key, group ID and positions in transit.
3. **Client library -> app**: what the client hands to app code (events,
   errors, snapshot, logger) may be logged, serialized or rendered by the app.
4. **SSR server -> browser**: the same module runs on a shared Node server
   during SSR.

## 2. Threats (STRIDE, brief)

| | Threat | Covered by the plan? |
| --- | --- | --- |
| S | MITM pretends to be the server, gets key and group IDs | `wss://` rule (Q-B). Loopback check must be exact (M2). |
| T | Hostile frame pollutes prototypes or crashes the client | Mostly covered (sec. 6). Unbounded server numbers feed timers and buffers (M1). |
| I | Group ID / key / positions in logs, errors, snapshot | Covered for logs and errors. Snapshot and `serverMessage` need app guidance (L3, L4). |
| I | Cleartext transport | Covered by Q-B (agree), with M2. |
| D | Client reconnect storm against the server | **Partly**: backoff resets on every `hello.ok` (H1); no floor for "server busy" signals (M3); Q-C ends every group on a slow server (M4); app-driven `connect()` loops (M5). |
| D | Client crashes its own Node host | **Not covered**: `ws` emits `error` with no listener (H2). |
| D | Timer/listener leaks after `close()` | Covered (AC28, generation number). See L6 for unhandled rejections. |
| E | Member acts as leader | Server enforces; client checks role locally. OK. |

## 3. Findings

### High (blocking)

**H1. Backoff resets on every `hello.ok`, so a flapping server gets a tight
reconnect loop from every client.**
Sec. 4 "Backoff" ("The counter resets only on `hello.ok`"), state diagram
(`hello.ok --> connected (attempt counter reset, AC27)`), sec. 7 (member
rejoin after `hello.ok`).
*Scenario:* the server accepts the handshake and then drops the socket soon
after: a memory or backpressure problem (the #1 H2 control terminates slow
sockets), a load balancer that resets idle or new connections, a 4008 caused
by a client bug, or a server that crashes shortly after start. Each client
then loops: connect -> `welcome`/`hello`/`hello.ok` -> counter reset ->
`group.join` (member rejoin) -> drop -> retry after 0-500 ms. That is about
4 full handshakes plus a join per client per second, forever. With 10,000
clients it is about 40,000 handshakes/s against a server that is already
failing, which keeps it from recovering and hurts every other app on it.
Leaders also lose their group on every cycle.
*Fix (plan change, commits 5 and 13):*
- Reset the attempt counter only after the connection has stayed `connected`
  for `stableAfterMs` (new `reconnect` option, default 10 s, validated like
  the other numbers). A drop before that continues the backoff sequence
  (`attempt n+1`). Implement it as a timer started on `hello.ok` and cleared
  on disconnect/`close()` (it counts in the AC28 timer check), or as a
  timestamp comparison at drop time (no timer).
- AC27 still holds: the handshake and version checks are repeated on every
  reconnect; only the counter reset is delayed.
- Tests: unit test with a fake socket that completes the handshake and then
  closes after 100 ms, five times in a row: the delay caps grow (500, 1000,
  2000, ...), not reset. A drop after `stableAfterMs` starts at attempt 1.

**H2. Removing socket listeners on retired `ws` sockets can crash a Node host
process.**
Sec. 4 "On every disconnect" ("Socket listeners are removed and the
generation number is bumped"), sec. 2 `transport.ts`, AC5 (injected `ws`).
*Scenario:* `ws` is an `EventEmitter`; `addEventListener('error')` is a
wrapper over `on('error')`. When the attempt timer fires while the socket is
still `CONNECTING` (server unreachable, packets dropped, slow TLS), the
client removes its listeners and calls `close()`. `ws` then aborts the
handshake and emits `'error'` on the next tick. With no `'error'` listener,
Node throws `Unhandled 'error' event` and the whole process exits. The same
happens for a late protocol error (invalid UTF-8, bad close code from the
server) on a socket whose listeners were already removed. A Node service
using the client (a bot, a test runner, an SSR process that connects) can be
taken down by an unreachable or hostile server. Browser and undici
`WebSocket` do not throw, so tests with Node's global `WebSocket` would not
show it.
*Fix (plan change, commit 9):*
- Never leave a socket without an `error` listener. On retirement, remove
  the message/open/close handlers but attach (or keep) a no-op `error`
  listener before calling `close()`, and leave it attached. Alternatively,
  keep all listeners and let the generation check drop stale events.
- Wrap `socket.close()` and `socket.send()` in `try/catch` (some
  implementations throw on invalid state or invalid close codes).
- Tests with injected `ws` (not only the fake socket): attempt timeout while
  `CONNECTING` against a TCP server that accepts and never answers the
  upgrade (`node:net` in `test/helpers/`); `close()` during `CONNECTING`.
  `test/setup.ts` must fail on the uncaught exception.

### Medium (advisory, recommended for this issue)

**M1. Server-supplied numbers and option numbers feed timers and buffers
without bounds.**
Sec. 5 (`RATE_LIMITED` reschedules at `details.retryAfterMs`), sec. 6
(length guard `2 * maxMessageBytes + 8192`), sec. 5 throttle (keeps `L =
maxLeaderUpdatesPerSecond` send times), sec. 3 options (`maxDelayMs`,
`requestTimeoutMs`).
*Scenario:* `setTimeout` treats any delay above 2^31-1 ms (about 24.8 days)
or `NaN`/negative as about 1 ms (Node prints `TimeoutOverflowWarning`). A
server (bug, proxy, or MITM over `ws://`) answering `RATE_LIMITED` with
`retryAfterMs: 1e12` turns the trailing re-send into a tight send loop until
the server closes with 4008, which ends the leader's group. A huge
`maxMessageBytes` in `hello.ok` disables the inbound length guard; a huge
`maxLeaderUpdatesPerSecond` makes the throttle allocate or keep a very large
array. An app passing `maxDelayMs: Infinity` gets immediate retries.
*Fix:*
- `hello.ok.limits`: accept only positive safe integers and clamp to sane
  client constants (e.g. `maxMessageBytes <= 1 MiB`,
  `maxLeaderUpdatesPerSecond <= 100`, `maxGroupSize <= 10_000`); outside
  that range treat `hello.ok` as `INVALID_SERVER_MESSAGE` (retryable). The
  throttle stores at most `L` timestamps in a ring buffer, never preallocated
  from an unchecked value.
- `details.retryAfterMs` and every other numeric detail: `Object.hasOwn`,
  `Number.isFinite`, `>= 0`, then clamp the delay to `[window slot, 10 s]`.
- Options: every `*Ms` option must be a finite number in `[0, 2^31-1]`
  (`maxAttempts` may be `Infinity`), else `INVALID_OPTIONS`. Clamp every
  computed delay before calling `setTimeout` (one helper in `host.ts`).
- Tests: `retryAfterMs` of `1e12`, `-1`, `"5"`; `maxMessageBytes: 2**53`;
  options with `Infinity`/`NaN`.

**M2. The loopback/`wss://` rule needs exact URL rules, or it can be
bypassed.**
Sec. 3 options (`url`), sec. 11 "Transport security", Q-B.
*Scenario:* a check based on string prefixes or substrings accepts
`ws://localhost.attacker.example`, `ws://127.0.0.1.nip.io` or
`ws://user@localhost@host`, and the key, group IDs and positions travel in
cleartext. WHATWG `WebSocket` also accepts `http:`/`https:` URLs since 2023,
so an `http://` URL would bypass a check that only looks for `ws:`.
*Fix (in `options.ts`):*
- Parse with `new URL(url)`. Allow only `protocol` `wss:` or `ws:`; reject
  `http:`, `https:` and everything else with `INVALID_OPTIONS { field: 'url' }`.
- `ws:` is allowed only when `hostname` is exactly `localhost`,
  `127.0.0.1`, or `[::1]` (that is how `URL` reports IPv6), or when
  `allowInsecureTransport === true` (strict boolean). Optionally accept all
  of `127.0.0.0/8` by numeric parse; no DNS lookups.
- Reject URLs with `username`/`password` or a `hash`. Document that the API
  key must never be put in the URL (the server reads it from `hello`).
- Tests: the bypass strings above, `WS://LOCALHOST` (accepted, `URL`
  lowercases), `ws://[::1]:8080`, `https://host`.

**M3. No back-off floor or larger cap for explicit "server busy" signals.**
Sec. 4 failure table (503, 4003, 1001 retryable), Backoff.
*Scenario:* after a restart (1001 to every socket) or at an app connection
cap (4003), all clients start at attempt 1 with a 0-500 ms window, and at the
cap retry on average every 5 s indefinitely. With an app stuck at its
`maxConnections` and thousands of waiting clients, that is a steady stream of
rejected handshakes. Each one is cheap, but it competes with the pending
handshake cap (`MAX_PENDING_HANDSHAKES`) for real users.
*Fix:* for 4003, 1001 and 4008 (which the client can tell apart), start the
sequence at a higher attempt number (e.g. cap 2 s first) and use a larger
cap for 4003 (e.g. 30 s, still inside the 30 s lock tolerance for the other
cases). Keep full jitter. A 503 on upgrade cannot be told apart from a
network error in browsers, so it stays on the normal sequence. Document the
values in the README.

**M4 (Q-C). A request timeout drops the socket, which ends every leader's
group when the server is merely slow.**
Sec. 1 decision 5, sec. 6 step 7, Q-C.
*Scenario:* during a server stall of more than 10 s (GC pause, overload,
event-loop block), every leader's `position.ack` times out at about the same
moment. Each leader drops its socket, the server ends every group (in #1 a
leader drop ends the group), every member then tries to rejoin a group that
no longer exists, and all of them reconnect into the stalled server. A
transient slowdown becomes the loss of every group plus a reconnect wave.
*Fix:* see Q-C below. Keep drop-on-timeout for `hello`, `group.create` and
`group.join` (the consistency reason in the plan is valid there). For
`position.update`, reject with `REQUEST_TIMEOUT` but drop only when nothing
at all has been received from the server for `requestTimeoutMs` (any inbound
frame proves the link is alive), and use a longer ack timeout (e.g. 2x).
Every timeout-driven drop counts as a failed attempt for backoff (H1).

**M5. App code that calls `connect()` on every `closed` state creates an
unthrottled loop on fatal errors.**
Sec. 1 ("`connect()` is allowed from ... `closed` (a fresh start with
backoff reset)").
*Scenario:* a common pattern, and a likely one in the item 6 hooks, is "if
closed, connect". With `INVALID_API_KEY`, `APP_VERSION_TOO_OLD` or
`SERVER_UNSUPPORTED`, each call opens a socket, fails fatally and returns to
`closed` within one round trip, so the loop hammers the server with no delay
from every installed copy of an outdated app (the exact case where many
clients fail at once, after a `minAppVersion` bump).
*Fix:* when `connect()` is called on a client that is `closed(fatal)` or
`closed(gave_up)`, apply the backoff delay for the next attempt (the counter
is not reset by `connect()`; it resets only through the H1 stability rule or
a new `SyncClient`). Or reject immediately with the same fatal error if it
happened less than `initialDelayMs * 2^k` ago. Document in the README that
fatal errors must not be retried automatically by apps. Note for item 6.

### Low (hygiene)

**L1. Read server `details` with own-property checks.** Sec. 8. zod 4.6.7
already skips `__proto__` keys in `z.record`, but the copy must use
`Object.hasOwn(details, key)` and `typeof` checks, never `details.key ??`
reads that could see inherited properties, and must build the result as a
fresh object literal with fixed keys. Add a unit test with
`{"details":{"__proto__":{"retryAfterMs":1}}}`.

**L2. Cap untrusted strings before keeping or logging them.** Sec. 6, 8, 9.
`error.message` (kept as `serverMessage`) and an unknown `type` (logged at
debug) are server-controlled and can be up to the frame size. Keep at most
256 chars of `serverMessage`, log an unknown `type` only if it matches
`/^[a-z.]{1,64}$/` (else `"(invalid)"`), and cap `INVALID_SERVER_MESSAGE.issues`
to 10 entries. README: `serverMessage` is untrusted text (never render it as
HTML).

**L3. The snapshot and results hold the group ID, a bearer capability.**
Sec. 3. Apps tend to send state to error reporters (Sentry breadcrumbs,
Redux devtools, analytics). README: treat `groupId` like a password in #1
(do not log it, do not send it to third parties, do not put it in URLs
except in a share flow item 4 defines); `SyncClientError` objects carry no
group ID or payload and are safe to report. Make sure no error gets a
`cause` holding a raw frame or a server object.

**L4. Do not keep the options object.** Sec. 1/3. Copy `apiKey` into the
`#private` field and keep no public or enumerable reference to the original
`options` (no `this.options`), so the key does not appear in
`console.log(client)` or serialized state. Logged listener exceptions: log
only `err.name`, not `err.message` (app errors may contain app data).

**L5. Bound group requests in flight.** Sec. 5 ("ALREADY_IN_GROUP for
create/join while active or rejoining"). While a `group.create`/`group.join`
is pending, a second one is still sent; a buggy app loop can then flood the
server into a 4008 close (which ends the leader's group). Allow one group
request in flight; reject others locally (`ALREADY_IN_GROUP` or a new
`REQUEST_IN_PROGRESS`). Cap the `RATE_LIMITED` re-queue to a few retries per
position.

**L6. Never create unhandled rejections inside the client.** Sec. 1, 4.
Internal attempt and rejoin promises must always have a handler attached;
only the promise returned to the app may reject. README: `connect()`
rejects on failure, so callers must `catch` (Node 22+ exits on unhandled
rejections by default). Covered partly by `test/setup.ts`; add a test where
a fatal error happens with no app `catch` on internal paths.

**L7. Guidance for SSR singletons and Node `ws` frame size.** Sec. 9 README.
A `SyncClient` created at module scope on an SSR server is shared by every
request and user; never call `connect()` during SSR and create the client in
the browser (item 6: `getServerSnapshot` returns a constant idle snapshot).
For Node, `ws` buffers frames up to its default `maxPayload` (100 MiB) before
the client's length guard runs; README shows injecting a small wrapper class
that passes `{ maxPayload }` (for example 1 MiB).

**L8. Unexpected handshake messages after `connected`.** Sec. 4 step 5
covers the handshake only. Define that a `welcome` or `hello.ok` after
`connected` is `INVALID_SERVER_MESSAGE` and ignored (not a new
`participantId`/`limits`), so a confused server cannot silently raise the
client's limits mid-session.

## 4. Gate 2 questions: security view

**Q-A (other handshake rejections fatal): agree.** `INVALID_MESSAGE`,
`HANDSHAKE_REQUIRED`, `ALREADY_AUTHENTICATED` and a bare 4001 are
deterministic: the same client sends the same `hello` and gets the same
answer, so retrying is a guaranteed retry storm. Keep `HANDSHAKE_TIMEOUT`
(4002), `APP_CONNECTION_LIMIT` (4003), `TOO_MANY_MESSAGES` (4008) and an
`INTERNAL_ERROR` during the handshake retryable with backoff. Pair Q-A with
M5, or the app turns "fatal" back into a loop.

**Q-B (`wss://` required except loopback, opt-out
`allowInsecureTransport`): agree, strongly.** The group ID is the only join
capability in #1, positions describe what minors read, and the key may be
private for Node apps. Fail closed at construction time with
`INVALID_OPTIONS`, with the exact parsing rules in M2. The opt-out must be an
explicit `true` and documented as "local development / private networks
only". Browsers already block `ws://` from `https://` pages, so this mainly
protects Node, native and http-served dev builds that accidentally ship.

**Q-C (request timeout drops the socket): agree for handshake, create and
join; change it for position updates (M4).** A silent link must be detected,
and late `group.created` replies would leave orphan groups, so dropping on a
create/join/hello timeout is right. For `position.update`, a drop is
destructive (it ends the group for every member) and is the wrong answer to a
slow server; drop only when the server has been fully silent for the
timeout, and count every timeout-driven drop toward backoff (H1).

## 5. Required controls (part of the plan)

These must be in the implementation. Each maps to a planned commit.

1. **Backoff stability window** (H1): counter resets only after
   `stableAfterMs` (default 10 s) connected; tests for a flapping server.
   Commits 5, 13.
2. **`error` listener always attached on `ws` sockets** (H2), including
   retired ones; `close()`/`send()` in `try/catch`; tests with injected `ws`
   for timeout during `CONNECTING` and `close()` during `CONNECTING`.
   Commit 9 (helper TCP server in commit 15 if needed).
3. **Bounded numbers** (M1): `hello.ok` limits clamped/validated, numeric
   details checked with `Object.hasOwn` + `Number.isFinite` + clamp, all
   `*Ms` options in `[0, 2^31-1]`, one clamped timer helper. Commits 2, 4, 7,
   10.
4. **Exact transport rule** (M2, Q-B): `new URL`, `ws:`/`wss:` only, exact
   loopback hostnames, no userinfo/hash, strict boolean opt-out; bypass
   tests. Commit 4.
5. **Busy-signal backoff** (M3) and **position-ack timeout rule** (M4, Q-C).
   Commits 8, 13.
6. **No unthrottled reconnects through `connect()`** after fatal/gave-up
   (M5). Commit 11/13.
7. Low items L1-L8 where they touch code (own-property reads, string caps,
   no stored options, one group request in flight, no internal unhandled
   rejections, post-handshake `welcome`/`hello.ok` ignored), and the README
   notes (L2, L3, L6, L7, M2, M5). Commits 2, 9, 11, 12, 16.

Unchanged and still required from the plan: API key only in `hello` and in
`#private`; no `console` in `src`; logger allowlist; fixed error messages;
length guard -> `JSON.parse` in try/catch -> iterative depth check ->
schema; unknown types ignored; no merge of server objects; no new
third-party runtime dependency.

## 6. What I will check in code mode

- gitleaks over the PR's commits (test API keys must be obvious test
  values, only in tests); semgrep on changed files; `pnpm audit`. Current
  baseline: 2 moderate advisories in `minimatch` via `eslint` (dev only, not
  reachable from the client; pre-existing).
- `package.json` runtime deps: only `@sync-system/protocol`. No `ws` in
  `dependencies`. Lockfile adds no new third-party packages.
- Each control in section 5, with its test.
- `src/` has no `console`, no `node:` imports, no `window`/`document`, no
  module-level side effects; `JSON.stringify` of a client, an error and the
  snapshot never contains the key; logger calls pass only fixed event names
  and primitive safe fields (no group ID, participant ID, URL, payload,
  server message).
- Every `setTimeout` goes through the clamped helper and is cleared on
  disconnect and `close()`; `vi.getTimerCount() === 0` after `close()`.
- Inbound path order and the absence of `Object.assign`/spread of server
  objects into client state.
- Fatal set matches Q4 + Q-A exactly; no reconnect after fatal; backoff not
  reset by flapping connections or by `connect()` after fatal.
- Dockerfile change is only the manifest `COPY`; runtime image unchanged.

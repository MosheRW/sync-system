# State: #3 Framework-free core client package
- Path: full
- Phase: validation
- Branch: feat/3-core-client
- PR: #4
- Plan approved by user: yes (Gate 2, 2026-11-01)
- QA loops: 1
- Security-sensitive: yes
- Review rounds: 2 (code review of PR #4; the plan had 2 security review rounds: round 1 FAIL, round 2 PASS)
- QA verdict: PASS (round 2, 2026-11-01): https://github.com/MosheRW/sync-system/pull/4#pullrequestreview-5729356946 (round 1 FAIL: https://github.com/MosheRW/sync-system/pull/4#pullrequestreview-5729212922)
- Last updated by: qa

## Notes
- PRD item 2 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1 (merged in PR #2).
- Designer skipped (no UI impact).

## Gate 1 decisions (user accepted the spec and every proposed default as written)
- Q1: on reconnect a member auto-rejoins its last group ID ('rejoined' with current position, or 'group ended' on GROUP_NOT_FOUND); a leader is never auto-rejoined (its group already ended; reports group ended / leader_disconnected, stays connected with no group). Token rejoin replaces this in item 3.
- Q2: client coalesces over-rate leader updates, always sending the latest when the rate allows; no opt-out.
- Q3: backoff 500 ms initial, 10 s max, doubling with full jitter, unlimited attempts while open; 10 s request timeout.
- Q4: 503 on upgrade, 4003, 4008, 1001 are retryable; INVALID_API_KEY, INVALID_APP_VERSION, PROTOCOL_TOO_OLD, APP_VERSION_TOO_OLD, SERVER_UNSUPPORTED are fatal (no reconnect).
- Q5: client supports exactly protocol 1 (own version and min server version), constant in the client package.
- Q6: connect() is explicit; group calls while not connected/reconnecting fail fast with NOT_CONNECTED; no queueing.
- Q7: Node-only tests (injected ws, SSR-import test, real sync server in-process); browser tests come with items 7-8.

## Gate 2 decisions (user approved the plan, architecture.md revision 2)
- Q-A: remaining handshake rejections (INVALID_MESSAGE, HANDSHAKE_REQUIRED, ALREADY_AUTHENTICATED, bare 4001) are fatal; 4002 handshake timeout, 4003, 4008 and internal errors stay retryable. Paired with M5.
- Q-B: wss:// required except the exact loopback hosts localhost, 127.0.0.1, [::1]; strict-boolean opt-out allowInsecureTransport; M2 URL rules.
- Q-C: hello/create/join timeouts reject with REQUEST_TIMEOUT and drop the socket; a position.update ack timeout only rejects, and drops only if nothing was received from the server for the whole window; every timeout-caused drop counts toward backoff.
- Q-D: AC27 "successful reconnect" = stayed connected for reconnect.stableAfterMs (10 s).
- Q-E: 30 s backoff cap for APP_CONNECTION_LIMIT (4003).
- Round-2 low findings R2-L1..R2-L6 approved as additions to the plan.

## Architecture
- Plan: docs/issues/3/architecture.md, revision 2 (22 planned commits, all done).
- AC10: unknown server message types are ignored (forward compatible); known types failing their schema, binary, non-JSON, too deep or too long frames give INVALID_SERVER_MESSAGE.
- AC24: states idle / connecting / connected / reconnecting (attempt, delayMs, retryAt, attempting) / closed (client | fatal | gave_up).

## Implementation
- 22 planned commits on feat/3-core-client (d2cb373 .. bfcc639).
- Checks: pnpm lint, typecheck, test (client 301 tests in 37 files, including 11 integration files against the real server; protocol and server suites unchanged and green), build, pnpm audit --audit-level=high (exit 0; 2 pre-existing moderate advisories in minimatch via eslint, dev only). docker build -f apps/sync-server/Dockerfile . succeeds.

## Security controls mapping (finding -> code -> test)
- H1 stability window: backoff.ts streakAfterDrop/streakAfterFailure; client.ts #connectionLost (timestamp at drop, no timer). Tests: backoff.test.ts, client.reconnect.test.ts "stability window", integration/flapping.int.test.ts (random injected).
- H2 ws error listener: transport.ts #ignoreError attached before close() and kept; send/close in try/catch. Tests: transport.test.ts "host safety", integration/ws-safety.int.test.ts (injected ws against blackhole-server, attempt timeout and close() while CONNECTING).
- M1 bounds: limits.ts (1 MiB / 100 / 10 000), errors.ts readDetailNumber (own, finite, >= 0), throttle.ts clamp to [slot, 10 s] and ring buffer, options.ts *Ms in [min, 2^31-1], host.ts setClampedTimeout. Tests: limits/transport, throttle, options, host, client.handshake.
- M2 URL rules: url-policy.ts. Tests: url-policy.test.ts.
- M3 busy floor: backoff.ts BUSY_STREAK_FLOOR, handshake.ts classifyClose/classifyHandshakeError. Tests: backoff.test.ts, client.reconnect.test.ts.
- M4 position ack rule: requests.ts timeout kinds, client.ts #onRequestTimeout with #lastInboundAt. Tests: client.requests.test.ts "position ack timeout", client.reconnect.test.ts "timeout-caused drop".
- M5 connect() after fatal/gave_up waits: client.ts connect(). Tests: client.close.test.ts.
- L1 own-property details, fixed-key objects: errors.ts. Tests: errors.test.ts.
- L2 string caps (serverMessage 256, issues 10 x 128, details 64, unknown type regex): errors.ts, client.ts. Tests: errors.test.ts, client.inbound.test.ts.
- L3 no cause/raw data in errors: errors.ts; README note. Tests: errors.test.ts.
- L4 options not stored, listener errors logged by name: options.ts, client.ts. Tests: options.test.ts, client.events.test.ts.
- L5 one group request in flight, re-queue cap 3: client.ts, throttle.ts. Tests: client.requests.test.ts, throttle.test.ts.
- L6 no internal unhandled rejections (callback tracker): requests.ts, client.ts. Tests: client.close.test.ts plus test/setup.ts in every file.
- L7 README: SSR singletons, ws maxPayload wrapper (also used by the integration helper).
- L8 welcome/hello.ok after connected ignored: client.ts #onReadyMessage. Tests: client.inbound.test.ts.
- R2-L1 option floors (initialDelayMs >= 100, maxDelayMs >= 1000, stableAfterMs >= 1000): options.ts. Tests: options.test.ts.
- R2-L2 out-of-bounds hello.ok limits fatal (SERVER_UNSUPPORTED with details.limit): handshake.ts checkHelloOk. Tests: handshake.test.ts, client.handshake.test.ts.
- R2-L3 connect with the validated href: url-policy.ts returns href, options.ts stores it. Tests: url-policy.test.ts, client.handshake.test.ts.
- R2-L4 in-flight flag cleared on every settle path: client.ts #trackGroupRequest. Tests: client.requests.test.ts, client.reconnect.test.ts, client.rejoin.test.ts.
- R2-L5 deterministic flapping test, runAttempts reset by the stability rule: client.ts #connectionLost. Tests: flapping.int.test.ts (random: () => 1), client.reconnect.test.ts.
- R2-L6 minimum gap between socket opens on close() + connect(): client.ts connect(). Tests: client.close.test.ts.

## QA (round 1)
- Checks: install --frozen-lockfile, lint, typecheck, test (protocol 22, server 343, client 301), build, server docker build: all exit 0. CI `check` pass.
- ACs: 31/32 met. AC7 not met as written: importing the package reads `navigator` (and runs zod's `new Function("")` probe) at import time through `@sync-system/protocol`; ssr-import.test.ts pre-loads protocol to avoid it (deviation 11, not user-approved).
- Finding 2: AC11 test does not cover NOT_CONNECTED while `reconnecting` (planned in architecture section 10).
- Deviations: all others accepted.

## Fix round 1 decisions (user)
1. AC7: fix in @sync-system/protocol (user-approved change to the protocol package, which the original plan ruled out). Importing the client (dist and source) must read no browser global and never call eval/new Function, including through zod.
2. QA finding 2: add the AC11 `reconnecting` case.
3. Security MEDIUM (close() from a listener during a drop): fix with a lifecycle generation checked after every emit.
4. Security LOW (send() throw leaves the socket open): close it.
5. Security LOW (throttled positions sent by reference): serialize once.
6. Copilot review (auto-fix on): also fix promise ownership (4436536884) and the stale RATE_LIMITED retry (4436536910); the lifecycle (4436536849), send-throw (4436536941) and deferred-payload (4436536959) comments are covered by fixes 3-5.
- Optional QA note (one socket fewer after closed(fatal|gave_up)): documented in the README, not changed (see deviations).

## Fix log (round 1)
- 1c0e205 fix(protocol): schemas are built with zod `jitless` on, then the previous setting is restored (zod's config is process-global, so other zod schemas in the process keep theirs). This skips zod's eval probe: no `navigator` read, no `new Function`. Protocol test test/import.test.ts (recording traps, restored setting). Perf: position.update parse 0.10 -> 0.33 us measured locally; protocol 24 and server 343 tests green. (QA finding 1, AC7)
- ee47021 test(client): ssr-import.test.ts no longer pre-loads protocol; it also rebuilds protocol + client and imports dist/index.js in a fresh Node process with recording getters on browser globals, Function and eval. Both tests fail on the old protocol. (QA finding 1, AC7)
- 3d13c62 test(client): AC11 NOT_CONNECTED while reconnecting (waiting and attempting), no group frame sent. (QA finding 2)
- ed5f646 fix(client): lifecycle generation bumped by close() and a new connect() run; connect(), close(), #connectionLost, #scheduleRetry, #retry, #fail, #giveUp and hello.ok return after an emit if it changed; reconnect timers registered before listeners are notified. Tests in client.close.test.ts: close() from groupEnded, subscribe, state (reconnecting, attempting, connecting with and without the R2-L6 gap) and during a fatal error -> closed(client), no socket, 0 timers. (Security #1 MEDIUM; Copilot 4436536849)
- 361e3a2 fix(client): the finishing connect() run is detached before the state is announced and settled by the flow that owns it (close, fatal, gave_up, hello.ok). Tests: connect() from a closed listener -> old promise rejects with CLOSED / INVALID_API_KEY / RECONNECT_FAILED, new promise settles on its own; close() from the connected listener still resolves the run that connected. (Copilot 4436536884)
- 4f187e1 fix(client): a throwing send() closes the socket through retire() (code 1000, no-op error listener kept) before onClose. Tests: transport.test.ts exactly one close() call, also when close() throws; client.reconnect.test.ts one close() then reconnect. (Security #2 LOW; Copilot 4436536941)
- 8cd5ec3 fix(client): updatePosition serializes once (INVALID_PAYLOAD if JSON.stringify throws), measures that text, and the throttle keeps and sends exactly that string (Transport.sendText). Tests: mutating a throttled or rate-limited position after updatePosition does not change the frame. (Security #3 LOW; Copilot 4436536959)
- 39c30a4 fix(client): each throttle submit() has a generation kept after the send; RATE_LIMITED re-queues only the latest generation and only on the throttle that sent it. Tests: throttle.test.ts (A then B sent, late reject of A ignored; equal values; after cancel), client.requests.test.ts. (Copilot 4436536910)
- f5ebc4a docs(client): README notes on listener reentrancy, the jitless import, and maxAttempts after closed(fatal|gave_up).
- Checks: pnpm lint, typecheck, test (protocol 24, server 343, client 324 in 37 files), build, pnpm audit --audit-level=high: all exit 0. The security repro script now ends in closed(client) with 1 socket; dist import with traps touches nothing.

## QA (round 2, head 3bc41e4)
- Checks: install --frozen-lockfile, lint, typecheck, test (protocol 24, server 343, client 324), build: all exit 0. CI `check` pass.
- ACs: 32/32 met. AC7 checked independently by importing client and protocol dist in plain Node with QA's own traps on browser globals, Function (and Function.prototype.constructor), eval and timers: 0 hits (a control zod schema without jitless does trigger them). zod's jitless setting is restored after import. AC11 reconnecting test present. AC28 close() from listeners tested, and reproduced against dist with a real ws server.
- Round-2 deviations all accepted (SSR dist build in beforeAll, skipped error event, maxAttempts note, parse 0.10 -> 0.33 us: measured 0.32 us, acceptable).
- Non-blocking notes: README does not mention the skipped error event; commit subjects of 1c0e205 (81 chars) and f5ebc4a (94 chars) exceed 72 (pushed, not amended).

## Open questions
- none

## Deviations from plan
- packages/client typecheck also runs `tsc -p tsconfig.build.json --noEmit --customConditions @sync-system/source`, so the no-DOM/no-Node build config (AC1) is checked in CI's typecheck step, before build.
- WebSocketLike listeners take `(event: unknown) => void` (needed so `ws` and DOM WebSocket types are assignable); the transport narrows events itself.
- GroupEndedReason adds `closed` (group left through the app's close()); indicatorOf maps an ended group with reason `closed` to `none`. GroupEndedInfo.code is a ClientErrorCode (a rejoin can fail with REQUEST_TIMEOUT or RECONNECT_FAILED).
- R2-L2 uses SERVER_UNSUPPORTED (four versions plus `details.limit`). A hello.ok whose limits fail the protocol schema itself (for example an unsafe integer like 2^53) stays a retryable INVALID_SERVER_MESSAGE, as for any invalid frame before hello.ok.
- L8 lives in client.ts message dispatch (commit 14), not handshake.ts, which keeps only pure functions. The M4 drop handling landed with the group calls (commit 15); its backoff counting with reconnect (commit 16).
- hello is not tracked in RequestTracker: the attempt timer (requestTimeoutMs) covers open + welcome + hello.ok and reports REQUEST_TIMEOUT with request 'hello'.
- maxAttempts counts reconnect attempts after the first try (maxAttempts 3 = up to 4 sockets), and `attempt` in the reconnecting state is the reconnect attempt number.
- close() applies the stability rule too: a connection up for at least stableAfterMs resets the streak, so close() + connect() after a long session connects at once.
- The R2-L6 gap applies to connect() from idle/closed with streak 0: the socket opens after the remaining gap while the state is `connecting`.
- The `error` event also fires for fatal errors and RECONNECT_FAILED (besides the connect() rejection and the closed state). Logger methods are all optional.
- (Superseded in fix round 1) The AC7 test used to pre-load @sync-system/protocol; it now imports the real graph, after the protocol fix.
- Fix round 1: the protocol package changed (user-approved, see "Fix round 1 decisions"). zod's `jitless` is switched on only while the protocol schemas are built, so they use zod's interpreted parser (about 0.2 us more per small frame).
- Fix round 1: ssr-import.test.ts runs `tsc -p tsconfig.build.json` for protocol and client in beforeAll (CI runs tests before the build step), so the dist check never reads a stale or missing build.
- Fix round 1: after a `close()`/`connect()` from a listener ends a fatal or gave-up flow early, the `error` event for that failure is skipped (the closed state still carries the error and the old promise still rejects with it).
- Fix round 1: RequestTracker's `position` field is no longer filled by the client (rate-limit retries go through a closure bound to the throttle and generation); the field and its test are unchanged.
- Fix round 1: optional QA note (after closed(fatal|gave_up) a run gets one socket fewer) documented in the README instead of changed: counting the first socket of such a run as attempt 0 would make `attempt` in the reconnecting state inconsistent.
- Fix round 1: commit f5ebc4a's subject is longer than 72 characters (pushed, so not amended).
- logging.test.ts (AC32) is in the integration-test commit (20), readme.test.ts in the README commit (21). Extra test helpers: test/helpers/client.ts, int.ts, wait.ts. The AC14 real-server tests wait 1.5 s instead of 2 s.

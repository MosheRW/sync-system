# Security review (plan): #1 Sync server core and monorepo scaffold

Issue: https://github.com/MosheRW/sync-system/issues/1 | PR: #2 (draft)
Reviewed: [`architecture.md`](./architecture.md) against [`spec.md`](./spec.md)
and `docs/PRD Group Reading Sync.md`.
Reviewer: security | Mode: plan | Result: **FAIL** (0 critical, 4 high,
6 medium, 8 low)

The plan already gets several things right: plain `ws` with `maxPayload`, the
API key sent in the first message instead of the URL, keys stored as sha256 and
looked up by hash, 256-bit group IDs from a CSPRNG, groups keyed by
`namespace + groupId`, the same `GROUP_NOT_FOUND` for other apps' IDs, no list
operation, hashed `groupRef` in logs, custom error formatting that does not echo
values, payloads never merged into server objects, `USER node` in Docker, and
`permissions: contents: read` in CI.

The blocking findings are all **availability** problems. One shared server runs
many apps, and the API key is public in browser apps, so anyone can get
authenticated. Without the controls below, one client with a script can crash
the process or run it out of memory, and that drops every live group of every
app. The fixes are small and fit into the planned commits.

## 1. Assets and trust boundaries

| Asset | Why it matters |
| --- | --- |
| Group ID | In #1 it is the only join capability (bearer secret). |
| Position payload and metadata | Opaque, but in the reading app they show what a group (possibly minors) is reading, and when. |
| Server availability | One process serves all apps and groups. A crash drops every group, and in #1 nothing recovers them. |
| API keys | Identify an app and pick its limits. They are public for browser clients but may be private for native or server clients. |
| Logs | Must not hold IPs, names, keys, payloads or raw group IDs (minors, PRD privacy). |
| Config file / image / CI | Hold or could leak keys. In #3 a JWT signing secret joins them. |

Trust boundaries:
1. Internet to HTTP/upgrade (unauthenticated, before the handshake).
2. Socket after the handshake (authenticated as *an app*, but the key is public,
   so treat it as anonymous).
3. Member vs leader inside a group.
4. App A vs app B, and group X vs group Y.
5. Operator files (config, env, compose) to the process, the image and the repo.

## 2. Threats (STRIDE, brief)

| | Threat | Covered by the plan? |
| --- | --- | --- |
| S | Pretend to be app X: use its public key | Accepted by design. Keys select config, they are not access control (sec. 9). OK for #1. |
| S | Pretend to be the leader of a group | Role is held in connection state on the server, not sent by the client. OK. |
| T | Member changes the position | `NOT_LEADER`. OK. |
| T | Prototype pollution through payloads | Stored as parsed values, never merged. See L6 on the zod record rebuild. |
| R | No audit trail | Intended (privacy). OK. |
| I | Join someone else's group | 256-bit IDs; another app's IDs give the same error. OK. See L3 on ID format. |
| I | Leak through logs, errors or health | Mostly covered. See M2 (JSON parse error echoes key), L5 (stack messages). |
| I | Sniff key, group ID and payload on the wire | **Not covered**: no TLS guidance (M3). |
| D | Connection flood / slowloris / pending handshakes | **Not covered** (H1). |
| D | Members that do not read (outbound buffering) | **Not covered** (H2). |
| D | Inbound message flood / unbounded queue | **Not covered** (H3). |
| D | One malformed frame crashes the process | **Not covered** (H4). |
| D | Deeply nested JSON causes stack overflow | **Not covered** (M4). |
| E | Get a group action before the handshake | `HANDSHAKE_REQUIRED` plus close. OK. |

## 3. Findings

### High (blocking)

**H1. No limit on connections, pending handshakes or slow HTTP requests.**
Plan sec. 9 ("global connection cap / per-IP limits are not in scope"), sec. 4,
sec. 5 Handshake.
*Attack:* one host opens tens of thousands of sockets. It can leave them
pre-handshake and reopen every 10 s, or authenticate with the public key and
create a group on each one (about 8 KB stored per socket, plus `ws` buffers). It
can also trickle HTTP headers (slowloris). File descriptors or heap run out and
the server crashes or stops accepting. Every app's groups are lost, which breaks
the user story "without any app hurting the others".
*Fix (add to the plan):*
- Env `MAX_CONNECTIONS` (default 10000). Check it in the `upgrade` handler
  before `handleUpgrade`. Over the cap, write `HTTP/1.1 503` and destroy the
  socket. Also set `server.maxConnections` slightly higher as a backstop.
- Env `MAX_PENDING_HANDSHAKES` (default 1000). Count sockets in
  `awaiting_hello`. Over the cap, refuse the upgrade with 503.
- Lower `HANDSHAKE_TIMEOUT` from 10 s to 5 s (a hello is one small message).
- Set `server.headersTimeout = 10_000` and `server.requestTimeout = 15_000`.
  Keep Node's default `maxHeaderSize`.
- Validate the new env values like the ceilings (AC6 rules). Document them in
  the README together with "put a reverse proxy with per-IP connection limits in
  front". Per-IP limits stay out of the app (behind a proxy, the IP is the
  proxy's, and IPs must stay out of logs).
- Tests: connection N+1 is refused with 503. A pending-handshake cap test. The
  counters go back down after close.

**H2. No outbound backpressure: a member that stops reading makes the server
buffer without limit.**
Plan sec. 5 Processing rules / Heartbeat, `notifier.ts`, `send.ts`.
*Attack:* the attacker opens a group as leader with its own 99 members (group
size ceiling 100). The members stop reading the TCP socket but send unsolicited
pong frames. RFC 6455 allows those, and the usual `on('pong') -> isAlive = true`
heartbeat accepts them. The leader sends 16 KB updates at 10/s. Each
`ws.send()` queues in user space: about 16 MB/s of heap growth from one group,
and the process runs out of memory within minutes.
*Fix:*
- In `send()`, check `ws.bufferedAmount` before sending. Above
  `MAX_BUFFERED_BYTES` (constant or env, e.g. `max(1 MiB, 64 * maxMessageBytes)`),
  `terminate()` that socket. The normal disconnect rules then remove it from the
  group. Never queue in our own code.
- Heartbeat: count a pong as alive only if a ping is outstanding (track
  `awaitingPong`). Also terminate if `bufferedAmount` has not dropped between
  two heartbeats.
- Test: a member that does not read is terminated once the threshold is passed,
  and the other members keep receiving updates.

**H3. No per-connection limit on inbound messages; the per-connection promise
queue is unbounded.**
Plan sec. 5 Processing rules ("per-connection promise queue"; "rejected updates
do not consume rate budget").
*Attack:* an authenticated socket sends frames of up to about 40 KB (the
`maxPayload`) as fast as TCP allows: oversized `position.update`s, `NOT_LEADER`
updates, `ALREADY_AUTHENTICATED` hellos, or `group.join`s with random IDs. None
of them counts against any limit. Each one costs a JSON parse, a zod parse and
`JSON.stringify`, and gets an error reply. The single event loop saturates
(latency for every app), and if the async store work is slower than arrival,
the queue grows without bound.
*Fix:*
- Per-connection inbound limiter on **all** message types, e.g. 20 messages/s
  with a burst of 40 (constant; must be above the leader rate ceiling). Over
  the limit: send `RATE_LIMITED` once and close with a new code `4008`
  (policy violation). Keep the per-group leader rate (AC22) unchanged.
- Cap the queue length (e.g. 32 pending messages). Over the cap, close `4008`.
- While a connection is over its limit, stop sending error replies (do not
  amplify).
- Tests: a flood closes the socket with 4008, and other connections are not
  affected.

**H4. Remotely triggered process crashes are not addressed.**
Plan sec. 2 (`connection.ts`, `server.ts`), sec. 9.
*Attack:* `ws` emits `'error'` on a `WebSocket` for protocol violations
(invalid UTF-8 in a text frame, a bad close code, a frame over `maxPayload`,
an RSV bit set). With no `'error'` listener, Node's EventEmitter throws and the
whole process exits. One crafted frame then drops every group on the server.
The same happens with an unhandled rejection in the per-connection promise
queue (in Node 24 the default is `--unhandled-rejections=throw`), or a throw in
an event handler (`group.ended` fan-out to a socket that is already closing).
*Fix:*
- Attach `ws.on('error', ...)` on every socket right after `handleUpgrade`, and
  an `'error'` listener on the `WebSocketServer` and the HTTP server
  (`clientError` -> `socket.destroy()`). Log only the error `code`/`name`.
- Every queued handler runs in `try/catch` that maps to `INTERNAL_ERROR`. The
  queue chain must never reject (`.catch` at the tail).
- `send()` is a no-op unless `ws.readyState === OPEN`.
- Tests: send a raw invalid-UTF-8 text frame and an over-`maxPayload` frame.
  Assert the server is still serving `/health` and other sockets. Send messages
  after a peer closes and assert no crash.

### Medium (advisory, recommended for #1)

**M1. Real config and env files are not ignored by git or Docker.**
Sec. 2 (`.gitignore`, `.dockerignore`), sec. 4 (default
`SYNC_CONFIG_PATH=./config/apps.json`).
*Scenario:* an operator creates `config/apps.json` (the default path) with real
keys and commits it (`.gitignore` only covers `.env*`). Or the build context
copies it into the builder stage. `.dockerignore` excludes neither `config/` nor
`.env*`. #3 adds a JWT secret, which raises the stakes.
*Fix:* `.gitignore`: `config/*.json` with `!config/apps.example.json` and
`!config/apps.dev.json`. `.dockerignore`: `config/`, `.env*`, `**/*.log`,
`coverage`. The Dockerfile copies only manifests, `packages/` and `apps/`
(no `COPY . .` of the repo root), and the image never contains a config file.
Config is only mounted at runtime.

**M2. A config JSON parse error can echo the API key.**
Sec. 4 ("Errors identify ... JSON parse position"), AC6.
*Scenario:* V8's `SyntaxError` messages for `JSON.parse` include a snippet of
the input (e.g. `Unexpected token ..., "...\"apiKey\": \"abc...` is not valid
JSON`). If `ConfigError` wraps `err.message`, the key goes to stderr and
container logs, which breaks AC6.
*Fix:* never pass on the `SyntaxError` message. Pull out only the position or
line/column with a regex and print `<path>: not valid JSON (line L, column C)`,
or just `not valid JSON`. Test: a syntax error placed directly after a key
value. Assert the key is not in stderr.

**M3. No transport security guidance; the dev compose port is exposed on all
interfaces.**
Sec. 5 (`ws://`), sec. 7 (compose `ports: ["8080:8080"]`).
*Scenario:* deployed as-is, the API key, the group ID (the join capability) and
minors' reading positions travel in cleartext. Anyone on the path can join
groups. The compose file with the committed dev key listens on every interface
of the developer machine.
*Fix:* the README states that any non-local deployment must sit behind TLS
(`wss://`) termination, with a short reverse-proxy example (also the place for
per-IP limits, H1). Compose maps `127.0.0.1:8080:8080`.

**M4. Deeply nested JSON can cause a stack overflow.**
Sec. 5 (size = `JSON.stringify(value)`; zod schemas for `JsonValue`).
*Scenario:* a 40 KB frame of `[[[[...]]]]` (about 20,000 levels deep) passes
`JSON.parse`. A recursive `z.lazy` JSON schema, or `JSON.stringify` during the
size check or relay, then throws `RangeError: Maximum call stack size exceeded`.
That is either a crash (see H4) or a stored payload that can never be
re-serialized for joiners.
*Fix:* do not validate payloads with a recursive zod schema. Use one iterative
walk that checks the JSON types and a max depth (e.g. 64 -> `INVALID_MESSAGE`)
before anything else. Test with a nesting depth of 10,000.

**M5. No per-app cap on concurrent groups or connections.**
User story "one server can serve many apps without any app hurting the
others".
*Scenario:* one app's buggy or abused client uses up the whole global budget
from H1, which starves the other apps.
*Fix:* an optional per-app `maxConnections`, checked after the hello, under an
env ceiling `MAX_APP_CONNECTIONS_CEILING`, with the same no-clamp rules (AC5).
If the user prefers, it can move to #5 or #9. Then record it as an accepted
risk in STATE.md.

**M6. The committed dev API key can reach production.**
Sec. 2 (`config/apps.dev.json`, key `dev-only-api-key-change-me`).
*Scenario:* someone deploys `compose.yaml` unchanged. Anyone who reads the
public repo can then use that app's limits on the operator's server.
*Fix:* at startup, log a `warn` (namespace only) if any key equals the known dev
key. When `NODE_ENV=production`, exit with a config error. The Dockerfile
already sets `NODE_ENV=production`, so compose overrides it with
`NODE_ENV=development` for the dev setup.

### Low (hygiene)

| # | Location | Issue | Fix |
| --- | --- | --- | --- |
| L1 | sec. 2 deps | Vulnerable versions: `ws` < 8.17.1 (CVE-2024-37890, header-count DoS), `semver` < 7.5.2 (ReDoS) | Require `ws@^8.18`, `semver@^7.7`. Add a `pnpm audit --audit-level=high` step to CI. |
| L2 | sec. 5 hello schema | Unbounded strings are hashed or parsed before rejection | `apiKey` <= 256 chars, `appVersion` <= 64 chars (zod `.max`) before sha256 or semver. |
| L3 | sec. 5 `group.join` | `groupId` has no format bound | Schema `^[A-Za-z0-9_-]{43}$`. A wrong format returns the same `GROUP_NOT_FOUND` (no oracle). |
| L4 | sec. 5 transport | `perMessageDeflate` is not specified; compression adds zip-bomb and memory risk | Set `perMessageDeflate: false` explicitly. |
| L5 | sec. 9 "INTERNAL_ERROR logs the stack" | The stack includes `err.message`, which can hold input fragments (e.g. JSON or zod messages) | Log `err.name` plus stack frames only (drop the first line), or a fixed message. Cover it in the AC24 test. |
| L6 | sec. 5 / AC14 | A zod `record`/`object` rebuild of `metadata` can drop or mis-assign a `__proto__` key | Validate without rebuilding (same walk as M4). Store the `JSON.parse` output. Keep the `__proto__` test. |
| L7 | sec. 4 `apiKey >= 16` | Short, human-chosen keys | README: generate with `openssl rand -base64 32`. Raise the minimum to 32. |
| L8 | sec. 7 Docker/CI | Floating base image and action tags | Pin `node:24-alpine@sha256:...` and actions to commit SHAs (or accept and record). Never log close `reason` strings sent by clients. |

Notes (no finding): there is no Origin check, which is fine because there are
no cookies or ambient credentials (cross-site WebSocket hijacking gives
nothing). Revisit if #3 or #4 ever use cookies. Group-ID brute force is not
feasible at 256 bits, and H3 also caps attempts per connection. The group ID
becomes a bearer secret in client apps: #7 and #8 must not put it in URLs,
analytics or logs.

## 4. Required controls (part of the plan)

The engineer implements these in #1. Each one has a test. Suggested placement
in the planned commits is in brackets.

1. Global connection cap, pending-handshake cap, 5 s handshake timeout, HTTP
   header and request timeouts, new env vars validated and documented (H1)
   [commits 5, 8, 9].
2. `bufferedAmount` threshold -> terminate. Pong counts only while a ping is
   outstanding (H2) [commits 11, 12].
3. Per-connection inbound message limiter on all types plus a queue length cap,
   close code `4008` added to `close-codes.ts` (H3) [commits 2, 9].
4. `'error'` listeners on every socket, the WebSocketServer and the HTTP server.
   Queue handlers never reject. `send()` guarded by `readyState`. Crash tests
   with raw invalid frames (H4) [commits 8, 9].
5. `.gitignore` / `.dockerignore` entries; the Dockerfile does not copy the
   repo root into the image (M1) [commits 1, 17].
6. No `SyntaxError.message` in config errors, with a test (M2) [commit 6].
7. README TLS requirement plus a reverse-proxy note; compose binds `127.0.0.1`
   (M3) [commits 17, 19].
8. Iterative JSON-type and depth validation (max depth 64) instead of a
   recursive schema (M4, L6) [commit 3].
9. Schema length bounds for `apiKey`, `appVersion`, `groupId` (L2, L3);
   `perMessageDeflate: false` (L4); dependency minimums plus a CI audit step
   (L1).

M5, M6, L5, L7 and L8 are recommended. If the user skips any of them, record
that in STATE.md under "Deviations from plan" as an accepted risk.

## 5. What I will check in code mode

- gitleaks over the PR commits (only the fake dev key should appear, and only in
  `config/apps.dev.json`); semgrep on the changed files; `npm audit` /
  `pnpm audit` for high and critical.
- Each required control above is present and has a test, especially the raw
  invalid-frame crash test, the slow-reader test and the flood test.
- `ws` options: `noServer`, path `/ws` only, `maxPayload`,
  `perMessageDeflate: false`; the upgrade handler checks the caps before
  `handleUpgrade`.
- The `upgrade` request and `req.socket.remoteAddress` are never passed to the
  logger. Redact paths are set. The AC24 test includes IPv4, IPv6 and
  IPv4-mapped forms and runs at `trace`.
- `ConfigError` and every error path never interpolate received values. JSON
  parse errors are handled as in M2.
- Group lookups always use `(namespace, groupId)`. `get` returns copies. There
  is no list path. The other-app error is byte-identical to the nonexistent-ID
  error.
- IDs come from `crypto.randomBytes` / `randomUUID` (no `Math.random`).
- Payloads are never spread or `Object.assign`ed into server objects.
- Dockerfile: multi-stage, `USER node`, no config or `.env` in any layer;
  `.dockerignore` and `.gitignore` as in M1; compose binds `127.0.0.1`.
- CI: `permissions: contents: read`, `pull_request` (not `pull_request_target`),
  no secrets, frozen lockfile.

## 6. Code review (PR #2, round 1, head `3459e85`)

Result: **PASS** (0 critical, 0 high, 2 medium, 2 low). The full comment is on
PR #2.

Scanners: gitleaks and semgrep are not installed. I grepped all 34 commits for
secrets by hand: only the public dev key and placeholders turned up.
`pnpm audit`: 0 high/critical, 2 moderate dev-only advisories (accepted).

Plan controls, all implemented and tested:

| ID | Where | Test |
| --- | --- | --- |
| H1 | `ws/upgrade.ts`, `server.ts`, `config/env.ts`, `limits/constants.ts` | `caps.int`, `http.int`, `env` |
| H2 | `ws/send.ts`, `ws/heartbeat.ts` | `slow-consumer.int`, `heartbeat`, `send` |
| H3 | `ws/inbound-limiter.ts`, `ws/connection.ts` | `flood.int`, `inbound-limiter` |
| H4 | `ws/connection.ts`, `ws/upgrade.ts`, `server.ts`, `index.ts` | `malformed-frames.int`, `robustness.int` |
| M1 | `.gitignore`, `.dockerignore`, `Dockerfile` | `repo-hygiene` |
| M2 | `config/apps-config.ts` `describeJsonSyntaxError` | `apps-config` |
| M3 | README "Security", `compose.yaml` | `repo-hygiene` |
| M4/L6 | `protocol/json-guard.ts`, `z.custom` opaque values | `json-guard`, `opaque-payload.int`, `malformed-frames.int` |
| M5 | `ws/handshake.ts`, `connection-counter.ts` | `caps.int` |
| M6 | `config/dev-key.ts`, compose `NODE_ENV=development` | `dev-key`, `repo-hygiene` |
| L1 | `ws@8.22.1`, `semver@7.8.5`, CI audit step | `repo-hygiene` |
| L2/L3 | `protocol/schemas.ts`, `GROUP_ID_PATTERN` | `handshake.int`, `isolation.int` |
| L4 | `perMessageDeflate: false` | `caps.int` |
| L5/L8 | `safeErr`, close reason not logged, digest/SHA pins | `privacy.int`, `repo-hygiene` |
| L7 | `MIN_API_KEY_LENGTH = 32`, README `openssl rand` | `apps-config` |

New advisories (not blocking):
- **S1 (Medium):** `ws` `closeTimeout` is left at its 30 s default, so a closed
  but unacknowledged socket holds a pending or connection slot for up to 30 s.
  Fix: `closeTimeout: 2_000`.
- **S2 (Medium):** the total outbound memory is only bounded by
  `MAX_CONNECTIONS x MAX_BUFFERED_BYTES` (about 10 GiB at the defaults; about
  1 GiB per public key). Fix: default 256 KiB plus a README sizing note.
- **S3 (Low):** `.dockerignore` `.env*` matches only at the root. Fix:
  `**/.env*`.
- **S4 (Low):** the dev key is refused only when `NODE_ENV=production`
  exactly. Fix: refuse unless development or test.

## Code re-review (round 2, head 5153780)

Scope: commits 43a4401, 3dccd7b, 7d818cf, 2b43041, 3e3fc8d, f6a8bd9,
eda6fed, 7211db9 (since the PASS at cd356d9). Verdict: **PASS**.

Advisories S1-S4 are closed:
- **S1:** `closeTimeout: 2_000` (`CLOSE_TIMEOUT_MS`) on the
  `WebSocketServer`; `ws@8.22.1` honours the option.
- **S2:** `MAX_BUFFERED_BYTES` default 256 KiB in `env.ts` and
  `compose.yaml`, plus a README memory-sizing note.
- **S3:** `.dockerignore` adds `**/.env*` and `**/config/apps*.json`.
- **S4:** `checkDevKeys` refuses the dev key unless `NODE_ENV` is exactly
  `development` or `test` (unset refuses). The Dockerfile keeps
  `NODE_ENV=production`; only compose (loopback-bound, dev registry) sets
  `development`.

Regression checks on the new code:
- `KeyedLock`: entries are removed in `finally` when the tail is still the
  caller's, so the map holds only keys with work in flight; a failed task
  still releases. No nesting on one key, and `endGroup` only enqueues on
  member queues (never awaits them), so a member's join waiting on the same
  lock cannot deadlock. Malformed IDs are rejected before the lock.
- `afterPending` tasks bypass the 32-message cap, but at most one is added
  per member per group end, so they are bounded.
- Ping/pong: `autoPong: false`; pings and pongs each take an inbound token
  (over the limit closes 4008); pongs are skipped, not queued, when the
  buffer would exceed the limit. A pong only clears the heartbeat when it
  echoes the random ping payload, so unsolicited pongs cannot keep a socket
  alive, and one pong per 30 s cannot starve the bucket.
- Join snapshot is taken in the same atomic store step as the insert.

Scanners: `pnpm audit` 0 high/critical, 2 moderate (`minimatch` via
`eslint`, dev-only, not reachable at runtime). gitleaks and semgrep are not
installed; the diff was checked for secrets by hand (none).

New advisory: **S5 (Low):** bump `eslint`'s `minimatch` (GHSA-g3hv-75wg-m249)
when a patched release is available; dev-only.

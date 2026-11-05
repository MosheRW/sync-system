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
| `@sync-system/client`   | `packages/client`   | Framework-free client for browsers and Node.   |
| `@sync-system/react`    | `packages/react`    | React/Next provider and hooks over the client. |

`packages/*` holds libraries and `apps/*` holds deployables.

The client's usage, API, events, error codes, connection states and
reconnect behavior are documented in
[`packages/client/README.md`](packages/client/README.md).
The React and Next.js provider, hooks and SSR rules are documented in
[`packages/react/README.md`](packages/react/README.md).

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
TOKEN_SECRET="$(openssl rand -base64 32)" \
  SYNC_CONFIG_PATH="$PWD/config/apps.json" pnpm --filter @sync-system/server dev
```

The `dev` script (tsx watch) runs in `apps/sync-server`, and
`SYNC_CONFIG_PATH` is resolved relative to the working directory, so pass an
absolute path as above. For a quick start with the public dev key, run
`NODE_ENV=development SYNC_CONFIG_PATH="$PWD/config/apps.dev.json" pnpm --filter @sync-system/server dev`
instead: the dev key is refused unless `NODE_ENV` is exactly `development`
or `test`. In those two environments `TOKEN_SECRET` may be left unset: the
server then uses a random secret per process and warns that tokens will not
survive a restart (see [Token secret](#token-secret)).

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
API key: the log shows a `dev api key in use` warning. With any other
`NODE_ENV` (the image default is `production`) the server refuses that key
and exits 1. Compose also sets the public development token secret
(`dev-only-insecure-token-secret-change-me-please`, logged as
`dev_token_secret`), so tokens survive `docker compose restart` and restart
recovery can be tried locally. It is refused outside `development`/`test`.

To run the image yourself, mount your own registry and point
`SYNC_CONFIG_PATH` at it. The image never contains a config file:

```sh
docker build -f apps/sync-server/Dockerfile -t sync-server .
docker run -p 127.0.0.1:8080:8080 \
  -v "$PWD/config/apps.json:/config/apps.json:ro" \
  -e SYNC_CONFIG_PATH=/config/apps.json \
  -e TOKEN_SECRET="$(cat /run/secrets/sync_token_secret)" sync-server
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
      "maxConnections": 1000,
      "maxSessionMinutes": 180,
      "inactivityLimitMinutes": 20,
      "joinMethods": ["A", "D"],
      "qrTicketSeconds": 300,
      "approvalTimeoutSeconds": 120,
      "disconnectGraceSeconds": 30,
      "keepAliveCountdownSeconds": 60,
      "defaultHandoff": "auto"
    }
  ]
}
```

| Field                       | Required | Default  | Rule                                                                                              |
| --------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------- |
| `namespace`                 | yes      |          | `^[a-z0-9][a-z0-9_-]{0,62}$`, unique.                                                             |
| `apiKey`                    | yes      |          | 32-256 characters, unique. Stored only as a sha256 hash.                                          |
| `minAppVersion`             | yes      |          | Valid semver. Older clients get `APP_VERSION_TOO_OLD`.                                            |
| `maxGroupSize`              | no       | 30       | Integer >= 2, <= `MAX_GROUP_SIZE_CEILING`. Leader counts.                                         |
| `maxLeaderUpdatesPerSecond` | no       | 5        | Integer >= 1, <= `MAX_LEADER_UPDATE_RATE_CEILING`.                                                |
| `maxMessageBytes`           | no       | 4096     | Integer >= 1, <= `MAX_MESSAGE_SIZE_CEILING`. Per field.                                           |
| `maxConnections`            | no       | 1000     | Integer >= 1, <= `MAX_APP_CONNECTIONS_CEILING`.                                                   |
| `maxSessionMinutes`         | no       | 180      | Integer >= 1, <= `MAX_SESSION_MINUTES_CEILING`. Group life.                                       |
| `inactivityLimitMinutes`    | no       | 20       | Integer >= 1, <= `INACTIVITY_LIMIT_MINUTES_CEILING`.                                              |
| `joinMethods`               | no       | `A`, `D` | Distinct letters `A`-`D`, each in `JOIN_METHODS_ALLOWED`. See [Joining](#joining-methods-a-to-d). |
| `qrTicketSeconds`           | no       | 300      | Integer >= 30, <= `QR_TICKET_SECONDS_CEILING`. QR ticket life.                                    |
| `approvalTimeoutSeconds`    | no       | 120      | Integer >= 15, <= `APPROVAL_TIMEOUT_SECONDS_CEILING`.                                             |
| `disconnectGraceSeconds`    | no       | 30       | Integer >= 1, <= `DISCONNECT_GRACE_SECONDS_CEILING`. See [Timers](#timers).                       |
| `keepAliveCountdownSeconds` | no       | 60       | Integer >= 1, <= `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING`, < `inactivityLimitMinutes` in seconds.   |
| `defaultHandoff`            | no       | `auto`   | `auto` or `frozen`: the handoff mode of a group created without one.                              |

- Unknown fields are rejected (catches typos).
- `joinMethods` omitted means `["A", "D"]` intersected with
  `JOIN_METHODS_ALLOWED` (an empty result is a startup error naming the app).
  A listed method the env does not allow is a startup error naming the app,
  the field and the method; it is never dropped.
- A value above its env ceiling is a startup error naming the app and field;
  values are never clamped. An omitted value uses `min(default, ceiling)`; an
  omitted `keepAliveCountdownSeconds` is also at most half the inactivity
  limit.
- Any invalid config makes the server print `Config error: ...` and exit 1.
  Errors name the file, app index, namespace and field, and never print an API
  key (JSON syntax errors report only the line and column).

Generate keys with:

```sh
openssl rand -base64 32
```

An API key identifies an app and selects its limits. In a browser app anyone
can read it, so it is **not** access control: join codes and QR tickets admit
people to a group, and codes resolve only within their own app.

### Environment variables

Numeric variables must be positive integers; anything else (empty, `0`, `-1`,
`1.5`, `abc`) is a startup error naming the variable. Unset means the default.

| Variable                               | Default              | Purpose                                                                  |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `SYNC_CONFIG_PATH`                     | `./config/apps.json` | Apps registry file (relative to the working directory).                  |
| `PORT`                                 | `8080`               | Listen port, 1-65535.                                                    |
| `HOST`                                 | `0.0.0.0`            | Bind address.                                                            |
| `LOG_LEVEL`                            | `info`               | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.          |
| `NODE_ENV`                             | unset                | The public dev API key is refused unless this is `development`/`test`.   |
| `TOKEN_SECRET`                         | none                 | Token signing secret; see [Token secret](#token-secret). Never logged.   |
| `TOKEN_SECRET_PREVIOUS`                | unset                | Old secret, verify only, during a rotation.                              |
| `MAX_GROUP_SIZE_CEILING`               | `100`                | Ceiling for `maxGroupSize`.                                              |
| `MAX_LEADER_UPDATE_RATE_CEILING`       | `10`                 | Ceiling for `maxLeaderUpdatesPerSecond`.                                 |
| `MAX_MESSAGE_SIZE_CEILING`             | `16384`              | Ceiling for `maxMessageBytes` (bytes).                                   |
| `MAX_APP_CONNECTIONS_CEILING`          | `10000`              | Ceiling for `maxConnections`. Must be <= `MAX_CONNECTIONS`.              |
| `MAX_CONNECTIONS`                      | `10000`              | Concurrent WebSockets, pending and authenticated. Over it: HTTP 503.     |
| `MAX_PENDING_HANDSHAKES`               | `1000`               | Sockets that have not sent hello yet. Must be <= `MAX_CONNECTIONS`.      |
| `MAX_INBOUND_MESSAGES_PER_SECOND`      | `20`                 | Per-connection message rate. Must be > `MAX_LEADER_UPDATE_RATE_CEILING`. |
| `MAX_INBOUND_BURST`                    | `40`                 | Per-connection burst. Must be >= `MAX_INBOUND_MESSAGES_PER_SECOND`.      |
| `MAX_BUFFERED_BYTES`                   | `262144`             | Outbound buffer per socket before drop. See the rule below.              |
| `MAX_SESSION_MINUTES_CEILING`          | `480`                | Ceiling for `maxSessionMinutes`.                                         |
| `INACTIVITY_LIMIT_MINUTES_CEILING`     | `60`                 | Ceiling for `inactivityLimitMinutes`.                                    |
| `TOKEN_REFRESH_ACTIVITIES`             | `10`                 | Leader updates that allow a token refresh after the min interval.        |
| `TOKEN_REFRESH_MIN_SECONDS`            | `60`                 | Min seconds between leader token refreshes. <= the max.                  |
| `TOKEN_REFRESH_MAX_SECONDS`            | `300`                | Max seconds between refreshes (<= 3600); also the recovery slack.        |
| `JOIN_METHODS_ALLOWED`                 | `A,B,C,D`            | Join methods any app may use: distinct `A`-`D`, comma-separated.         |
| `QR_TICKET_SECONDS_CEILING`            | `3600`               | Ceiling for `qrTicketSeconds`; 30-86400.                                 |
| `APPROVAL_TIMEOUT_SECONDS_CEILING`     | `600`                | Ceiling for `approvalTimeoutSeconds`; 15-3600.                           |
| `DISCONNECT_GRACE_SECONDS_CEILING`     | `120`                | Ceiling for `disconnectGraceSeconds`; 1-3600.                            |
| `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING` | `120`                | Ceiling for `keepAliveCountdownSeconds`; 1-3600.                         |

`MAX_BUFFERED_BYTES` must be at least `4 x MAX_MESSAGE_SIZE_CEILING`, at least
45056 (the largest `tokens.result`), and at least the largest roster snapshot
plus 32 KiB: `256 + (2 x MAX_GROUP_SIZE_CEILING + 2) x 320 + 32768` bytes
(97 664 at the default ceiling of 100).

Fixed limits: hello within 5 s, at most 32 queued messages per connection, JSON
nesting at most 64 levels, heartbeat ping every 30 s, HTTP header timeout 10 s
and request timeout 15 s. Tokens: 365 days `exp`, at most 2048 characters, 20
per `tokens.check`, 10 checks per connection per minute and 600 per app per
minute (shared by all of the app's connections), block lists of at most 256
IDs, ended groups remembered for at most 100 000 groups.

The per-app token check budget caps the HMAC work one app's clients can cause.
The accepted cost: the app key is public, so one client with many sockets can
use up the budget, and the app's real users then get `RATE_LIMITED` from
`checkTokens()` until the window moves on (resume, join and position updates
are not affected). The server then logs one `tokens_check_app_budget_exhausted`
warning per app per minute, with the namespace only.

Memory sizing: outbound buffers alone can reach
`MAX_CONNECTIONS x MAX_BUFFERED_BYTES` (10000 x 256 KiB, about 2.5 GiB at the
defaults), and one app's clients up to its `maxConnections x MAX_BUFFERED_BYTES`
(1000 x 256 KiB, about 250 MiB at the default). Give the process (and its
container memory limit) at least that much headroom, or lower `MAX_CONNECTIONS`
or `MAX_BUFFERED_BYTES` to fit the machine.

Inbound frames: the transport limit is
`max(2 x MAX_MESSAGE_SIZE_CEILING + 8192 + 16384, 45056)` bytes (57 344 at the
defaults; a recreation request carries metadata, a position, a token and a
block list). Queued inbound frames per connection are capped at 32 messages
and at 4 x the transport limit in bytes (229 376 at the defaults, including
the frame being handled); a frame over either cap closes the socket with
`TOO_MANY_MESSAGES` (4008). The worst case is about 224 KiB per socket, so at
`MAX_CONNECTIONS` (10000 x 224 KiB) inbound queues alone can reach about
2.1 GiB (2.3 GB), on top of the outbound buffers above. Size the machine for
both, or lower `MAX_CONNECTIONS`.

### Joining (methods A to D)

Each app picks its join methods (`joinMethods`) within `JOIN_METHODS_ALLOWED`,
and the leader picks the group's methods at creation (A and B are exclusive
in one group; the default drops B when A is allowed).

| Method | What the joiner enters                                | Admission              |
| ------ | ----------------------------------------------------- | ---------------------- |
| A      | 6-digit group code, then the 6-digit door code        | Direct                 |
| B      | 6-digit group code (optional display name)            | The leader approves    |
| C      | 8-character code (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`)  | Direct                 |
| D      | A QR ticket (signed, expires after `qrTicketSeconds`) | Direct (approval in B) |

Codes are drawn uniformly from the CSPRNG, are unique per app among live
groups, are freed when a group ends or leaves memory, and are sent only to
the leader. Input is case-insensitive; spaces and hyphens are ignored. A
recreated group keeps its codes when the leader's client sends the signed
codes blob and every code is still free; otherwise it gets a full new set.

Fixed join limits (not configurable):

| Limit                               | Value                                              |
| ----------------------------------- | -------------------------------------------------- |
| Join attempts per connection        | 10 per minute (code and QR, any outcome)           |
| Join attempts per app               | 600 per minute, shared by its connections          |
| Wrong door codes per app            | 60 per minute (`DOOR_FAILURES_PER_APP_PER_MINUTE`) |
| Door-code rotation                  | every 5th wrong door code since the last change    |
| Method A pause                      | 10 minutes after 3 door rotations in 30 minutes    |
| `codes.rotate` (leader)             | 6 per group per minute                             |
| `qr.issue` (leader)                 | 6 per connection per minute                        |
| Pending approvals                   | 10 per group, 1 per connection                     |
| Code draws before `CODES_EXHAUSTED` | 20                                                 |

**Brute-force reasoning.** Only per-group and per-app limits count: the
per-connection budgets reset when an attacker reconnects, so they reduce
noise but are not a security bound.

- _Door code, one targeted group._ The attacker knows the group code (it is
  shown openly). Every 5th wrong door code rotates it and tells the leader,
  with no time decay, and the 3rd rotation in 30 minutes pauses method A for
  10 minutes. Steady state: 5 guesses per 10 minutes, about 720 a day, each
  batch against a fresh 1-in-10^6 code: about 7 x 10^-4 per day per group,
  about 10^-4 per 180-minute session.
- _Door code, spread over all groups of one app._ At most 60 wrong door codes
  per app per minute: 60 x 1440 x 10^-6 = about **0.086 expected break-ins
  per app per day** under a nonstop attack (about 1 in 12 days). Such an
  attack is loud: thousands of door rotations reach leaders, and the server
  logs `door_failures_app_budget_exhausted` every minute.
- _Alphanumeric code (C)._ 31^8 = 8.5 x 10^11 codes; with the whole 600/min
  budget against 1000 live C groups, about 10^-3 per day.
- _QR tickets._ 256-bit HMAC; replay is bounded by the expiry, by the leader's
  `codes.rotate` and by a new code set on recreation (door rotations do not
  revoke them).

A 6-digit door code is a **"same room" control**: the joiner can see the
screen or hear the leader. Apps that need stronger admission should use C,
B (leader approval) or D.

Known limits and trade-offs:

- _Pause griefing._ Anyone who knows a group code can keep that group's
  method A paused (5 wrong codes per 10 minutes). The leader's way out is
  `codes.rotate`, which lifts the pause; at 60 wrong codes per minute one
  attacker can keep about 120 groups per app paused.
- _Wrong-door budget as a lever._ One client can use up an app's 60 wrong
  door codes per minute; method A joins with a door code in that app then get
  `RATE_LIMITED` until the minute passes (correct codes are never charged).
- _Group-code squatting._ Group creation has no per-connection rate or
  per-app cap yet, so one client could fill an app's 6-digit code space and
  others would get `CODES_EXHAUSTED`. Tracked in issue #12.
- _QR tickets are bearer credentials._ Keep `qrTicketSeconds` short; the
  ceiling allows tickets of up to 24 hours.

### Upgrading

- **Roles and lifecycle (#13):**
  - Tokens use format 2 with a leadership `term` claim. Format 1 tokens are
    `TOKEN_INVALID`; clients delete them and groups are created again.
  - A group whose participants are all disconnected is **held** for
    `disconnectGraceSeconds`, then **ends** (`empty`). It is no longer
    dropped and recreated by the leader's token in the same server process;
    recovery by token happens only after a server restart.
  - `blocklist.set` and the block list sent with a leader's resume only
    **add** IDs; nothing unblocks while the group is live. The client's
    `removeFromBlockList` is gone.
  - A removed participant's socket is closed with code 4004.
  - `MAX_BUFFERED_BYTES` must fit the largest roster snapshot (see above):
    with `MAX_GROUP_SIZE_CEILING=100`, at least 97 664.

- **Join by group ID removed (#10):** `group.join` is gone (it gets
  `INVALID_MESSAGE`) and the client's `joinGroup()` with it. Join with
  `group.joinByCode` / `joinByCode()` or `group.joinByQr` / `joinByQr()`.

- **`MAX_BUFFERED_BYTES` minimum (since #5):** the server refuses to start
  when `MAX_BUFFERED_BYTES` is below 45056, the largest `tokens.result` reply
  (20 re-signed tokens). Earlier versions accepted smaller values, such as
  `32768`. To fix the config, unset it (default 262144) or set it to at least
  `max(45056, 4 x MAX_MESSAGE_SIZE_CEILING)`.

### Token secret

Every participant gets a signed token (HS256 JWT) per group. Each app gets its
own signing key, derived from `TOKEN_SECRET` with HKDF, so one app's tokens
are useless on another. Generate the secret with:

```sh
openssl rand -base64 32
```

Rules, checked at startup (`Config error: ...`, exit 1, the value is never
printed):

- `TOKEN_SECRET` is **required** unless `NODE_ENV` is exactly `development`
  or `test` (an unset `NODE_ENV` counts as production). There, a missing
  secret means a random secret per process and the warning
  `token_secret_random`: tokens do not survive a restart.
- In every environment a set secret must be at least 32 bytes, have at least
  16 different byte values, must not start or end with whitespace (nothing is
  trimmed), and must not be an example value from these docs
  (`REPLACE-with-output-of-openssl-rand-base64-32`).
- The public development secret is accepted only in `development` and `test`.
- `TOKEN_SECRET_PREVIOUS` follows the same rules and must differ from
  `TOKEN_SECRET`. While it is set, the log shows `token_secret_previous_set`
  at startup, so it is not forgotten.
- Keep the secret out of git, images and logs; inject it from your secret store.
  Every instance of one deployment must use the same secret. Keep server clocks
  in sync (NTP): token times are server times, with 5 minutes of tolerance.

**Routine rotation** (no downtime, nobody logged out):

1. Set the new secret as `TOKEN_SECRET` and the old one as
   `TOKEN_SECRET_PREVIOUS`, and restart. Old tokens still verify, and every
   check, resume or refresh hands back a token signed with the new secret.
2. After `MAX_SESSION_MINUTES_CEILING` + `TOKEN_REFRESH_MAX_SECONDS` (8 h 5 min
   by default) remove `TOKEN_SECRET_PREVIOUS` and restart. Every old token is
   expired by then anyway.

**After a leak** (compromise): replace `TOKEN_SECRET` with a new value and
do **not** set the leaked one as `TOKEN_SECRET_PREVIOUS`. Otherwise tokens
forged with the leaked secret would be re-signed with the new one. All tokens
become invalid; clients delete them and groups must be created again. That is
the price of a leak.

Changing the HKDF label or salt in the code has the same effect as a new
secret.

### Timers

| Timer        | App field                                   | Default | Env ceiling (default)                        | What happens                                                                                    |
| ------------ | ------------------------------------------- | ------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Grace        | `disconnectGraceSeconds`                    | 30 s    | `DISCONNECT_GRACE_SECONDS_CEILING` (120)     | After the leader disconnects or misses the keep-alive: the group pauses, then (auto) hands off. |
| Inactivity   | `inactivityLimitMinutes`                    | 20 min  | `INACTIVITY_LIMIT_MINUTES_CEILING` (60)      | Leader inactivity before the group pauses; also the recovery window of a leader token.          |
| Keep-alive   | `keepAliveCountdownSeconds`                 | 60 s    | `KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING` (120) | The leader is prompted this long before the inactivity limit.                                   |
| Max session  | `maxSessionMinutes`                         | 180 min | `MAX_SESSION_MINUTES_CEILING` (480)          | Every group ends with `max_session`, whoever leads and in every state.                          |
| Handoff mode | `defaultHandoff` / `group.create` `handoff` | `auto`  | -                                            | `auto`: hand off after the grace; `frozen`: wait for the leader until the recovery bound.       |

Durations go on the wire as remaining milliseconds (`graceMs`, `countdownMs`,
`joinedAgoMs`), never as clock times, so client clocks do not matter.

### Roles and group lifecycle

- **Roles:** `leader`, one optional `vice-leader` (chosen by the leader from
  the connected members with `vice.set`, cleared with `vice.clear`), and
  `member`. Who leads is decided only by the live group record, never by a
  token: every leader action is checked against it under the group lock, so
  there are never two leaders. The vice has no leader powers and does not
  see the codes; only the leader and the vice know who the vice is.
- **Keep-alive:** any accepted leader action, position update,
  `leader.activity` (no payload, for a private preview) or `keepalive.ack`
  counts as activity. At the inactivity limit minus the countdown the leader
  gets `keepalive.prompt`; activity answers it (`keepalive.cleared`).
- **Pause and grace:** when the leader disconnects (others connected) or
  misses the countdown, the group pauses: members get
  `leader.offline {cause, graceMs?}`. The leader's return or next activity
  ends the pause (`leader.online`).
- **Handoff (`auto`):** when the grace ends with the leader still away, the
  connected vice or else the earliest admitted connected member leads. It
  gets `leader.granted` (a new leader token, the recovery state, the codes,
  the roster and pending requests); the old leader, if connected, gets
  `leader.lost` with a member token; everyone else gets `leader.changed` (no
  IDs). With nobody eligible, and in `frozen` mode, the group stays paused
  and ends with `leader_timeout` at the recovery bound.
- **Escalation:** a leader that got the lead through a missed keep-alive and
  misses its own ends the group with `inactivity` (no second handoff), unless
  it acted once in between.
- **Take-back:** the most recent displaced leader rejoins as a member with
  its old token (`takeback.offered`) and may send `leader.takeBack` to swap
  back (3 per group per minute). Leaving or being removed clears the offer.
- **Lock:** `group.lock` / `group.unlock` stop all new joining by every method
  and approvals with one `GROUP_LOCKED` answer; admitted members still
  rejoin by token, and pending requests wait.
- **Removal:** `member.remove` blocks a participant for the rest of the
  session (connected or offline), sends it `group.ended removed`, closes its
  socket with 4004, removes it from the roster and the vice slot, and rotates
  every code and the QR ticket generation (`codes.updated member_removed`).
  The block list only grows; at 256 IDs removals get `BLOCK_LIST_FULL`.
- **Roster:** only the leader gets it (`roster.snapshot`, `roster.updated`,
  `roster.removed`): ID, name, `generated`, role, connected flag and time
  since joining. Members never get another participant's ID or name.
- **Names:** `group.create`, the joins and `group.resume` take an optional
  `displayName` under the strict #10 rule (1-32 characters after trimming;
  no control, format, bidi, private-use or blank characters). Missing or
  blank gets a unique `Guest N` with `generated: true` and `guestNumber`, so
  apps can localize it. Names are plain text in memory only, never in tokens
  or logs. **Render them as text, never as HTML, and show `generated` (or
  the ID) so a chosen `Guest 3` cannot pass as a generated name.**
- **Empty groups:** when nobody is connected any more, the group is held,
  paused, for `disconnectGraceSeconds` (nobody new is admitted: the same
  `GROUP_LOCKED` as a locked group; token resumes still work), then ends
  (`empty`, logged only). A group that ended can't be recreated in the same
  server process by any token: later resumes get `GROUP_ENDED` and
  `tokens.check` says `ended`.
- Limits per group and minute: 10 removals, 10 lock changes, 10 vice
  changes, 3 take-backs, 12 `leader.activity` + `keepalive.ack` (the first
  ack of a prompt is free). Refused requests spend nothing.

### Recovery and tokens

The server still keeps nothing on disk; the leader's client is the group's
database (block list, lock, vice and handoff mode travel with its token).

- A leader disconnect **pauses** the group (see above). A paused group ends
  with `leader_timeout` when `inactivityLimitMinutes` +
  `TOKEN_REFRESH_MAX_SECONDS` have passed since the leader's last activity.
- Every group ends with `max_session` at `maxSessionMinutes` after it was
  created, leader online or not.
- **After a server restart** only: the leader's `group.resume` with its
  token **recreates** the group with the same ID, creation time and leader,
  plus the metadata, position, block list, lock, vice and handoff mode its
  client sends. Members that resumed first wait (`group.waiting`) and are
  admitted automatically. If a later leader token of the same group (one
  granted before the restart, still inside its window) arrives after a stale
  one recreated the group, it **supersedes** it: its block list applies, no
  code or QR ticket of the stale leader survives (the newer leader's codes
  are kept only if they share nothing with the stale ones, else every code
  and the ticket generation rotate), and people the stale leader admitted
  are flagged `admittedSinceRecovery` in the roster.
- The leader can `group.end` the group; a member can `group.leave`. Ended
  groups are remembered (as hashes) until their max-session deadline, so their
  tokens get `GROUP_ENDED`; a restart forgets that (accepted: the leader's
  client deletes its token on end).
- Leader tokens are refreshed (`token.refreshed`) after activity; member
  tokens are not.
- The block list binds token identities: a blocked participant cannot come
  back with its old identity on any path. The only way in with a new identity
  is a current code or QR ticket, so someone who still knows the current codes
  can join again as a new person; the leader's mitigation is `codes.rotate`.
- Join codes survive a restart through the leader's client: it keeps the
  server-signed codes blob and sends it with `group.resume`. Pending approval
  requests are lost on a restart.

### Protocol (v1) in brief

Plain WebSocket, one JSON object per text frame. The full protocol is in
[`docs/issues/1/architecture.md`](docs/issues/1/architecture.md) (section 5)
and the types are exported by `@sync-system/protocol`.

1. Server sends `welcome` with `protocolVersion` and `minProtocolVersion`.
2. Client sends `hello` with `protocolVersion`, `appVersion` (semver) and
   `apiKey`; the server answers `hello.ok` (with the app's limits) or an
   `error` and closes (4001; 4003 when the app is at `maxConnections`; 4002 if
   no hello arrives within 5 s).
3. `group.create` (`metadata`, optional `position` and `joinMethods`) makes
   the sender leader and returns its `codes`; `group.joinByCode` (`joinCode`,
   optional `doorCode` and `displayName`) and `group.joinByQr` (`ticket`)
   return the metadata and current position (or `hasPosition: false`), or
   `join.pending` when the leader must approve; `position.update` from the
   leader is relayed to every member as `position.updated`. `group.created`
   and `group.joined` carry the participant's token; `hello.ok` carries the
   app `namespace`, its `joinMethods` and its limits.
4. Leader join messages: `codes.rotate` (reply `codes.updated`), `qr.issue`
   (reply `qr.ticket`), `join.approve` / `join.deny` (reply `join.decided`);
   events `join.requested`, `join.withdrawn`, `join.paused`, `join.resumed`
   and unsolicited `codes.updated` after door-code failures. A joiner can
   `join.cancel`. See [`docs/issues/10/architecture.md`](docs/issues/10/architecture.md)
   (section 4).
5. `group.resume` (`token`, plus `metadata`, `position`, `blockList` and the
   `joinCodes` blob from a leader) answers `group.resumed` (leader, with its
   codes and `codesChanged`), `group.joined` or `group.waiting`
   (member). `tokens.check` (up to 20 tokens) answers one status per token:
   `live`, `recoverable`, `waiting`, `blocked`, `ended`, `expired` or
   `invalid`. `group.end`, `group.leave` and `blocklist.set` (leader) complete
   the set. See [`docs/issues/5/architecture.md`](docs/issues/5/architecture.md)
   (section 4).
6. `group.ended` reasons: `ended_by_leader`, `leader_timeout`, `max_session`,
   `inactivity`, `replaced` (the same participant resumed on another
   connection) and `removed` (blocked; the socket then closes with 4004).
7. Roles and lifecycle (#13): leader requests `vice.set`, `vice.clear`
   (reply `vice.updated`), `group.lock`, `group.unlock` (reply
   `lock.changed`), `member.remove` (reply `member.removed`, then
   `codes.updated`), `leader.activity`, `keepalive.ack` (reply
   `activity.ack`); `leader.takeBack` (reply `leader.granted`). Events:
   `roster.snapshot`, `roster.updated`, `roster.removed`, `vice.changed`,
   `keepalive.prompt`, `keepalive.cleared`, `leader.granted`, `leader.lost`,
   `leader.changed`, `takeback.offered`; `leader.offline` carries `cause`
   and `graceMs`. `hello.ok` adds the lifecycle timers and
   `defaultHandoff`. Tokens are format 2 (`term`). See
   [`docs/issues/13/architecture.md`](docs/issues/13/architecture.md)
   (section 5).

Errors carry a stable `code` (`CODE_NOT_FOUND`, `DOOR_CODE_REQUIRED`,
`DOOR_CODE_WRONG`, `JOIN_PAUSED`, `JOIN_DENIED`, `APPROVAL_TIMEOUT`,
`APPROVAL_QUEUE_FULL`, `QR_INVALID`, `QR_EXPIRED`, `GROUP_FULL`, `NOT_LEADER`,
`RATE_LIMITED`, `MESSAGE_TOO_LARGE`, `TOO_MANY_MESSAGES`, `TOKEN_INVALID`,
`TOKEN_EXPIRED`, `GROUP_ENDED`, `PARTICIPANT_BLOCKED`, `LEADER_CANNOT_LEAVE`,
`GROUP_LOCKED`, `NOT_ALLOWED`, `PARTICIPANT_NOT_FOUND`, `BLOCK_LIST_FULL`,
...). Every token failure gets the same `TOKEN_INVALID`, every unknown code
the same `CODE_NOT_FOUND` and every bad ticket the same `QR_INVALID`, so
errors reveal nothing about other groups or apps. A connection that floods messages gets
`TOO_MANY_MESSAGES` and close 4008, even if it is the leader (which freezes its
group).

### Deployment security

- **Run one instance per token secret, and restart it as an operator
  action.** The recovery and supersede rules assume one process at a time
  on a keyring: stop the old instance before starting the new one; no
  replicas or rolling deploys on one secret.
- **Keep the clock right (NTP).** A server clock that steps back across a
  restart can let a stale displaced leader keep the lead for good (the real
  leader's token then looks granted after the restart), and can make the
  server refuse recoveries (fail closed).
- **Restart residual.** After a restart, a displaced leader whose token is
  still inside its window (about 25 minutes by default) can recreate the
  group before the real leader. Until the real leader returns and supersedes
  it, it leads with its stale block list and codes: it can admit people
  (also someone removed earlier, under a new identity, through the stale
  codes), remove members, rotate codes, see the names of members who resume,
  and end the group for good. People it admitted are flagged
  `admittedSinceRecovery` after the supersede; review them.
- **Two restarts in a row.** Two restarts within one leader's inactivity
  limit plus `TOKEN_REFRESH_MAX_SECONDS` (about 25 minutes by default) can let
  a stale line keep the lead for good if the real leader stays away the whole
  time in between. Avoid restarting twice in quick succession while groups
  are live (a deploy followed by a quick rollback is the realistic case).
- **Recovery closure.** If the ended-groups memory (100 000 entries) fills
  with groups recreated after a restart, recoveries of the app with the most
  such entries are refused until their window passes (logged as
  `ended_groups_recovery_closed`). Availability only, never control.
- **Automatic handoff gives full control** to the successor (codes, block
  list, removal, including of the original leader). For sensitive sessions
  choose a vice-leader or the `frozen` mode.

- **Use TLS.** Any deployment beyond your own machine must sit behind TLS
  termination so clients connect with `wss://`. Without it the API key, join
  codes, QR tickets, tokens and reading positions travel in cleartext.
- **Use a reverse proxy** for TLS and for **per-IP connection and request
  limits**. The server caps global, pending and per-app connections, but it
  deliberately does not look at client IPs (behind a proxy they are the
  proxy's, and IPs stay out of the app and its logs).
- **Logs** never contain client IPs, display names, API keys, positions,
  metadata, tokens, participant IDs, block lists, secrets, join codes, door
  codes, QR tickets, codes blobs, join request IDs or raw group IDs
  (groups appear as a hash prefix). Keep it that way at the proxy too, or keep
  proxy logs short-lived.
- **Tokens are bearer credentials.** Whoever holds the current leader's token
  leads: resuming with it replaces the leader's connection. A displaced
  leader's token only rejoins as a member; while it is the most recent
  displaced leader (not removed, not left) it may take the lead back. After a
  restart, a leader token still inside its window (about 25 minutes by
  default) can recreate the group, and a later leader token of the same group
  supersedes it (see "Recovery and tokens"). `wss://` keeps tokens off the
  wire; the client README covers storing them.
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

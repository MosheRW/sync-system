# Wire protocol v1

The reference for the sync server's WebSocket protocol, version 1
(`PROTOCOL_VERSION = 1`, `MIN_CLIENT_PROTOCOL_VERSION = 1`). The types and
schemas are exported by
[`@mosherw/sync-system-protocol`](../packages/protocol/README.md), and the
client ([`@mosherw/sync-system-client`](../packages/client/README.md))
implements all of it. Write your own client only if you cannot use that one.

How the server behaves around these messages (join limits, timers, roles,
restarts, Redis) is in the [operator guide](operator-guide.md); the rules for
changing the protocol are in [`docs/versioning.md`](versioning.md).

## Transport and framing

- Plain WebSocket at `/ws` (`wss://` behind TLS in any real deployment).
- One JSON object per **text** frame. A binary frame, invalid JSON, a value
  that is not an object, nesting deeper than `MAX_JSON_DEPTH` (64), or a
  message that fails its schema gets `INVALID_MESSAGE`. Unknown fields are
  ignored.
- Every message has a `type`. Client requests may carry a `reqId` (a string
  of at most 64 characters); the reply to that request echoes it. Events
  have no `reqId`.
- Opaque values (`metadata`, `position`) are never read by the server: it
  stores and relays them, and checks only their size (`maxMessageBytes` of
  the app, per field) and depth.
- The server pings every 30 s; a client that does not answer is dropped.
- At most 32 queued inbound messages per connection; a flood gets
  `TOO_MANY_MESSAGES` and close `4008`.
- Durations are sent as remaining milliseconds (`graceMs`, `countdownMs`,
  `timeoutMs`, `expiresInMs`, `retryAfterMs`, `joinedAgoMs`), never as clock
  times, so client clocks do not matter.

## Handshake

1. On connect the server sends `welcome` with `protocolVersion` (the
   server's) and `minProtocolVersion` (the oldest client version it accepts).
   A client whose own minimum server version is above `protocolVersion`
   closes the connection (the client package's `MIN_SERVER_PROTOCOL_VERSION`
   is 1).
2. The client sends `hello` within 5 s with `protocolVersion`, `appVersion`
   (semver) and `apiKey`. The API key goes only in `hello`, never in the URL.
3. The server checks, in order: the protocol version (`PROTOCOL_TOO_OLD`,
   `details.minProtocolVersion`), the API key (`INVALID_API_KEY`), the app
   version format (`INVALID_APP_VERSION`) and minimum
   (`APP_VERSION_TOO_OLD`, `details.minAppVersion`), and the app's
   connection cap (`APP_CONNECTION_LIMIT`). A failure is an `error` followed
   by close `4001` (`4003` for the connection cap). No hello within 5 s is
   `HANDSHAKE_TIMEOUT` and close `4002`.
4. Success is `hello.ok`: the connection's `participantId`, the app's
   `namespace`, its `joinMethods`, its `limits` (`maxGroupSize`,
   `maxLeaderUpdatesPerSecond`, `maxMessageBytes`, `maxSessionMinutes`,
   `qrTicketSeconds`, `approvalTimeoutSeconds`, `inactivityLimitMinutes`,
   `disconnectGraceSeconds`, `keepAliveCountdownSeconds`) and its
   `defaultHandoff` (`auto` or `frozen`).

Any other message before `hello.ok` is `HANDSHAKE_REQUIRED`; a second
`hello` is `ALREADY_AUTHENTICATED`.

## Client messages

Fields marked `?` are optional. "Leader" means the request is accepted only
from the group's current leader (`NOT_LEADER` otherwise).

| Type               | Fields                                                                                                                       | Who         | Reply                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| `hello`            | `protocolVersion`, `appVersion`, `apiKey`                                                                                    | anyone      | `hello.ok`                                                |
| `group.create`     | `metadata` (object), `position?`, `joinMethods?`, `handoff?` (`auto`/`frozen`), `displayName?`                               | not in one  | `group.created`                                           |
| `group.joinByCode` | `joinCode` (6-digit group code or 8-character code), `doorCode?` (method A), `displayName?`                                  | not in one  | `group.joined`, or `join.pending` (method B)              |
| `group.joinByQr`   | `ticket`, `displayName?`                                                                                                     | not in one  | `group.joined`, or `join.pending` (method B)              |
| `join.cancel`      | (none)                                                                                                                       | joiner      | `join.cancelled`                                          |
| `position.update`  | `position`                                                                                                                   | leader      | `position.ack`; members get `position.updated`            |
| `group.resume`     | `token`, `displayName?`; leader only: `metadata?`, `position?`, `blockList?`, `joinCodes?`, `handoff?`, `viceId?`, `locked?` | token owner | `group.resumed`, `group.joined` or `group.waiting`        |
| `tokens.check`     | `tokens` (1 to 20)                                                                                                           | anyone      | `tokens.result`                                           |
| `group.end`        | (none)                                                                                                                       | leader      | `group.ended` (`ended_by_leader`)                         |
| `group.leave`      | (none)                                                                                                                       | member      | `group.left`                                              |
| `blocklist.set`    | `blockList` (participant IDs, at most 256)                                                                                   | leader      | `blocklist.ack`                                           |
| `codes.rotate`     | (none)                                                                                                                       | leader      | `codes.updated` (`rotated`)                               |
| `qr.issue`         | (none)                                                                                                                       | leader      | `qr.ticket`                                               |
| `join.approve`     | `requestId`                                                                                                                  | leader      | `join.decided`                                            |
| `join.deny`        | `requestId`                                                                                                                  | leader      | `join.decided`                                            |
| `vice.set`         | `participantId`                                                                                                              | leader      | `vice.updated`                                            |
| `vice.clear`       | (none)                                                                                                                       | leader      | `vice.updated`                                            |
| `group.lock`       | (none)                                                                                                                       | leader      | `lock.changed`                                            |
| `group.unlock`     | (none)                                                                                                                       | leader      | `lock.changed`                                            |
| `member.remove`    | `participantId`                                                                                                              | leader      | `member.removed`, then `codes.updated` (`member_removed`) |
| `leader.activity`  | (none; a private preview never reaches the server)                                                                           | leader      | `activity.ack`                                            |
| `keepalive.ack`    | (none)                                                                                                                       | leader      | `activity.ack`                                            |
| `leader.takeBack`  | (none)                                                                                                                       | see below   | `leader.granted` (`take_back`)                            |

Notes:

- `group.create` makes the sender the leader. `joinMethods` is a non-empty
  subset of the app's methods, never both A and B; omitted, it is the app's
  methods minus B when A is there.
- `group.joinByCode` tells the code kind apart by its format after
  normalization (case-insensitive; spaces and hyphens ignored). A method A
  group code without `doorCode` gets `DOOR_CODE_REQUIRED`.
- `group.resume` rejoins with a participant token. A leader recreating a
  group after a restart (without Redis, or after Redis lost its data) sends
  its `metadata` and may send its `position`, `blockList`, the signed
  `joinCodes` blob and its recovery state (`handoff`, `viceId`, `locked`).
  The display name is sent again on every resume.
- `leader.takeBack` is accepted only from the leader displaced by the last
  handoff (it got `takeback.offered`); anyone else gets `NOT_ALLOWED`.

## Server messages

| Type                | Fields                                                                                                                                                                                                | To                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `welcome`           | `protocolVersion`, `minProtocolVersion`                                                                                                                                                               | every new connection                   |
| `hello.ok`          | `participantId`, `namespace`, `joinMethods`, `limits`, `defaultHandoff`                                                                                                                               | the client, after `hello`              |
| `group.created`     | `groupId`, `participantId`, `role: leader`, `displayName`, `generated`, `handoff`, `state`, `token`, `joinMethods`, `codes`                                                                           | the creator                            |
| `group.joined`      | `groupId`, `participantId`, `role: member`, `displayName`, `generated`, `metadata`, `token`, `leaderOnline`, `locked`, `leaderPause?`, `hasPosition` and `position` (only when `hasPosition` is true) | the joiner, or a resuming member       |
| `group.resumed`     | `groupId`, `participantId`, `role: leader`, `displayName`, `generated`, `metadata`, `token`, `recreated`, `joinMethods`, `codes`, `codesChanged`, `state`, `superseded`, `hasPosition`, `position?`   | a resuming leader                      |
| `group.waiting`     | `groupId`                                                                                                                                                                                             | a member waiting for its leader        |
| `tokens.result`     | `results`: one `{ status, token? }` per token, in order                                                                                                                                               | the client, after `tokens.check`       |
| `position.ack`      | (none)                                                                                                                                                                                                | the leader                             |
| `position.updated`  | `groupId`, `position`                                                                                                                                                                                 | members                                |
| `group.ended`       | `groupId`, `reason`                                                                                                                                                                                   | every participant                      |
| `group.left`        | `groupId`                                                                                                                                                                                             | the member who left                    |
| `blocklist.ack`     | (none)                                                                                                                                                                                                | the leader                             |
| `token.refreshed`   | `groupId`, `token`                                                                                                                                                                                    | the leader, after activity             |
| `leader.offline`    | `groupId`, `cause?` (`disconnected`/`inactive`), `graceMs?`                                                                                                                                           | members: the group is paused           |
| `leader.online`     | `groupId`                                                                                                                                                                                             | members: the pause ended               |
| `codes.updated`     | `groupId`, `reason`, `codes`                                                                                                                                                                          | the leader                             |
| `join.paused`       | `groupId`, `retryAfterMs`                                                                                                                                                                             | the leader: door-code joining paused   |
| `join.resumed`      | `groupId`                                                                                                                                                                                             | the leader: door-code joining resumed  |
| `join.pending`      | `requestId`, `timeoutMs` (no group ID before admission)                                                                                                                                               | a method B joiner                      |
| `join.requested`    | `groupId`, `requestId`, `expiresInMs`, `displayName?`                                                                                                                                                 | the leader                             |
| `join.withdrawn`    | `groupId`, `requestId`, `reason` (`cancelled`, `disconnected`, `timeout`)                                                                                                                             | the leader                             |
| `join.decided`      | `requestId`, `outcome` (`admitted`, `group_full`, `denied`)                                                                                                                                           | the leader                             |
| `join.cancelled`    | `requestId`                                                                                                                                                                                           | the joiner                             |
| `qr.ticket`         | `ticket` (opaque, URL-safe, at most 256 characters), `expiresInMs`                                                                                                                                    | the leader                             |
| `roster.snapshot`   | `groupId`, `participants` (roster entries)                                                                                                                                                            | the leader                             |
| `roster.updated`    | `groupId`, `participant` (one roster entry)                                                                                                                                                           | the leader                             |
| `roster.removed`    | `groupId`, `participantId`                                                                                                                                                                            | the leader                             |
| `vice.updated`      | `groupId`, `viceId` (or `null`)                                                                                                                                                                       | the leader                             |
| `vice.changed`      | `groupId`, `isVice`                                                                                                                                                                                   | the participant concerned only         |
| `lock.changed`      | `groupId`, `locked`                                                                                                                                                                                   | the leader (reply) and members         |
| `member.removed`    | `groupId`, `participantId`, `blockList`                                                                                                                                                               | the leader                             |
| `activity.ack`      | (none)                                                                                                                                                                                                | the leader                             |
| `keepalive.prompt`  | `groupId`, `countdownMs`                                                                                                                                                                              | the leader                             |
| `keepalive.cleared` | `groupId`                                                                                                                                                                                             | the leader                             |
| `leader.granted`    | `groupId`, `reason` (`handoff_disconnect`, `handoff_inactivity`, `take_back`), `token`, `state`, `joinMethods`, `codes`                                                                               | the new leader                         |
| `leader.lost`       | `groupId`, `reason` (`handoff_disconnect`, `handoff_inactivity`, `take_back`, `superseded`), `token` (a member token), `takeBackAvailable`                                                            | the displaced leader                   |
| `leader.changed`    | `groupId`, `reason` (no participant ID)                                                                                                                                                               | every other member                     |
| `takeback.offered`  | `groupId`                                                                                                                                                                                             | the displaced leader, back as a member |
| `error`             | `code`, `message` (for humans; never branch on it), `details?`                                                                                                                                        | the requester                          |

Shared shapes:

- `codes` (leader only): `generation` (rises on every change), `groupCode?`
  (methods A, B), `doorCode?` (A), `alphaCode?` (C) and `blob`, a
  server-signed copy of the codes for recovery.
- `state` (leader recovery state): `blockList`, `locked`, `viceId?`,
  `handoff`. The leader's client keeps it with its token.
- Roster entry: `participantId`, `displayName`, `generated`, `guestNumber?`,
  `role` (`leader`, `vice-leader`, `member`), `connected`, `joinedAgoMs`,
  `admittedSinceRecovery?`. Members never get another participant's ID or
  name.
- `leaderPause`: `cause` and `graceMs?` (present only when a handoff can
  follow).
- Display names are plain text: 1 to 32 characters after trimming, no
  control, format, bidi, private-use or blank characters. Missing or blank
  gives a generated `Guest N` with `generated: true`. **Render them as text,
  never as HTML.**

Enumerations:

| Field                     | Values                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `group.ended` `reason`    | `ended_by_leader`, `leader_timeout`, `max_session`, `inactivity`, `replaced` (the same participant resumed on another connection), `removed` (blocked) |
| `tokens.result` `status`  | `live`, `recoverable`, `waiting`, `blocked`, `ended`, `expired`, `invalid`                                                                             |
| `codes.updated` `reason`  | `rotated`, `door_failures`, `member_removed`, `superseded`                                                                                             |
| `leader.changed` `reason` | `handoff_disconnect`, `handoff_inactivity`, `take_back`, `superseded`                                                                                  |
| Join methods              | `A` (group code + door code), `B` (group code + leader approval), `C` (8-character code), `D` (QR ticket)                                              |

## Error codes

Every error is `{ "type": "error", "reqId"?, "code", "message", "details"? }`.
Branch on `code`. Every token failure gets the same `TOKEN_INVALID`, every
unknown code the same `CODE_NOT_FOUND` and every bad ticket the same
`QR_INVALID`, so errors reveal nothing about other groups or apps.

| Code                      | Meaning                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `INVALID_MESSAGE`         | Bad JSON, a binary frame, a schema failure or nesting deeper than allowed.                                          |
| `HANDSHAKE_REQUIRED`      | A message other than `hello` before `hello.ok`.                                                                     |
| `HANDSHAKE_TIMEOUT`       | No `hello` within 5 s (then close `4002`).                                                                          |
| `ALREADY_AUTHENTICATED`   | A second `hello`.                                                                                                   |
| `INVALID_API_KEY`         | Missing or unknown API key.                                                                                         |
| `PROTOCOL_TOO_OLD`        | The client's protocol version is below the server's minimum; `details.minProtocolVersion`.                          |
| `INVALID_APP_VERSION`     | `appVersion` is not valid semver.                                                                                   |
| `APP_VERSION_TOO_OLD`     | `appVersion` is below the app's `minAppVersion`; `details.minAppVersion`.                                           |
| `APP_CONNECTION_LIMIT`    | The app has its maximum number of connections (then close `4003`).                                                  |
| `GROUP_NOT_FOUND`         | Unknown, malformed or another app's group ID.                                                                       |
| `GROUP_FULL`              | Joining would exceed `maxGroupSize`; `details.maxGroupSize`.                                                        |
| `ALREADY_IN_GROUP`        | Create or join while already in a group.                                                                            |
| `NOT_IN_GROUP`            | A group request while not in a group.                                                                               |
| `NOT_LEADER`              | A leader request from someone who is not the leader.                                                                |
| `RATE_LIMITED`            | Over a rate (position updates, joins, creates, token checks, ...); `details.retryAfterMs` where a wait helps.       |
| `MESSAGE_TOO_LARGE`       | A field is over the app's `maxMessageBytes`; `details.field`, `details.limitBytes`.                                 |
| `TOO_MANY_MESSAGES`       | The connection flooded messages; it is closed with `4008`, even the leader's.                                       |
| `INTERNAL_ERROR`          | An unexpected server error for this one request.                                                                    |
| `LEADER_CANNOT_LEAVE`     | The leader sent `group.leave`; it must end the group instead.                                                       |
| `TOKEN_INVALID`           | The token is not valid here (bad signature or shape, another app's, unknown format, expired `exp`).                 |
| `TOKEN_EXPIRED`           | The token is past its group's max session or recovery window.                                                       |
| `GROUP_ENDED`             | The token's group ended.                                                                                            |
| `PARTICIPANT_BLOCKED`     | The participant is on the group's block list.                                                                       |
| `JOIN_METHOD_NOT_ALLOWED` | A join method the app does not allow, or a QR ticket for a group without method D.                                  |
| `CODES_EXHAUSTED`         | No free join code was found; nothing was created.                                                                   |
| `CODE_NOT_FOUND`          | The code matches no live group of this app (or a group that does not use that code type).                           |
| `DOOR_CODE_REQUIRED`      | A method A group code without a door code (not counted as a failure).                                               |
| `DOOR_CODE_WRONG`         | A wrong door code (counted; every 5th rotates the door code).                                                       |
| `JOIN_PAUSED`             | Door-code joining of this group is paused after repeated failures; `details.retryAfterMs`.                          |
| `JOIN_DENIED`             | The leader denied the method B request.                                                                             |
| `APPROVAL_TIMEOUT`        | The leader did not decide within `approvalTimeoutSeconds`.                                                          |
| `APPROVAL_QUEUE_FULL`     | The group already has its maximum of pending requests; `details.maxPending`.                                        |
| `JOIN_REQUEST_NOT_FOUND`  | Approve, deny or cancel of an unknown or settled request.                                                           |
| `QR_INVALID`              | The QR ticket is not valid here (malformed, too long, bad signature, another app, a revoked or unknown group).      |
| `QR_EXPIRED`              | A valid ticket whose time has passed.                                                                               |
| `NOT_ALLOWED`             | The action may not target this participant (the leader itself, an offline vice, a take-back by anyone else).        |
| `PARTICIPANT_NOT_FOUND`   | The participant ID is not on this group's roster.                                                                   |
| `GROUP_LOCKED`            | The group admits nobody new right now (locked by the leader, or nobody connected).                                  |
| `BLOCK_LIST_FULL`         | The block list would exceed 256 IDs; nothing changed; `details.maxBlockList`.                                       |
| `APP_GROUP_LIMIT`         | `group.create` refused: the app has its maximum of live groups; `details.maxLiveGroups` (the cap, never the count). |

## Close codes

| Code   | Name                   | Meaning                                                                                                     |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `1001` | `GOING_AWAY`           | The server is shutting down **or temporarily unavailable** (its storage is unreachable): resume later.      |
| `4001` | `HANDSHAKE_REJECTED`   | The handshake failed (bad key or versions, invalid hello, a message before hello).                          |
| `4002` | `HANDSHAKE_TIMEOUT`    | No hello within 5 s.                                                                                        |
| `4003` | `APP_CONNECTION_LIMIT` | The app reached its connection limit; retry later.                                                          |
| `4004` | `REMOVED`              | The leader removed this participant, right after `group.ended` (`removed`). Do not reconnect to that group. |
| `4008` | `POLICY_VIOLATION`     | Inbound message flood or queue overflow (`TOO_MANY_MESSAGES`).                                              |

## Tokens

`group.created`, `group.joined`, `group.resumed`, `leader.granted`,
`leader.lost` and `token.refreshed` carry a participant token: an HS256 JWT,
format 2, at most 2048 characters. Treat it as an opaque bearer credential:
whoever holds a leader's current token leads. Its claims (`v`, `aud`, `gid`,
`pid`, `role`, `gct`, `lat`, `term`, `iat`, `exp`) hold no personal data and
nothing secret; `decodeTokenClaims` in the protocol package reads them
without verifying (only the server verifies). Format 1 tokens (before #13)
are `TOKEN_INVALID`. Store tokens as the client README describes.

## Limits

| Limit                         | Value                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| JSON nesting                  | 64 levels                                                                             |
| `reqId`                       | 64 characters                                                                         |
| API key                       | 256 characters                                                                        |
| `appVersion`                  | 64 characters parsed as semver (256 accepted by the schema)                           |
| Group ID                      | 43 characters, `[A-Za-z0-9_-]`                                                        |
| Participant ID                | a lowercase UUID v4                                                                   |
| Token                         | 2048 characters; 20 per `tokens.check`                                                |
| Block list                    | 256 participant IDs                                                                   |
| Display name                  | 32 characters after trimming (128 raw)                                                |
| `joinCode` / `doorCode` input | 32 characters before normalization                                                    |
| QR ticket                     | 256 characters (512 accepted by the schema)                                           |
| Codes blob                    | 512 characters                                                                        |
| Group code, door code         | 6 digits                                                                              |
| Alphanumeric code (method C)  | 8 characters of `23456789ABCDEFGHJKMNPQRSTUVWXYZ`                                     |
| `metadata`, `position`        | the app's `maxMessageBytes` per field                                                 |
| Roster                        | `2 x maxGroupSize` entries (up to 2 more: the leader, vice and take-back holder stay) |

Rate limits, join limits and the timers are server configuration: see the
[operator guide](operator-guide.md#joining-methods-a-to-d) and its
[Timers](operator-guide.md#timers).

## Versioning

- `PROTOCOL_VERSION` is the version a build speaks; `MIN_CLIENT_PROTOCOL_VERSION`
  is the oldest client version the server accepts. Both are 1 in every 1.x
  release so far.
- The server announces both in `welcome`; a client below the minimum gets
  `PROTOCOL_TOO_OLD` and close `4001`. A client refuses a server whose
  `protocolVersion` is below its own `MIN_SERVER_PROTOCOL_VERSION`.
- Additions a peer may ignore (an optional field, a new event) do not change
  the version; what does is in [`docs/versioning.md`](versioning.md).

# Spec: #5 Participant tokens, token rejoin and restart recovery

Issue: https://github.com/MosheRW/sync-system/issues/5
Source PRD: `docs/PRD Group Reading Sync.md` ("Identity, tokens and recovery", plus "Group lifecycle", "Timers", "Roles" and "Storage" in Product 2 / Deliverables)
Path: full | Type: feat | PRD item 3 of 9
Numbering: "item N" below means PRD item N of 9, not GitHub issue N. Item 1 is GitHub #1 (server core, merged in PR #2). Item 2 is GitHub #3 (core client, merged in PR #4).
Builds on: `@sync-system/protocol`, `apps/sync-server` (#1) and `@sync-system/client` (#3).

## Problem / motivation

The PRD's second principle is "the leader's browser is the group's database": the server keeps no persistent records, yet groups must survive leader disconnects, idle leaders and server restarts. Today:

- Every group lives only in server memory. A restart (or a deploy) destroys every group, and nobody can get back in.
- A leader disconnect ends the group at once (#1 AC17), so a leader whose phone locks for a few seconds loses the group. This breaks the v1 success criterion "Leader whose phone locks briefly returns to the same group, still leading" (30 s, confirmed in #1).
- A participant's identity is per connection (a new participant ID on every `hello.ok`), so nothing can identify "the same member" after a reconnect, and a removed member can't be kept out.
- The client (#3) rejoins a member by re-sending `group.join` with the bare group ID. That only works while the group is live and while joining by ID is allowed; join codes (item 4) will make the group ID useless as a credential.

This issue adds signed per-group participant tokens (JWT), token storage in the core client, a privacy-safe "which of my groups are live" check, token-based rejoin for leaders and members, group recreation after a restart from the leader's token plus the leader's client-held state (metadata, position, block list), and the server-side secret configuration that all of this depends on.

## User stories

- As a **leader whose phone locked briefly**, I want to come back to the same group still leading, without codes, so that the group isn't lost.
- As a **member**, I want to rejoin my group automatically after a network drop, a phone lock or a server restart, without entering codes, so that I keep following.
- As a **leader after a server restart or deploy**, I want my group recreated with the same ID, position and block list as soon as my client reconnects, so that the session resumes where it was.
- As a **user who reopens the app later**, I want the app to know which of my groups are still live or resumable, so that it can offer "return to your group" instead of a blank start.
- As a **leader**, I want members I blocked to stay out after a restart, so that removing someone sticks even though the server forgot everything.
- As a **privacy-conscious operator** (users may be minors), I want tokens, participant IDs and block lists never logged and nothing persisted on the server, so that a session leaves no trace.
- As a **self-hoster**, I want a clear startup error when the token secret is missing or weak in production, and a way to rotate it without logging everyone out, so that I can run the server safely.
- As a **client app developer** (Node, SSR or tests), I want to plug in my own token storage, so that the client works without `localStorage`.
- As **another client app on the same server**, I want my tokens to be useless on other apps and theirs useless on mine, so that app isolation holds.

## Proposed design decisions (confirm at Gate 1)

These are the PM's proposed defaults; each also appears under Open questions.

1. **One token per participant per group.** HS256 JWT signed with a server-only secret. Claims: token format version, app namespace (audience), group ID, participant ID, role, group creation time, last-activity time, issued-at, expiry (issued-at + 365 days). No personal data. The JWT payload is readable by the client (not encrypted); nothing in it is secret.
2. **Group-scoped, stable participant ID.** The participant ID inside the token is the participant's identity in that group. It stays the same across reconnects, token rejoins and recreation, and it is what the block list holds.
3. **Leader disconnect no longer ends the group.** The group stays live and frozen ("leader offline"); members stay connected and are told; the leader returning with its token takes the lead back. The frozen group ends when the recovery window lapses (see 5) or max session time is reached. Grace period, handoff to a vice-leader/longest member and keep-alive stay in item 5.
4. **Memory is a cache, the token is the truth.** A group with no connected participants is dropped from memory; it is recreated from the leader's token exactly as after a restart. Leader-offline, restart and "resume later" are one flow.
5. **Timestamps do the real enforcement.** Two app config values (with env ceilings) are introduced here because token validation needs them: max session time (from group creation; default 3 h, ceiling 8 h, as recorded in #1) and inactivity limit (from the leader's last activity; default 20 min, ceiling 60 min, as recorded in #1). Item 5 reuses the same values for its live timers and keep-alive.
6. **Explicit end and leave.** The leader can end a group and a member can leave it. Both delete the participant's token on the client; members of an ended group are told and their clients delete their tokens. Without this every group would stay resumable until its max session time.
7. **Removing members is item 5; the block list is here.** Item 3 delivers block-list storage on the leader's client, sending it on recreation and on leader return, and server enforcement. The leader action "remove member" (kick plus add to the block list) and the member roster it needs stay in item 5, as decided in #1 Gate 1. (See Q4.)
8. **Join codes are item 4.** The token format and the recreation request reserve room for the group's latest join codes and the code-collision rule, without implementing codes.

## Acceptance criteria

### Secret and configuration
- [ ] AC1. The server reads the token signing secret from an env variable (proposed `TOKEN_SECRET`). In production (`NODE_ENV=production`) the server refuses to start, with a clear `Config error:` message naming the variable but never its value, when the secret is missing, shorter than 32 bytes, or equal to the documented development secret.
- [ ] AC2. An optional previous secret (proposed `TOKEN_SECRET_PREVIOUS`) is accepted for **verification only**. Tokens signed with it are valid; the server never signs with it, and any token it accepts that was signed with the previous secret is replaced by a token signed with the current secret in the same response. The same length and production rules as AC1 apply, and it must differ from the current secret.
- [ ] AC3. Outside production, a missing secret starts the server with a random per-process secret and a `warn` log saying tokens will not survive a restart. `compose.yaml` sets the documented development secret so restart recovery can be tried locally.
- [ ] AC4. Apps config gains `maxSessionMinutes` (default 180) and `inactivityLimitMinutes` (default 20), with env ceilings (defaults 480 and 60). A value above its ceiling is a startup error, consistent with #1 AC5. Token refresh settings (AC12) are server env variables with the defaults in "Defaults".

### Token issue and format
- [ ] AC5. `group.created` and `group.joined` each carry a token for the receiving participant. Its verified claims contain: token format version, the app namespace, the group ID, the group-scoped participant ID, the role (`leader` or `member`), the group creation time, the last-activity time, issued-at, and an expiry exactly 365 days after issued-at.
- [ ] AC6. The participant ID in the token equals the participant ID the server uses for that participant in the group, and it is unchanged after any token rejoin or recreation.
- [ ] AC7. The server accepts only HS256 tokens signed with the current or previous secret. A token with `alg: none`, another algorithm, a bad signature, a missing or wrongly typed claim, an unknown format version, an expired `exp`, a length above the limit (2048 chars) or an audience other than the connection's app namespace is rejected as invalid. Rejections never echo the token or its claims.
- [ ] AC8. A token from app A presented on a connection authenticated as app B is treated as invalid and reveals nothing about app A's group (same response as a garbage token).
- [ ] AC9. A token whose group creation time is older than the app's max session time, or whose last-activity time is older than the app's inactivity limit plus the max refresh interval (AC12), is reported as expired and cannot be used to rejoin or recreate.
- [ ] AC10. Tokens, participant IDs (other than as the existing hashed refs), block-list entries, metadata and positions never appear in server logs or error messages at any level; a log-capture test exercises issue, check, rejoin, recreation, refresh and rejection paths and finds none of them.
- [ ] AC11. The server persists nothing to disk: tokens are not stored server-side, and after a restart the only group state is what clients bring back.

### Last-activity refresh
- [ ] AC12. Leader activity (accepted `position.update`, leader return, recreation) updates the group's last-activity time in memory immediately. The leader receives a refreshed token (`token.refreshed`, new last-activity, issued-at and expiry, same other claims) when either (a) at least N activities happened since the last token and at least the min interval passed, or (b) at least one activity happened since the last token and the max interval passed (timer-driven, not only on the next activity). Tested with an injected clock for: no refresh before min interval even after N activities; refresh after N activities and min interval; refresh at max interval after a single activity; no refresh without activity.
- [ ] AC13. Member tokens are not refreshed (their validity depends on the group being live and on the creation time). (See Q6.)

### Checking stored tokens
- [ ] AC14. A new request (proposed `tokens.check`) accepts up to 20 tokens in one message and answers with one result per token, in the same order, each with a status: `live` (group in memory, participant not blocked), `recoverable` (leader token, group not in memory, within limits), `waiting` (member token, valid, group not in memory), `blocked`, `ended` (group ended in this server's lifetime), `expired` or `invalid`. More than 20 tokens is rejected as invalid input. Results carry no data that wasn't already in the presented token.
- [ ] AC15. There is no way to list groups: the server only reports on groups named by valid tokens the client presents, and no message, error or timing path lets a client learn about a group it holds no valid token for (tested: an invalid token for a live group ID gets `invalid`, identical to a random string).
- [ ] AC16. `tokens.check` is limited to 10 requests per connection per minute (in addition to the existing inbound limiter); excess requests get `RATE_LIMITED` and the connection stays open.

### Token rejoin and leader return (live group)
- [ ] AC17. A new request (proposed `group.resume`) with a valid member token for a live group adds the member with its token's participant ID and returns `group.joined` (metadata and current position, or explicit "no position") plus a fresh token. Group size limits apply (`GROUP_FULL`). A blocked participant ID gets a distinct error (proposed `PARTICIPANT_BLOCKED`).
- [ ] AC18. When the leader's connection closes, the group is not ended. Members receive a `leader.offline` event, position updates stop, members stay in the group, and new members can still join and resume.
- [ ] AC19. `group.resume` with the leader's valid token for that live group makes the new connection the leader; members receive `leader.online`; the leader receives `group.resumed` with the group's current position, metadata and a fresh token, and can broadcast again. The server's live position wins over any position the leader's client sends.
- [ ] AC20. If a token's participant is still attached on another connection (old socket not yet detected dead, or a second tab), the newest `group.resume` wins: the older connection is removed from the group and told so (proposed `group.ended` with reason `replaced`), without ending the group for others.
- [ ] AC21. A frozen group (leader offline) ends with `group.ended` reason `leader_timeout` when the inactivity limit (plus max refresh interval) since the leader's last activity lapses, and with reason `max_session` when max session time since creation is reached, whichever comes first. Members' clients delete their tokens for it.
- [ ] AC22. A group whose last connected participant leaves is dropped from memory without being "ended": its tokens stay `recoverable` / `waiting` until AC9 makes them expired.

### Recovery after restart (recreation)
- [ ] AC23. After a server restart (new process, same secret), `group.resume` with a valid leader token whose group is not in memory recreates the group with the **same group ID**, the token's group creation time, the leader's participant ID, and the metadata, position (optional) and block list the leader's client sends. The leader receives `group.resumed` and a fresh token. Integration test: create, join, update position, restart the server process, leader resumes, member resumes, member receives the leader's position.
- [ ] AC24. The recreation request requires the metadata (opaque, size-limited like `group.create`) and accepts an optional position and a block list of at most 256 participant IDs, each in the participant ID format. The block list has its own size limit and is not counted against the app's max message size (as promised in #1).
- [ ] AC25. A member `group.resume` for a group that is not in memory and whose token is valid gets status `waiting` and the connection is parked for that group (one parked group per connection). When the leader recreates the group, every parked, non-blocked member is added (up to the group size) and receives `group.joined` with the current position and a fresh token, without sending anything else. Parked members over the size limit receive `GROUP_FULL`; blocked ones receive `PARTICIPANT_BLOCKED`.
- [ ] AC26. On recreation and on every leader return, the server refuses every participant ID on the block list: blocked members already attached or parked are removed with `group.ended` reason `removed`, later resumes and joins with those IDs get `PARTICIPANT_BLOCKED`, and `tokens.check` reports `blocked`. The block list is kept only in memory for the group's life and is never logged.
- [ ] AC27. A leader token cannot recreate a group that ended in the current server process (`ended`), and two concurrent resumes with the same leader token produce exactly one group (the second becomes a leader return per AC20). Recreation runs under the existing per-group lock.
- [ ] AC28. "Resume later" uses the same flow: a leader returning after its group was dropped from memory (AC22), within the limits of AC9, recreates it exactly as in AC23.

### Ending and leaving
- [ ] AC29. A leader request (proposed `group.end`) ends the group: members receive `group.ended` reason `ended_by_leader`, the group is removed from memory, and its ID is remembered in memory (no data other than the ID ref and the end time) until its max session deadline so later checks and resumes for it get `ended`. A member sending it gets `NOT_LEADER`.
- [ ] AC30. A member request (proposed `group.leave`) removes the member from the group; the leader is not affected. Leaving does not block the participant.

### Client: token storage
- [ ] AC31. `@sync-system/client` stores each token it receives (create, join, resume, refresh) and replaces the previous token for the same group. It deletes a group's token, block list and saved recovery data when the server reports `ended`, `expired`, `invalid` or `blocked`, on any `group.ended` it receives, and after `endGroup()` / `leaveGroup()` succeed.
- [ ] AC32. Storage is pluggable through a small interface (get, set, remove of string values, sync or async). Default: the browser's `localStorage`, looked up when first needed and never at import time (#3 AC7 SSR import rule still holds); when it is unavailable or throws, an in-memory store is used and a warning is logged by error name only. Options also accept an in-memory store and a custom implementation.
- [ ] AC33. Tokens are stored per server and app under one key (proposed `sync-system:v1:<namespace>@<host[:port]>`), as a versioned JSON document. The server returns its app namespace in `hello.ok` for this. Corrupt, unparsable or wrongly shaped stored data is discarded without throwing. At most 20 tokens are kept per key: expired tokens (by their own claims) are dropped first, then the oldest by last-activity.
- [ ] AC34. For each group where it is leader, the client also stores the block list (at most 256 IDs; adding more is rejected with a typed error) and the latest group metadata and position it sent, so recovery data survives a page reload. The client exposes methods to add to, remove from and read a group's block list; changes while the group is live are sent to the server and enforced per AC26.

### Client: rejoin and recovery
- [ ] AC35. Token rejoin replaces #3's group-ID auto-rejoin (`memberRejoinByGroupId`). After an unexpected drop and reconnect, the client automatically sends `group.resume` with the stored token for its current group, for **both** leader and member; a leader includes its saved metadata, latest position and block list.
- [ ] AC36. The client's group state gains `waiting` (member parked until the leader returns) and the group reports leader offline/online; `indicatorOf` maps them to the PRD's "following / reconnecting / leader offline" values. A leader that resumed is `active` as leader again with the server's position.
- [ ] AC37. A public `checkTokens()` sends all stored tokens for the current server and app (up to 20) and returns, per group, the group ID, role and status from AC14, deleting tokens per AC31. It is never called automatically on the first `connect()`; the app decides what to offer. (See Q9.)
- [ ] AC38. A public `resumeGroup(groupId, options?)` resumes a stored group (for a leader, options may override the saved metadata/position). New public `endGroup()` (leader) and `leaveGroup()` (member) send AC29/AC30 requests.
- [ ] AC39. The client never logs tokens, participant IDs, block lists, metadata or positions, and never puts them in error messages or error details.

### Room for join codes (item 4)
- [ ] AC40. The token format version claim exists, unknown extra claims are ignored on verification, and the architecture documents where item 4 adds the leader's latest join codes (in the leader token or the recreation request) and the rule "if the group code was taken in the meantime, the server issues new codes". No join-code behavior is implemented.

### Docs, quality and compatibility
- [ ] AC41. The server README documents the new env variables and config values with defaults, secret generation (for example `openssl rand -base64 32`) and the rotation procedure (set new secret as current, old as previous, remove previous after the longest token lifetime that matters: max session ceiling). The client README documents storage, `checkTokens`, `resumeGroup`, block list, `endGroup` / `leaveGroup`, and the XSS caveat for tokens in `localStorage`.
- [ ] AC42. #1 and #3 behavior not named here is unchanged; tests that asserted "leader disconnect ends the group" and group-ID auto-rejoin are updated to the new behavior, and all other existing tests pass unchanged.
- [ ] AC43. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm audit --audit-level=high` exit 0 and CI passes. Any new runtime dependency (for example a JWT library) is justified in `architecture.md` and pinned in the lockfile; the client keeps no Node-only runtime dependency (#3 AC1).

## Defaults (proposed)

| Setting | Default | Notes |
| --- | --- | --- |
| Token algorithm | HS256 | Pinned; all others rejected |
| Token expiry (`exp`) | 365 days from issue | Outer safety net only |
| Max token length | 2048 chars | Checked before parsing |
| Secret minimum | 32 bytes | `openssl rand -base64 32` gives 44 chars |
| Refresh after N activities | 10 | Server env |
| Min interval between refreshes | 60 s | Server env |
| Max interval between refreshes | 300 s | Server env; timer-driven |
| Max session time | 180 min (ceiling 480) | App config / env ceiling |
| Inactivity limit (recovery window) | 20 min (ceiling 60) | App config / env ceiling |
| Tokens per `tokens.check` | 20 | Same as client storage cap |
| `tokens.check` rate | 10 per connection per minute | |
| Tokens kept per server+app on the client | 20 | Expired first, then oldest |
| Block list size | 256 participant IDs | Separate limit, not max message size |
| Storage key | `sync-system:v1:<namespace>@<host[:port]>` | One versioned JSON document |
| Ended-group memory | Group ID ref until its max session deadline | In memory only |

Env variable names are illustrative; the architect finalizes them.

## Out of scope

- Join methods A-D, join codes, door codes and their rate limits, QR strings (item 4). Joining by group ID stays the temporary mechanism from #1.
- Vice-leader, the "remove member" action and member roster, lock group, preview mode, grace period before handoff, automatic handoff, keep-alive prompt, live inactivity enforcement while the leader is connected, "you're now leading" moments (item 5). Item 5 will also need a rule for role changes and token re-issue (for example a new leader token after handoff).
- React/Next package (item 6), reading app (items 7-8).
- Redis store, server-side block lists, multi-instance, public docs site, changelog, semver releases (item 9).
- Token revocation lists or any server-side token storage.
- Encrypting token contents (JWE).

## Open questions (each with a proposed default)

- **Q1. Live-group recovery when the leader disconnects.** Default: the group stays live and frozen ("leader offline"), members stay and are notified, the leader returns with its token; the frozen group ends after the inactivity limit (plus max refresh interval) since the leader's last activity, or at max session time (AC18-AC21). Alternative: keep #1's "leader disconnect ends the group" and recover only via recreation, or a fixed short window (for example 30 s) with the rest left to item 5.
- **Q2. Timer ownership.** Default: this issue adds `maxSessionMinutes` and `inactivityLimitMinutes` config and enforces max session time fully (also for live groups with the leader online) and the inactivity limit only while the leader is offline and at token validation. Item 5 adds the grace period, handoff, keep-alive prompt and inactivity enforcement while the leader is online. Alternative: enforce both only at token validation and leave every live timer to item 5.
- **Q3. Explicit `group.end` / `group.leave`.** Default: include them here (AC29-AC30), because token deletion needs a normal end. Alternative: defer to item 5 and rely on max session expiry.
- **Q4. Remove member.** Default: item 5 (as decided in #1 Gate 1), because it needs a member roster with participant IDs that the leader doesn't have yet. Item 3 delivers block-list storage, transport and enforcement, with a client API to manage the list. Alternative: add a minimal roster (`member.joined` / `member.left` to the leader) and `member.remove` here.
- **Q5. Duplicate attachment.** Default: newest `group.resume` wins and the older connection gets `group.ended` reason `replaced` (AC20). Alternative: refuse the newer one while the older is attached (bad for a leader whose dead socket hasn't timed out yet).
- **Q6. Member token refresh.** Default: only leader tokens are refreshed (AC13); member validity comes from group liveness and creation time. Alternative: refresh member tokens on the group's activity schedule.
- **Q7. Members waiting for a leader.** Default: server-side parking (AC25), one parked group per connection, members are added automatically when the leader recreates. Alternative: the client polls `tokens.check` with backoff.
- **Q8. Ended-group memory.** Default: remember ended group IDs (as refs) in memory until their max session deadline, so `tokens.check` can say `ended` and a stale leader token can't recreate an ended group in the same process. After a restart this memory is gone; such a token could recreate the group (accepted risk, since the leader's client deletes its token on end).
- **Q9. Automatic token check on first connect.** Default: no; the app calls `checkTokens()` and decides what to offer. Automatic resume happens only after an unexpected drop in the same session (AC35).
- **Q10. Recovery slack for refresh lag.** Default: tokens are accepted for recovery if last activity is within inactivity limit + max refresh interval (AC9), so a token up to 5 min stale doesn't lose a group that would still be live.
- **Q11. Default client storage.** Default: `localStorage` (survives browser restarts, needed for "resume later"), with the XSS caveat documented. Alternative: `sessionStorage` (per tab, lost on close).
- **Q12. Storage key and namespace in `hello.ok`.** Default: `sync-system:v1:<namespace>@<host[:port]>`, with `hello.ok` returning the app namespace (not secret). Alternative: an app-chosen `storageKey` option.
- **Q13. Protocol version.** Default: keep protocol version 1 although leader-disconnect semantics change, because nothing has been released yet (releases start in item 9). Alternative: bump to 2 and set the minimum to 2.
- **Q14. Position on leader return to a live group.** Default: the server's live position wins (AC19); the leader's client adopts it. Alternative: the leader's client position wins.
- **Q15. Secret outside production.** Default: random per-process secret with a warning when unset, and a documented dev secret in `compose.yaml` (AC3). Alternative: require the secret in every environment.

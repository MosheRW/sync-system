# Spec: #10 Join methods A-D (door code, approval, alphanumeric, QR)

Issue: https://github.com/MosheRW/sync-system/issues/10
Source PRD: `docs/PRD Group Reading Sync.md` ("Joining" in Product 2, "Group IDs and codes" and "Recovery after a restart" in Identity, tokens and recovery, "Client apps" in Multi-app isolation, "Users, settings and scale")
Path: full | Type: feat | PRD item 4 of 9
Numbering: GitHub issue numbers are not PRD item numbers. "item N" means PRD item N of 9. Item 1 = GitHub #1 (server core), item 2 = #3 (core client), item 3 = #5 (tokens and recovery) plus its hardening follow-up #7. All are merged to `main`.
Builds on: `@sync-system/protocol`, `apps/sync-server` and `@sync-system/client` as of `main` after PR #8.

## Problem / motivation

The PRD says anyone can start a reading group "in seconds", and that joining "must work by reading codes aloud and by scanning a QR code". Today the only way into a group is the **temporary join by group ID** from #1 (`group.join` with the 43-character group ID). That is a stopgap:

- Nobody can read a 43-character ID aloud or type it on a phone, so the "under 15 seconds from opening the app to following" goal can't be met.
- The group ID was meant to be "long and unguessable, separate from the join codes. Nobody types it." Right now it is the join credential itself.
- #5's security review recorded an accepted gap: a member the leader blocked can come back by group ID with a new participant ID. Item 4 is where that gap closes.
- The PRD lets each client app choose its join methods from those the server env permits. Earlier specs deferred this here, along with door-code rate limiting (#1 out of scope), and the rule that a recreated group keeps its latest join codes or gets new ones if a code was taken (#5 AC40, architecture section 4.1).

This issue adds the four PRD join methods (A to D), lets each app choose its allowed methods within an env ceiling, rate-limits code guessing, carries join codes through restart recovery, and removes join by group ID.

| Method | PRD definition |
| --- | --- |
| A. Group code + door code | Two 6-digit codes, always displayed, entered in order. The first identifies the group, the second admits. |
| B. Code + approval | One 6-digit code, then the leader approves each joiner. |
| C. Alphanumeric code | One 8-character code of letters and digits. |
| D. QR code | A long connection string with a timeout, for scanning in the same room. |

## UI impact

None in this issue. It delivers protocol messages, server behaviour and the core client API (`@sync-system/client`). Code entry screens, displaying the codes, rendering the QR image, camera scanning and the leader's approval prompt are reading-app UI (items 7 and 8), and React hooks for them are item 6. The designer phase is skipped (Q1.4, accepted at Gate 1).

## User stories

- As a **leader in a classroom**, I want two short numeric codes I can read aloud, so that people in the room can join in seconds without typing an ID.
- As a **leader of a remote group**, I want people who only have a 6-digit code to wait until I approve them, so that a leaked code doesn't let strangers in.
- As a **leader**, I want a single 8-character code that admits on its own, so that I can share one thing in a chat message.
- As a **leader in the same room**, I want to show a QR code that expires on its own, so that people can join by scanning without typing, and an old photo of the screen stops working.
- As a **joiner**, I want clear, distinct errors for a wrong group code, a wrong door code, a denied request and an expired QR code, so that I know what to fix.
- As a **leader**, I want guessing the door code to be impractical (rate limits, rotation, pause), so that only people I gave the codes to can get in.
- As a **leader after a server restart**, I want my group to come back with the same codes when possible, and new ones when not, so that people I already told can still join.
- As a **client app developer**, I want to choose which join methods my app offers, within what the server operator allows, so that the join flow fits my app.
- As a **self-hosting operator**, I want an env variable that limits which join methods any app may use, and a startup error when an app asks for more, consistent with the existing env-ceiling rules.
- As a **leader who blocked someone**, I want them unable to get back in through a group-ID back door, so that removal sticks.
- As a **user who may be a minor**, I want codes, QR strings and display names kept out of server logs, so that nothing personal outlives the session.

## Design decisions (confirmed at Gate 1)

The user accepted every proposed default at Gate 1 (see "Gate 1 decisions" at the end). Each decision also appears there with its question number.

1. **Join by group ID is removed.** `group.join` by group ID goes away from the protocol and the client (`joinGroup(groupId)`). Code joins, QR joins and token resume (#5) are the only ways in. Protocol version stays 1, because nothing has been released yet (same reasoning as #5 Q13). (Q2.1)
2. **Per-app methods within an env ceiling.** A server env variable lists the methods any app may use. Each app's config lists its own allowed methods, which must be a subset. Listing a method the env does not permit is a startup error, never silently dropped, the same as #1 AC5. (Q1.1, Q1.2)
3. **Per-group methods chosen at creation.** The leader's client picks the group's methods at `group.create`, from the app's allowed set. A and B are mutually exclusive within one group, because both use the same 6-digit group code. D can be combined with any of them. (Q1.3)
4. **One code-join request.** The client sends whatever code the user typed. The server tells a 6-digit group code (A or B) from an 8-character code (C) by format. For a method A group, a request without a door code gets `DOOR_CODE_REQUIRED` and doesn't count as a door-code failure. The UI then asks for the door code and sends both. This gives the PRD's "entered in order" flow without a separate lookup message, and lets an app that allows both A and B work without the user knowing which one a group uses. (Q2.2)
5. **Codes are per app and per live group.** Codes resolve only within the connection's app (app isolation, #1 AC18). They are freed when the group ends or leaves memory, and are only ever sent to the leader.
6. **QR tickets are signed and stateless.** A QR join string is a server-signed ticket (app, group, expiry, code generation). It is checked with a key derived from `TOKEN_SECRET` and kept separate from token keys. It works for many joiners until it expires, and stops working when the group's codes rotate. (Q3.x)
7. **Codes survive restarts through the leader's client.** The leader's client stores a server-signed copy of the group's current codes and sends it with `group.resume` when recreating a group, as #5's architecture planned. The server accepts only codes it signed for that group ID. A leader can't pick its own codes. If any code is taken, the server issues a fresh set. (Q4.1)
8. **Security thresholds are fixed constants.** Door-code failure limits, rotation and pause, and the per-connection and per-app join-attempt budgets are fixed server constants. They are not app settings, so an app can't loosen them. This matches #7 D1 and D2. Timers that are product choices (QR expiry, approval timeout) are app settings with env ceilings. (Q5.x)

## Acceptance criteria

### Configuration: join methods per app
- [ ] AC1. A server env variable (proposed `JOIN_METHODS_ALLOWED`, a comma-separated list of `A`, `B`, `C`, `D`, default `A,B,C,D`) sets which methods any app may use. An empty list, an unknown letter or a duplicate is a startup `Config error:` naming the variable.
- [ ] AC2. Each app entry in the apps config accepts `joinMethods`, a non-empty array of distinct method letters. If it's omitted, the default is `["A", "D"]` intersected with `JOIN_METHODS_ALLOWED`, and an empty intersection is a startup error naming the app namespace. A listed method the env does not permit is a startup error naming the app namespace, the field and the method. Values are never clamped or dropped (#1 AC5).
- [ ] AC3. The apps config accepts the new timer settings `qrTicketSeconds` (default 300, minimum 30) and `approvalTimeoutSeconds` (default 120, minimum 15). They're capped by env ceilings (proposed `QR_TICKET_SECONDS_CEILING` default 3600, `APPROVAL_TIMEOUT_SECONDS_CEILING` default 600). A value above its ceiling or below its minimum is a startup error, as in #1 AC5.
- [ ] AC4. `hello.ok` tells the client the app's allowed join methods, `qrTicketSeconds` and `approvalTimeoutSeconds`, next to the existing limits, so the client can reject an unsupported method locally.

### Group creation and codes
- [ ] AC5. `group.create` accepts an optional `joinMethods` array. It must be non-empty, distinct, a subset of the app's allowed methods, and must not contain both `A` and `B`. Otherwise the request is rejected with a distinct error (proposed `JOIN_METHOD_NOT_ALLOWED`) and no group is created. If omitted, the group gets the app's allowed methods, minus `B` when `A` is also allowed.
- [ ] AC6. `group.created` returns to the leader the codes for the group's methods. Method A gets a group code and a door code, B a group code, C an alphanumeric code. For D, the leader requests tickets separately (AC23). It also returns the code generation (a counter that increases on every rotation) and the signed codes blob for recovery (AC32).
- [ ] AC7. Group codes and door codes are exactly 6 decimal digits (`000000` to `999999`, leading zeros allowed), drawn uniformly at random from the CSPRNG. In method A the door code never equals the group code.
- [ ] AC8. Alphanumeric codes are exactly 8 characters drawn uniformly at random from the CSPRNG over a 31-character alphabet with no look-alike characters (proposed `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, which leaves out 0, O, 1, I and L). Input is case-insensitive.
- [ ] AC9. Within one app, no two live groups share a 6-digit group code, and no two share an alphanumeric code. On a collision the server draws again. If it can't find a free code within a bounded number of draws, creation fails with a distinct error (proposed `CODES_EXHAUSTED`) and nothing is registered. The same code value may exist in another app at the same time.
- [ ] AC10. Codes are sent only to the leader's connection: in `group.created`, in `group.resumed` on leader return or recreation, and in code-change events. They never reach members. They never appear in logs, in error messages or in error `details` at any level (log-capture test over create, join, wrong code, rotation, QR and recreation paths).
- [ ] AC11. When a group ends (any reason) or is dropped from memory (#5 AC22), its codes are freed immediately and can resolve to a new group later.

### Joining by code (A, B, C)
- [ ] AC12. A new request (proposed `group.joinByCode`) takes a code string, plus an optional door code and an optional display name (AC20). Before checking format, the server and the client both strip spaces and hyphens and uppercase letters. After that, a code that is neither 6 digits nor 8 characters of the alphabet is rejected with `INVALID_MESSAGE`-class input validation. The client rejects it locally with a typed error and sends nothing.
- [ ] AC13. A code that matches no live group of the connection's app, a code for a group whose methods don't include the code's type, and a code from another app all get the same error (proposed `CODE_NOT_FOUND`), with byte-identical message and details. Tested across two apps.
- [ ] AC14. **Method A:** with the correct group code and correct door code, the joiner is admitted as a member and gets `group.joined` (metadata, current position or explicit "no position", token) exactly as #5 defines it. Group size limits apply (`GROUP_FULL`).
- [ ] AC15. **Method A:** a correct group code without a door code gets `DOOR_CODE_REQUIRED`, which doesn't count as a door-code failure (AC29). A correct group code with a wrong door code gets `DOOR_CODE_WRONG` and counts as one failure for that group. Door codes are compared in constant time.
- [ ] AC16. **Method C:** a correct alphanumeric code admits the joiner directly, as in AC14.
- [ ] AC17. Joining is allowed while the group is frozen (leader offline, #5 AC18) for methods A, C and D. Method B behaves as in AC21.
- [ ] AC18. A connection that is already in a group, or parked for one, gets `ALREADY_IN_GROUP` on any join request, as today.

### Method B: approval
- [ ] AC19. **Method B:** a correct 6-digit code for a B group doesn't admit. The server creates a pending request and sends the leader a join request (proposed `join.requested`) with a request ID and the optional display name. The joiner gets an "awaiting approval" reply (proposed `join.pending`) with the request ID and the approval deadline.
- [ ] AC20. The optional display name is 1 to 32 characters after trimming, with no control characters. Otherwise it is rejected as invalid input. It is relayed only to the current leader in `join.requested`, is not stored after the request settles, and is never logged. Generated names and names for the roster are item 5.
- [ ] AC21. The leader approves or denies by request ID (proposed `join.approve` / `join.deny`). Approve: the joiner gets `group.joined` with a token, or `GROUP_FULL` if the group filled up in the meantime. Deny: the joiner gets `JOIN_DENIED`. If there's no decision within `approvalTimeoutSeconds`, the joiner gets `APPROVAL_TIMEOUT` and the leader gets the request withdrawn (proposed `join.withdrawn`). If the joiner disconnects or cancels (proposed `join.cancel`), the leader gets `join.withdrawn`. If the leader is offline, pending requests wait until their deadline and are re-sent to the leader's connection on leader return. Only the leader can approve or deny. Anyone else gets `NOT_LEADER` with its own action-specific text (#7 AC19 rule).
- [ ] AC22. At most 10 pending requests per group. Beyond that, new requests get a distinct error (proposed `APPROVAL_QUEUE_FULL`). A connection can have at most one pending request. Pending requests are in memory only. When the group ends, every pending joiner gets a distinct, documented reply (the architect picks the code), and nobody is admitted.

### Method D: QR tickets
- [ ] AC23. The leader of a group with method D can request a QR ticket (proposed `qr.issue`). The reply contains an opaque ticket string of at most 256 characters, URL-safe, made only of base64url characters and `.`, and its expiry, which is issue time plus `qrTicketSeconds`. A non-leader, or a group without D, gets a distinct error. `qr.issue` is limited to 6 requests per connection per minute (`RATE_LIMITED` with its own text).
- [ ] AC24. A new request (proposed `group.joinByQr`) with a valid, unexpired ticket for a live group of the connection's app admits the joiner as in AC14. Exception: if the group uses method B, the joiner goes through approval as in AC19 to AC22 (Q3.2). One ticket admits any number of joiners until it expires.
- [ ] AC25. A ticket that is expired, has a bad signature, is malformed, is over the length limit, belongs to another app, belongs to a group no longer in memory, or carries an older code generation than the group's current one is rejected. The rejection doesn't tell these cases apart (proposed `QR_INVALID`, except `QR_EXPIRED` for a well-formed, correctly signed but expired ticket). It never echoes the ticket.
- [ ] AC26. Tickets are signed with a key derived from the token secret with domain separation (a different HKDF `info` than token keys and the codes blob). Tickets signed under `TOKEN_SECRET_PREVIOUS` are accepted until they expire. A ticket can never verify as a participant token, and a token can never verify as a ticket (test).

### Brute-force protection
- [ ] AC27. **Join-attempt budget per connection:** at most 10 join attempts (`group.joinByCode` plus `group.joinByQr`, successful or not, including `DOOR_CODE_REQUIRED`) per connection per minute. Excess attempts get `RATE_LIMITED` with `details.retryAfterMs` and their own text, before any code lookup. The connection stays open.
- [ ] AC28. **Join-attempt budget per app:** at most 600 join attempts per app per minute, shared by all of that app's connections, checked before any code lookup. Other apps aren't affected (integration test with two apps), as in #7 AC4 and AC5.
- [ ] AC29. **Door-code failures per group (method A):** after 5 wrong door codes within 10 minutes for one group, the door code rotates. The leader gets a code-change event (proposed `codes.updated`, reason `door_failures`) with the new door code, a new generation and a new signed blob. The group code stays the same. After 3 such rotations within 30 minutes, door-code joining for that group pauses for 10 minutes. During the pause, every method A attempt for that group gets a distinct error (proposed `JOIN_PAUSED` with `details.retryAfterMs`), without checking the door code, and the leader gets `join.paused` and `join.resumed` events. Tested with an injected clock.
- [ ] AC30. **Leader rotation:** the leader can rotate the group's codes at any time (proposed `codes.rotate`). Every code of the group is replaced (new group code, door code, alphanumeric code as applicable), the generation increases (so older QR tickets stop working), door-failure counters reset, and any pause is lifted. Limited to 6 per group per minute. A non-leader gets `NOT_LEADER` with its own text.
- [ ] AC31. All new counters, pending approvals and pause timers are cleared when their group ends and when the server closes (no timers left: ManualScheduler pending = 0 or equivalent). They hold no codes, display names, IPs or participant IDs in logs.

### Recovery: codes across restarts
- [ ] AC32. With every code set it sends the leader (create, rotation, recreation), the server includes a signed codes blob covering the app, group ID, generation and codes. It uses a third domain-separated key. The leader's client stores the latest blob with its recovery data (#5 AC34) and sends it in `group.resume` when it recreates the group.
- [ ] AC33. On recreation (#5 AC23), the server verifies the blob against the token's app and group ID. If it's valid and every code in it is free in that app, the group gets the same codes and generation. If the blob is missing, invalid, for another group or app, or any of its codes is taken, the server issues a full new set with a higher generation. Either way the leader gets the codes in `group.resumed` with a flag saying whether they changed. The server never accepts codes it didn't sign for that group.
- [ ] AC34. On leader return to a live group (#5 AC19), `group.resumed` carries the group's current codes and blob. Pending approval requests are re-sent to the leader (AC21).
- [ ] AC35. Integration test: create a method A + D group, member joins by code, restart the server process with the same secret, leader resumes. Then: the group has the same group code and door code, a new joiner gets in with them, and the old member resumes with its token. A second test reserves the group code with another group before the leader recreates, and the leader gets new codes.

### Removing join by group ID (closes #5's accepted gap)
- [ ] AC36. The server no longer accepts `group.join` with a group ID. The message type is removed from the protocol schemas, and a client that sends it gets the standard invalid-message handling. No other request takes a raw group ID as an admission credential. `group.resume` still needs a token.
- [ ] AC37. Test: a participant blocked by the leader (#5 block list) can't get back in by any path that presents its old identity. Also, the only way in with a new identity is a current code or ticket (the old group-ID path is gone). README and the #5 security note ("join-by-ID block bypass until item 4") are updated to say what remains: someone who still knows the current codes can join as a new person, and the leader's mitigation is `codes.rotate`. Item 5's remove-member can trigger rotation.

### Client (`@sync-system/client`)
- [ ] AC38. `createGroup(metadata, options?)` accepts `joinMethods` and resolves with the codes, generation and expiry info for the leader. The client checks `joinMethods` against `hello.ok` locally (typed error, nothing sent).
- [ ] AC39. New public calls: `joinByCode(code, { doorCode?, displayName? })`, `joinByQr(ticket)`, `cancelJoin()`. The client normalizes codes as in AC12. `DOOR_CODE_REQUIRED`, `DOOR_CODE_WRONG`, `CODE_NOT_FOUND`, `JOIN_PAUSED`, `JOIN_DENIED`, `APPROVAL_TIMEOUT`, `APPROVAL_QUEUE_FULL`, `QR_INVALID`, `QR_EXPIRED` and `RATE_LIMITED` reject with distinct typed error codes. While awaiting approval, the client's group state is a new `awaiting_approval` state with the deadline, and `indicatorOf` maps it to a documented value.
- [ ] AC40. Leader API: read the current codes, `rotateCodes()`, `issueQrTicket()` (resolves with ticket and expiry), `approveJoin(requestId)`, `denyJoin(requestId)`, and typed events for code changes (with reason), join requests, withdrawn requests, and join paused or resumed. The current codes and blob are part of the leader's stored recovery data and are deleted with it (#5 AC31).
- [ ] AC41. `joinGroup(groupId)` and #3's group-ID paths are removed from the public API and README. Token rejoin (#5 AC35) is unchanged.
- [ ] AC42. The client never logs codes, door codes, QR tickets, the codes blob or display names, and never puts them in error messages or details (recording-logger test across all new flows).

### Docs, quality and compatibility
- [ ] AC43. The server README documents `JOIN_METHODS_ALLOWED`, the app settings `joinMethods`, `qrTicketSeconds` and `approvalTimeoutSeconds` with their ceilings, the fixed brute-force constants, and the brute-force reasoning (door-code guess odds under the limits). `config/apps.example.json` and `config/apps.dev.json` show `joinMethods`. The client README documents every join flow, the leader API, the error codes, and how an app should put a QR ticket in a deep link: in the URL fragment, not the query string, so it stays out of web server logs.
- [ ] AC44. #1, #3, #5 and #7 behaviour not named here is unchanged. Tests that joined by group ID now join through a code or a test helper (the architect decides which), and every other existing test passes unchanged.
- [ ] AC45. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm audit --audit-level=high` exit 0, and CI passes. No new runtime dependency (no QR rendering library in this issue). The client keeps no Node-only runtime dependency (#3 AC1), and the SSR import rule (#3 AC7) still holds.

## Defaults (confirmed at Gate 1)

| Setting | Default | Ceiling / kind | Notes |
| --- | --- | --- | --- |
| Methods any app may use | `A,B,C,D` | Server env `JOIN_METHODS_ALLOWED` | |
| App allowed methods | `["A","D"]` ∩ env | App config `joinMethods` | Codes read aloud plus QR, the PRD's two required settings |
| Group methods if omitted | App methods minus `B` when `A` present | `group.create.joinMethods` | A and B exclusive per group |
| Group code / door code | 6 digits, CSPRNG, uniform | Fixed | 10^6 values each; door != group code |
| Alphanumeric code | 8 chars over 31-char alphabet | Fixed | ~8.5 x 10^11 values; no 0/O/1/I/L |
| QR ticket lifetime | 300 s (min 30 s) | App `qrTicketSeconds`, env ceiling 3600 s | Multi-use until expiry |
| QR ticket length | <= 256 chars | Fixed | Keeps the QR easy to scan on a phone |
| `qr.issue` rate | 6 per connection per minute | Fixed | |
| Approval timeout | 120 s (min 15 s) | App `approvalTimeoutSeconds`, env ceiling 600 s | |
| Pending approvals | 10 per group, 1 per connection | Fixed | |
| Display name in approval requests | 1-32 chars, optional | Fixed | Relayed to leader only, never logged |
| Join attempts per connection | 10 per minute | Fixed | All code and QR joins |
| Join attempts per app | 600 per minute | Fixed | Same size as #7's tokens.check budget |
| Door-code failures before rotation | 5 within 10 min, per group | Fixed | |
| Pause after rotations | 3 rotations within 30 min, then 10 min pause | Fixed | Method A only for that group |
| Leader `codes.rotate` rate | 6 per group per minute | Fixed | Clears counters and pause |
| Code draws before `CODES_EXHAUSTED` | Bounded (architect picks, e.g. 20) | Fixed | |

Under these limits, a guesser who already knows the group code gets about 15 door-code tries per 40 minutes, roughly 540 a day. That is a chance of about 5 x 10^-4 per day of finding the door code. Every rotation is visible to the leader. Env variable and message names are illustrative; the architect finalizes them.

## Out of scope (and where it goes)

- **Item 5 (roles, timers, lifecycle):** lock group (pauses all joining), the "remove member" action and the member roster, automatic code rotation on removal, display names and generated names beyond the optional approval-request name, the vice-leader (and whether it sees codes), grace period and handoff, keep-alive.
- **Item 6 (React/Next package):** hooks and components for join flows, approval prompts and code display.
- **Item 7 and item 8 (reading app):** code entry screens, showing the group code and door code at all times, QR image rendering and camera scanning (and any QR library), deep-link route for QR tickets, the approval UI, and the "joined in under 15 seconds" end-to-end check.
- **Item 9 (Redis, docs, changelog):** codes, counters and pending approvals in Redis, a shared code namespace across several server instances, the public docs site, the changelog and release notes for the removal of join by group ID.
- Per-IP rate limits (see Q5.3).
- Inviting members of a previous group (PRD future work).
- GitHub #9 (client clock-skew hardening) is unrelated and stays separate.

## Gate 1 decisions (all questions closed)

At Gate 1 the user accepted **every** recommended default below exactly as
written: Q1.1-Q1.4, Q2.1-Q2.3, Q3.1-Q3.3, Q4.1-Q4.2, Q5.1-Q5.6 and
Q6.1-Q6.3. The alternatives are kept for the record only; none was chosen.
In short:

- Q1.1 default app methods `["A","D"]` (intersected with the env list); Q1.2 one
  `JOIN_METHODS_ALLOWED` allow-list, startup error when an app asks for more;
  Q1.3 the leader picks the group's methods at creation, A and B exclusive, B
  dropped from the default when A is allowed; Q1.4 designer phase skipped.
- Q2.1 join by group ID removed now, protocol stays version 1; Q2.2 one
  `group.joinByCode` request with `DOOR_CODE_REQUIRED`; Q2.3 codes go to the
  leader only.
- Q3.1 QR ticket lifetime 300 s (ceiling 3600 s), refreshed by the leader's
  client (the architect documents whether the client or the app triggers it);
  Q3.2 a QR joiner in a B group still needs approval; Q3.3 stateless signed
  ticket, carried in a URL fragment, no server URL inside.
- Q4.1 server-signed codes blob from the leader's client, full new set if the
  blob is missing or invalid or any code is taken; Q4.2 no code reservation
  while a group is out of memory.
- Q5.1 door-code rotation after 5 failures in 10 min, then a 10 min method A
  pause after 3 rotations in 30 min; Q5.2 fixed budgets of 10 join attempts per
  connection and 600 per app per minute; Q5.3 no per-IP limits; Q5.4 10 pending
  requests per group, 1 per connection; Q5.5 `codes.rotate` included; Q5.6 the
  ~10^-3 per day method C guess odds are accepted (to be confirmed by the
  security plan review).
- Q6.1 optional display name of 1-32 characters, relayed only to the leader,
  never logged or kept; Q6.2 pending requests wait until their deadline while
  the leader is offline and are re-sent on return; Q6.3 pending requests are
  lost on a server restart and the client does not re-request on its own.

The original questions follow, unchanged apart from a "Decided" line.


### Q1. Configuration and scope
- **Q1.1 Default app methods.** Recommended: `["A","D"]` (intersected with the env list) when an app omits `joinMethods`, matching the PRD's "reading codes aloud and scanning a QR code". Alternative: all env-permitted methods.
  - Decided at Gate 1: the recommended default.
- **Q1.2 Env ceiling form.** Recommended: one allow-list env variable, `JOIN_METHODS_ALLOWED=A,B,C,D`, with a startup error when an app lists more (no clamping). Alternative: one boolean env variable per method.
  - Decided at Gate 1: the recommended default.
- **Q1.3 Per-group choice.** Recommended: the leader's client picks the group's methods at creation, within the app's set. A and B can't be combined in one group. The default drops B when A is allowed. Alternative: every group uses all of the app's methods, and an app can't allow both A and B.
  - Decided at Gate 1: the recommended default.
- **Q1.4 Designer phase.** Recommended: skip it. This issue has no UI, and code display, QR and approval screens belong to items 7 and 8.
  - Decided at Gate 1: the recommended default.

### Q2. Protocol shape
- **Q2.1 Remove join by group ID.** Recommended: remove it from protocol and client now, staying on protocol version 1, since nothing has been released. That closes #5's accepted block-list bypass. Alternative: keep it behind a test-only or dev-only flag, which keeps test churn lower but leaves a back door to guard.
  - Decided at Gate 1: the recommended default.
- **Q2.2 Order of the two A codes.** Recommended: one `group.joinByCode` request. The server answers `DOOR_CODE_REQUIRED` for an A group when the door code is missing, and the UI then asks for it. Distinct errors for a wrong group code and a wrong door code are accepted: the group code is shown openly, and the door code is the secret. Alternative: a separate `code.lookup` step.
  - Decided at Gate 1: the recommended default.
- **Q2.3 Codes only to the leader.** Recommended: yes. Members never receive codes, and item 5 decides whether a vice-leader does.
  - Decided at Gate 1: the recommended default.

### Q3. QR tickets
- **Q3.1 Lifetime and refresh.** Recommended: 300 s default (app setting, ceiling 3600 s). The leader's client requests a fresh ticket before expiry while the app shows it, and the client exposes `issueQrTicket()`. Whether the client refreshes automatically or the app calls it is the architect's choice and must be documented.
  - Decided at Gate 1: the recommended default.
- **Q3.2 QR in a method B group.** Recommended: a QR joiner in a B group still needs approval, so a photo of the screen can't bypass B. Alternative: QR always admits directly ("same room" trust).
  - Decided at Gate 1: the recommended default.
- **Q3.3 Ticket contents.** Recommended: a stateless signed ticket (app, group ID, generation, expiry), opaque to clients, which the app puts in a URL fragment. The server URL is not inside it, because the app already knows its server. Alternative: a self-describing string that includes the server URL, for cross-app scanners.
  - Decided at Gate 1: the recommended default.

### Q4. Recovery
- **Q4.1 Codes on recreation.** Recommended: a server-signed codes blob stored by the leader's client. If any code is taken or the blob is missing or invalid, the server issues a full new set. The server never accepts client-chosen codes. Alternative: replace only the codes that were taken, keeping the rest.
  - Decided at Gate 1: the recommended default.
- **Q4.2 Codes while a group is out of memory.** Recommended: codes are freed when the group is dropped (#5 AC22) and are not reserved while the group is "recoverable". If they get taken, AC33 issues new ones, as the PRD's collision rule expects. Alternative: reserve codes for dropped-but-recoverable groups, which means keeping more memory of groups that have left.
  - Decided at Gate 1: the recommended default.

### Q5. Brute force and abuse (security-sensitive)
- **Q5.1 Door-code failure policy.** Recommended: rotate after 5 failures in 10 minutes, then pause method A for 10 minutes after 3 rotations in 30 minutes. Both are fixed constants. Alternative: pause only (no rotation), or make the thresholds app settings.
  - Decided at Gate 1: the recommended default.
- **Q5.2 Join-attempt budgets.** Recommended: 10 per connection per minute and 600 per app per minute, both fixed constants like #7 D1. Risk: one attacker can use up an app's 600 per minute and slow real joins for that app. Alternative: make the per-app budget an app setting with an env ceiling (for example default 600, ceiling 6000).
  - Decided at Gate 1: the recommended default.
- **Q5.3 Per-IP limits.** Recommended: none. Schools and offices often share one public IP, so a whole class would be throttled. Keeping IPs out of logic also keeps the privacy rule simple. Alternative: an in-memory per-IP budget that is never logged.
  - Decided at Gate 1: the recommended default.
- **Q5.4 Approval spam (method B).** Recommended: 10 pending requests per group, 1 per connection, and the join-attempt budgets above. Alternative: also block a denied connection from asking the same group again for a few minutes.
  - Decided at Gate 1: the recommended default.
- **Q5.5 Leader-initiated rotation.** Recommended: include `codes.rotate` here. It's cheap, it lifts a pause, and it's the leader's tool against leaked codes and removed members. Alternative: defer it to item 5 with "remove member".
  - Decided at Gate 1: the recommended default.
- **Q5.6 Method C guessing odds.** With 1000 live groups in one app and the per-app budget fully used, the chance of guessing some live C code is about 10^-3 per day. Recommended: accept it, and let the security plan review confirm. Alternative: a longer code than the PRD's 8 characters.
  - Decided at Gate 1: the recommended default.

### Q6. Approval details
- **Q6.1 Display name in requests.** Recommended: optional, 1-32 characters, relayed only to the leader, never logged or stored after the request settles. Full display names (generated names, roster) are item 5. Alternative: no name, so the leader sees only "someone wants to join (n pending)".
  - Decided at Gate 1: the recommended default.
- **Q6.2 Leader offline with pending requests.** Recommended: requests wait until their deadline and are re-sent when the leader returns. Alternative: reject them at once with a distinct "leader offline" error.
  - Decided at Gate 1: the recommended default.
- **Q6.3 Pending requests after a server restart.** Recommended: they are lost. The joiner's client surfaces a typed error and doesn't re-request on its own, and the app decides. Alternative: the client re-sends the request on reconnect.
  - Decided at Gate 1: the recommended default.

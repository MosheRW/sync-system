# State: #3 Framework-free core client package
- Path: full
- Phase: architecture
- Branch: feat/3-core-client
- PR: #4
- Plan approved by user: no
- QA loops: 0
- Security-sensitive: yes
- Review rounds: 2 (security plan review: round 1 FAIL, round 2 PASS)
- Last updated by: security

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

## Architecture
- Plan: docs/issues/3/architecture.md, revision 2 (22 planned commits).
- AC10: unknown server message types are ignored (forward compatible); known types failing their schema, binary, non-JSON, too deep or too long frames give INVALID_SERVER_MESSAGE.
- AC24: states idle / connecting / connected / reconnecting (attempt, delayMs, retryAt, attempting) / closed (client | fatal | gave_up).

## Security (plan review, round 1)
- Review: docs/issues/3/security.md. FAIL: 0 critical, 2 high, 5 medium, 8 low.
- H1: backoff counter resets on every hello.ok; a flapping server gets a reconnect storm. Reset only after a stable period (stableAfterMs, 10 s).
- H2: removing listeners from retired ws sockets lets ws emit an unhandled 'error' and crash a Node host. Keep an error listener attached.
- Architect must revise the plan (section 5 of security.md lists the required controls) before Gate 2.
- Revision 2 (architect): all findings folded in. H1, H2 are required; M1-M5 and L1-L8 are listed separately so the user can drop any at Gate 2. Mapping: architecture.md section 11 "Security controls". Next: security plan review round 2.
- New defaults in revision 2: reconnect.stableAfterMs 10 s; position.update ack timeout 2 x requestTimeoutMs (20 s), drop only after 10 s with no inbound frame; busy signals 1001/4003/4008 start at a 2 s cap; hello.ok limit bounds maxMessageBytes <= 1 MiB, maxLeaderUpdatesPerSecond <= 100, maxGroupSize <= 10000; retryAfterMs clamped to [next slot, 10 s]; RATE_LIMITED re-queue at most 3 per position; serverMessage <= 256 chars; schema issues <= 10; details strings <= 64 chars; one group request in flight (REQUEST_IN_PROGRESS); *Ms options in [0, 2^31-1].

## Security (plan review, round 2)
- Revision 2 (7f499d2): PASS. H1, H2, M1-M5 and L1-L8 resolved. 6 new low advisories (R2-L1..L6 in security.md): option minimums (stableAfterMs/initialDelayMs), fatal for out-of-bound hello.ok limits, connect with checked href, clear in-flight flag on every path, deterministic flapping test + runAttempts reset, close()+connect() loop.
- Q-D: agree (required for H1). Q-E: agree, mild preference; keeping 10 s is acceptable.

## Open questions
- Q-A: other handshake rejections (INVALID_MESSAGE, HANDSHAKE_REQUIRED, ALREADY_AUTHENTICATED, bare 4001) are fatal (proposed). Security: agree; pair with M5 (no unthrottled connect() after fatal).
- Q-B: wss:// required for non-loopback hosts, opt-out allowInsecureTransport (proposed). Security: agree strongly; exact URL rules in M2.
- Q-C: a request timeout rejects with REQUEST_TIMEOUT and drops/reconnects the socket (proposed). Security: agree for hello/create/join; for position.update drop only if the server was fully silent (M4). Revision 2 proposes the M4 version.
- Q-D: AC27 "backoff resets after a successful reconnect" is read as "after staying connected for stableAfterMs (10 s)" (H1, required). Confirm.
- Q-E: 30 s backoff cap for APP_CONNECTION_LIMIT (4003) instead of the Q3 10 s (M3, proposed). Confirm or keep 10 s.

## Deviations from plan
- none

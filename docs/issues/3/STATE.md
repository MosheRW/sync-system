# State: #3 Framework-free core client package
- Path: full
- Phase: architecture
- Branch: feat/3-core-client
- PR: #TBD
- Plan approved by user: no
- QA loops: 0
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: architect

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
- Plan: docs/issues/3/architecture.md (17 planned commits).
- AC10: unknown server message types are ignored (forward compatible); known types failing their schema, binary, non-JSON, too deep or too long frames give INVALID_SERVER_MESSAGE.
- AC24: states idle / connecting / connected / reconnecting (attempt, delayMs, retryAt, attempting) / closed (client | fatal | gave_up).

## Open questions
- Q-A: other handshake rejections (INVALID_MESSAGE, HANDSHAKE_REQUIRED, ALREADY_AUTHENTICATED, bare 4001) are fatal (proposed).
- Q-B: wss:// required for non-loopback hosts, opt-out allowInsecureTransport (proposed).
- Q-C: a request timeout rejects with REQUEST_TIMEOUT and drops/reconnects the socket (proposed).

## Deviations from plan
- none

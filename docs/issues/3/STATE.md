# State: #3 Framework-free core client package
- Path: full
- Phase: grooming
- Branch: feat/3-core-client
- PR: none
- Plan approved by user: no
- QA loops: 0
- Last updated by: pm

## Notes
- PRD item 2 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1 (merged in PR #2).

## Open questions
- Q1. Group membership on reconnect before tokens (proposed: member auto-rejoins last group ID; leader's group has ended, reported as group ended).
- Q2. Client coalesces over-rate leader updates with a trailing send; no opt-out option (proposed).
- Q3. Reconnect defaults: 500 ms initial, 10 s max, x2 full jitter, unlimited attempts while open, 10 s request timeout (proposed).
- Q4. APP_CONNECTION_LIMIT 4003 / HTTP 503 on upgrade are retryable, not fatal (proposed).
- Q5. Client supports exactly protocol 1 as its version and minimum server version (proposed).
- Q6. Group calls before connected / while reconnecting fail fast with NOT_CONNECTED, no queue (proposed).
- Q7. Node-only tests in this issue; real-browser tests with the reading app (proposed).

## Deviations from plan
- none

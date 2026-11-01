# State: #5 Participant tokens, token rejoin and restart recovery
- Path: full
- Phase: architecture
- Branch: feat/5-tokens-recovery
- PR: #6 (draft)
- Plan approved by user: no
- Security-sensitive: yes
- QA loops: 0
- Review rounds: 0
- Last updated by: architect

## Notes
- PRD item 3 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1 (server core, merged in PR #2) and #3 (core client, merged in PR #4).
- Spec: docs/issues/5/spec.md (43 acceptance criteria).
- Designer skipped (no UI impact; client API and protocol only).
- Plan: docs/issues/5/architecture.md (25 planned commits, no new dependencies, in-house HS256 with per-app HKDF keys).

## Gate 1 decisions (user approved the spec and accepted every proposed default as written)
- Q1: leader disconnect freezes the group (leader.offline to members) until the leader resumes with its token; a frozen group ends after inactivity limit + max refresh interval since the leader's last activity, or at max session time (replaces #1 AC17).
- Q2: max session time enforced fully here; inactivity limit only while the leader is offline and at token check; item 5 owns the rest. App settings maxSessionMinutes (180, ceiling 480), inactivityLimitMinutes (20, ceiling 60).
- Q3: add group.end (leader) and group.leave (member).
- Q4: member removal stays in item 5; this issue delivers block list storage, sending, server enforcement and a client API to manage it.
- Q5: same token on two connections: newest resume wins, the older is told it was replaced.
- Q6: only leader tokens are refreshed.
- Q7: members waiting for an absent leader are held (parked) by the server and auto-added on recreation.
- Q8: ended group IDs remembered in memory until the max session deadline; lost on restart = accepted risk.
- Q9: no automatic token check on first connect; the app calls checkTokens(); auto-resume only after an unexpected drop.
- Q10: recovery allowed if last activity is within inactivity limit + max refresh interval.
- Q11: localStorage default (XSS risk documented), pluggable store.
- Q12: storage key `sync-system:v1:<namespace>@<host[:port]>`; hello.ok returns namespace.
- Q13: stay on protocol version 1.
- Q14: on leader return to a live group, the server's position wins.
- Q15: outside production with no secret: random per-process secret + warning; compose sets a documented dev secret; production requires TOKEN_SECRET.
- Defaults: HS256, 365 d expiry, token <= 2048 chars, secret >= 32 bytes, TOKEN_SECRET + optional TOKEN_SECRET_PREVIOUS (verify only); refresh after 10 activities, min 60 s, max 300 s; <= 20 tokens per check, <= 10 checks per connection per minute; client stores <= 20 tokens and <= 256 block-list IDs per server+app.

## Open questions (Gate 2, see architecture.md section 12)
- Q-A: missing/dev secret allowed only for NODE_ENV development|test (fail closed like #1 S4); short secret an error everywhere.
- Q-B: AC9's last-activity check applies to leader tokens only; member tokens checked by creation time and group liveness; parked members released after inactivity + slack.
- Q-C: client keeps its token on group.ended reason `replaced`.
- Q-D: leader group.leave rejected with LEADER_CANNOT_LEAVE.
- Q-E: indicatorOf maps an ended group to `none`.

## Deviations from plan
- none

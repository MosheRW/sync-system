# State: #5 Participant tokens, token rejoin and restart recovery
- Path: full
- Phase: validation
- Branch: feat/5-tokens-recovery
- PR: #6 (ready for review)
- Plan approved by user: yes
- Security-sensitive: yes
- QA loops: 0
- Review rounds: 1 (security plan review round 1: PASS; code review round 1: QA PASS)
- QA verdict: PASS (round 1, head abe874e)
- Last updated by: engineer

## Notes
- PRD item 3 of 9. "item N" in spec.md means PRD item N, not GitHub issue N.
- Builds on #1 (server core, merged in PR #2) and #3 (core client, merged in PR #4).
- Spec: docs/issues/5/spec.md (43 acceptance criteria).
- Designer skipped (no UI impact; client API and protocol only).
- Plan: docs/issues/5/architecture.md (25 planned commits, no new dependencies, in-house HS256 with per-app HKDF keys).
- Implementation: all 25 planned commits pushed, plus one follow-up test commit (see Deviations). Checks at the last commit: `pnpm lint`, `pnpm typecheck`, `pnpm test` (protocol 42, server 574, client 441), `pnpm build` and `pnpm audit --audit-level=high` all exit 0 (audit reports 2 moderate advisories, below the gate). Lockfile and package.json files unchanged: no new dependencies.

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

## Gate 2 decisions (user approved the plan)
- Q-A: a missing or dev TOKEN_SECRET is allowed only when NODE_ENV is exactly `development` or `test` (random per-process secret + warning when missing; compose sets the documented dev secret); otherwise a startup error. A set secret under 32 bytes is an error everywhere.
- Q-B: the last-activity check applies to leader tokens only; members are checked by creation time and group liveness; parked members are released after inactivity limit + refresh slack.
- Q-C: on group.ended with reason `replaced` the client keeps its token (exception to AC31).
- Q-D: leader group.leave -> new error LEADER_CANNOT_LEAVE.
- Q-E: indicatorOf maps an ended group to `none`.
- Security findings M1-M6 and L1-L8 approved as additions and implemented per security.md (controls R1-R14).

## Security controls mapping (security.md R1-R14)
- R1 (L1, L3): fixed header byte-equal, length cap and charset before decoding, canonical 43-char signature compared with timingSafeEqual on ASCII text, parse only after verify, claims rebuilt from the 9 known fields (zod strip). `apps/sync-server/src/tokens/jwt.ts`, `token-service.ts`, `packages/protocol/src/tokens.ts`. Commits 1079acb, 09c7cac.
- R2 (M2): `exp - iat === TTL`, no `iat`/`gct`/`lat` beyond 5 min skew, `lat <= iat*1000 + 1000`, `lat >= gct`. `token-service.ts`. Commit 09c7cac.
- R3 (M2): `realScheduler` re-arms beyond the setTimeout maximum; max-session and frozen-end callbacks re-check deadlines under the lock. `time/scheduler.ts`, `group-service.ts`. Commits defae4c, 122c3ed.
- R4 (M1, M3): Q-A rule; >= 32 bytes and >= 16 distinct bytes everywhere; docs example values refused; dev secret only in development/test; no trim (leading/trailing whitespace is an error); previous != current; `warn token_secret_previous_set`; values never logged. `config/token-secret.ts`, `main.ts`. Commit ee1859d.
- R5 (L2): HKDF-SHA256 with constant salt and `info = 'sync-system/token/v1:' + namespace`. `tokens/token-keys.ts`. Commit 09c7cac.
- R6 (M4): replacement clears the old session's membership synchronously; every group action authorizes by notifier ownership. Commits 1522af9, a665ee5, db40078.
- R7: drop and end clear group timers, refresher state and the rate limiter; parking entries are unparked on disconnect and drained on recreation; `server.close()` cancels every timer (tested with ManualScheduler pending = 0). Commits 2408bd2, d723c72, 5e0bee4, 6b39939.
- R8 (M5): ParkingLot keyed by group and participant ID, newest wins with `replaced`; member resume replaces an attached owner; `addParticipant` idempotent per ID (documented in the GroupStore contract). Commits a665ee5, 5e0bee4.
- R9 (L5): an omitted blockList on a live leader return keeps the server's list; client rejoin reads the block list from storage. Commits db40078, 464381a.
- R10: tokens.check limited per connection (10/min) before any verification; no store access for invalid tokens; re-sign only for usable previous-secret tokens. Commit a8110e0.
- R11 (L4, L7): logs hold no tokens, raw or hashed group-scoped pids, block-list entries, metadata or positions (log refs are of the connection ID); ended refs are 32-hex sha256; eviction warning with a count at most once a minute; redaction paths extended. Commits d723c72, 02d85fb.
- R12 (M6, L8): `hello.ok.limits.maxSessionMinutes`; client prunes by `gct + maxSession` on load and write; `forgetGroup` / `forgetAllGroups`; stored document over 256 KB ignored, at most 20 entries parsed. Commits 7185bf8, d37051d, e81c553.
- R13 (L6): `replaced` is final (no auto-resume, reason surfaced); tokens never in snapshots, events, errors or logs (tested). Commits 464381a, e81c553, 2720a7c.
- R14: README: routine vs compromise rotation, secret generation, shared-device and CSP guidance, XSS caveat, join-by-ID block bypass until item 4, frame memory sizing. Commit 5d203e2.

## QA round 1 (PASS)
- Checks: lint, typecheck, test (protocol 42, server 574, client 441), build, audit (exit 0, 2 moderate) and CI all pass. No lockfile or dependency change.
- Acceptance criteria: 43/43 met; evidence in the QA review comment on PR #6.
- Deviations judged acceptable (see review). Non-blocking advisories: A1 fixed error texts for RATE_LIMITED ("Too many position updates") and NOT_LEADER ("...update the position") are now misleading for tokens.check, group.end and blocklist.set; A2 commit 445aab3 alone is not lint-clean (fixed by 75b63c2); A3 no committed test for a member resume into a frozen group (verified manually).

## Open questions
- none

## Deviations from plan
- Leader disconnect now freezes instead of ending (AC42): updated #1 tests in `lifecycle.int`, `robustness.int`, `isolation.int`, `privacy.int` (log events `group_frozen`/`group_dropped` replace `group_ended` there) and #3 tests in `client.rejoin` (rewritten), `client.reconnect`, `client.close`, `client.groups`, `state`, `integration/groups.int`, `integration/reconnect.int`. `malformed-frames.int` uses `transportMaxPayload()` for the new frame limit; `client.inbound` uses a 50 000-char frame for the larger inbound guard; three client tests used `leader.offline` as an "unknown type" example and now use `roster.updated`.
- Extra commit 75b63c2 (`test(server): drop a needless assertion in the restart test`): commit 445aab3 was pushed with one lint error; fixed in a follow-up instead of amending a pushed commit.
- Extra test files: `max-session.int.test.ts`, `notifier.test.ts` (server); helpers `test/helpers/tokens.ts` (client).
- `checkServerUrl` is unchanged; a separate `serverHost(href)` in `url-policy.ts` gives the storage host.
- `forgetGroup(groupId, namespace?)` / `forgetAllGroups(namespace?)` take an optional namespace: storage keys need the namespace, which is only known after a `hello.ok`. Without either they reject with `NOT_CONNECTED`.
- `endGroup()` ends the local group with reason `ended_by_leader` (the server's reason); `leaveGroup()` with `left`.
- The `rejoined` event now carries `ResumedGroup` (was `JoinedGroup`); `ConnectedInfo` and the `connected` state gain `namespace`.
- `RATE_LIMITED` for tokens.check keeps the fixed #1 text ("Too many position updates"); clients branch on the code and `details.retryAfterMs`.
- Parked members admitted at recreation get `rejoined` with `recreated: true`.
- Fix round (Copilot review, after QA and security round 1 PASS). All 3 comments verified as real defects, each fixed with a regression test:
  - 3425fca `fix(server)`: `MAX_BUFFERED_BYTES` must also be >= `TOKENS_CHECK_MAX_FRAME_BYTES` (45056, a tokens.result with 20 re-signed tokens). `MAX_MESSAGE_SIZE_CEILING=1024` with `MAX_BUFFERED_BYTES=4096` now fails at startup. The env test fixture moved from 32768 to 49152; README row updated.
  - 5d998a9 `fix(client)`: a client-side `REQUEST_TIMEOUT` on the automatic group.resume is classified `lost`, not `failed`; the socket is dropped right after (timeoutKind `drop`), so the group stays `rejoining` and the next reconnect resumes again.
  - 8bbac72 `fix(client)`: `TokenStore` marks groups whose write failed as dirty; until a write succeeds, their in-memory entry (or removal) wins over storage reads, while other groups still merge in from storage.
  - Checks after the fixes: `pnpm lint`, `pnpm typecheck`, `pnpm test` (protocol 42, server 575, client 445), `pnpm build` all exit 0.

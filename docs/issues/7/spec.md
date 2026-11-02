# Spec: #7 Harden token recovery (follow-up to #5)

Issue: https://github.com/MosheRW/sync-system/issues/7

Follow-up to #5 (PRD item 3, "tokens and recovery"), merged in PR #6 (merge commit a9cfa02). This issue tracks the non-blocking QA advisories and low security findings from the PR #6 reviews (QA rounds 1-2, security rounds 1-2) and `docs/issues/5/STATE.md`.

Path: fast | Type: fix | Security-sensitive: yes
Numbering: GitHub issue numbers are not PRD item numbers. "#5" is GitHub issue 5, which is PRD item 3. Finding IDs L1-L5 (security) and A1-A4 (QA) refer to the PR #6 review comments.

## Problem

PR #6 passed review with some low-severity hardening gaps left open:

- **L1** `createSyncServer` silently uses a random token secret when `tokenSecrets` is omitted. Any future entry point would skip the Q-A secret rule.
- **L2** the `tokens.check` rate limit is per connection only, so many sockets on one app multiply the HMAC budget.
- **L3** there is no per-connection cap on queued inbound bytes, only the 32-message cap. The worst case grew with the larger frames from #5.
- **L4** with the default options (`requestTimeoutMs == stableAfterMs == 10 s`), a `group.resume` that times out counts as a stable connection. A server that accepts `hello` but never answers `group.resume` makes the client reconnect forever, about every 10 s. The client never reaches `maxAttempts` / `closed(gave_up)`.
- **L5** after a failed `localStorage` write in tab A, tab A's next successful write can bring back a token that another tab forgot or replaced with a newer one. Also, a failed delete in `forgetAllGroups` only marks the groups held in memory.
- **A1** the fixed error texts are misleading. `RATE_LIMITED` ("Too many position updates") is also sent for `tokens.check`, and `NOT_LEADER` ("Only the leader can update the position") is also sent for `group.end` and `blocklist.set`.
- **A3** no committed test covers a member resuming into a frozen group while the leader is offline.
- **A4** #5 made startup reject `MAX_BUFFERED_BYTES` below 45056, which earlier versions accepted. There is no upgrade note for this.

## Acceptance criteria

### L1: token secrets are required (server)
- [ ] AC1: `tokenSecrets` is a required field of the `createSyncServer` options type. Omitting it is a TypeScript compile error.
- [ ] AC2: when called at runtime without `tokenSecrets` (for example from untyped JS), `createSyncServer` throws a clear configuration error and does not start. It never falls back to a random secret.
- [ ] AC3: the random per-process secret for tests lives in the test helper (`test/helpers/test-server.ts` or equivalent), not in `server.ts`. `main.ts` behaviour and the Q-A rule are unchanged, and the existing token-secret config tests still pass.

### L2: shared tokens.check budget (server)
- [ ] AC4: on top of the existing per-connection limit (10 checks per minute), `tokens.check` has a per-app budget of 600 checks per minute, shared by all connections of that app. The budget is a fixed constant (not an env var or app setting). There is no global (all-apps) budget (user decision D1).
- [ ] AC5: a check over the per-app budget gets `RATE_LIMITED` with `details.retryAfterMs`, before any token verification or HMAC work. Other apps' budgets are not affected (integration test with two apps).
- [ ] AC6: the per-app budget state is cleared when the server closes (no timers left: ManualScheduler pending = 0 or equivalent). It is never logged with tokens or participant IDs.

### L3: cap on queued inbound bytes per connection (server)
- [ ] AC7: each connection has a cap on the total bytes of inbound messages that are queued but not yet handled, next to the existing `MAX_QUEUED_MESSAGES` (32) cap. The cap is a fixed constant equal to 4 x the transport `maxPayload`, and it is not configurable (user decision D2).
- [ ] AC8: a message that would push the queue over the byte cap is handled the same way as a message-count overflow today (same error/close behaviour), covered by a test.
- [ ] AC9: the outbound side is unchanged: no new env var, and `MAX_BUFFERED_BYTES` keeps its default and its validation. `MAX_BUFFERED_BYTES` must still be >= `TOKENS_CHECK_MAX_FRAME_BYTES` (45056) and >= 4 x the message ceiling, and a normal `tokens.result` with 20 re-signed tokens still goes through with the new cap in place (test).

### L4: resume timeouts can't loop forever (client)
- [ ] AC10: a connection that ends because the automatic `group.resume` timed out on the client (`REQUEST_TIMEOUT`, `source === 'client'`) does not count as a stable connection. It does not reset the failure streak or the attempt count, whatever `stableAfterMs` is. This is the only L4 change: no separate give-up-after-N-resume-timeouts rule, and no new `stableAfterMs > requestTimeoutMs` option validation (user decision D3).
- [ ] AC11: with default options, against a server that answers `hello` but never answers `group.resume`, the client reaches `closed` with reason `gave_up` after `maxAttempts` attempts (test with a blackhole/fake server and fake timers).
- [ ] AC12: in that case the stored token is kept (not deleted), so a later `checkTokens()` or reconnect can still use it.
- [ ] AC13: a resume that succeeds, or a connection that stays up for `stableAfterMs` after a successful resume, still resets the attempt count as it does today. The existing reconnect tests pass.

### L5: cross-tab safety of the token store (client)
- [ ] AC14: when the store merges a group marked dirty (after a failed write), storage wins if the group's stored entry changed since the failed write, meaning it was removed or it now holds a token with a higher `iat`. Tested with two `TokenStore` instances sharing one fake storage.
- [ ] AC15: a token that tab B removed with `forgetGroup` or `forgetAllGroups` is not written back by tab A's next successful write after a failed write in tab A (test).
- [ ] AC16: tab A's older dirty copy does not replace a newer token (higher `iat`) that tab B stored for the same group (test).
- [ ] AC17: if the delete in `forgetAllGroups` fails, a later successful write does not bring back groups that were in storage but not loaded in memory (test).
- [ ] AC18: `packages/client/README.md` says to call `forgetAllGroups` (log out / shared device) with the app's other tabs closed, and explains the remaining cross-tab limits.

### A1: per-action error texts (server)
User decision D4: no generic texts. Each action that can return `RATE_LIMITED` or `NOT_LEADER` gets its own fixed message that names the action. Today these are (from `group-service.ts`):

| Code | Action (client message) | Required message names | Example text |
|------|-------------------------|------------------------|--------------|
| `RATE_LIMITED` | position update (`update`) | position updates | "Too many position updates" (unchanged) |
| `RATE_LIMITED` | `tokens.check` (per-connection limit and the new per-app budget from AC4) | token checks | "Too many token checks" |
| `NOT_LEADER` | position update (`update`) | updating the position | "Only the leader can update the position" (unchanged) |
| `NOT_LEADER` | `group.end` (including a parked session) | ending the group | "Only the leader can end the group" |
| `NOT_LEADER` | `blocklist.set` (including a parked session) | setting the block list | "Only the leader can set the block list" |

- [ ] AC19: each row above returns its own message text, and each text names its action (exact wording is the plan's choice; the examples are fine). No two rows with the same code share a text. The error codes, `details` (for example `retryAfterMs`) and `reqId` handling are unchanged.
- [ ] AC20: texts stay fixed per action: they never include received values (group IDs, tokens, participant IDs), so the AC18 rule from #1 still holds.
- [ ] AC21: a test per row asserts the code and the exact message for that action. Tests and docs that asserted the old shared texts are updated. Any other server path that starts returning `RATE_LIMITED` or `NOT_LEADER` in this issue also gets its own action-specific text. No other error text changes.

### A3: frozen-group member resume test (server)
- [ ] AC22: `apps/sync-server/test/frozen.int.test.ts` has a committed test in which a member resumes with its token into a frozen group while the leader is offline. The member keeps the same participant ID and sees the same position.
- [ ] AC23: in the same test, when the leader resumes, the server's position wins (Q14), members get `leader.online`, and the member receives the leader's position updates again.

### A4: upgrade note (docs)
- [ ] AC24: the root `README.md` has an upgrade note. It says that since #5 the server refuses to start with `MAX_BUFFERED_BYTES` below 45056 (earlier versions accepted values like 32768), and explains how to fix the config.

### General
- [ ] AC25: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm audit --audit-level=high` all exit 0. No new dependencies and no protocol version change.

## Out of scope
- **A2** (commit 445aab3 is not lint-clean on its own): this is history only and was already fixed by 75b63c2. Nothing to change.
- **A5** (dirty-group tracking compares entries by identity, so it may keep more than needed): safe as is, so no fix is needed. AC14 may change this code anyway.
- The full changelog (PRD item 9). A README note is enough here.
- Listening to the browser `storage` event for live cross-tab sync, unless the plan finds it is the simplest way to meet AC14-AC17.
- Any change to the token format, secret rules, expiry or the protocol.

- A global (all-apps) `tokens.check` budget (D1), a configurable inbound byte cap (D2), and a give-up-after-N-resume-timeouts rule or `stableAfterMs > requestTimeoutMs` validation (D3).

## User decisions (Gate 1)
- **D1 (L2):** per-app `tokens.check` budget of 600 checks per minute, as a fixed constant, on top of the per-connection limit. No global budget.
- **D2 (L3):** a cap on queued **inbound** bytes, a fixed constant of 4 x transport `maxPayload`, next to the 32-message cap. Not configurable. `MAX_BUFFERED_BYTES` stays unchanged.
- **D3 (L4):** the only change is that a resume timeout does not count as a stable connection. No extra give-up-after-N rule and no `stableAfterMs > requestTimeoutMs` validation.
- **D4 (A1):** per-action error texts, not generic ones. Each action that can return `RATE_LIMITED` or `NOT_LEADER` gets its own message naming the action. Codes unchanged.

## Open questions
- none

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
- [ ] AC4: on top of the existing per-connection limit (10 checks per minute), `tokens.check` has a per-app budget shared by all connections of that app. The plan sets the default value (see Open questions).
- [ ] AC5: a check over the per-app budget gets `RATE_LIMITED` with `details.retryAfterMs`, before any token verification or HMAC work. Other apps' budgets are not affected (integration test with two apps).
- [ ] AC6: the per-app budget state is cleared when the server closes (no timers left: ManualScheduler pending = 0 or equivalent). It is never logged with tokens or participant IDs.

### L3: cap on queued inbound bytes per connection (server)
- [ ] AC7: each connection has a cap on the total bytes of inbound messages that are queued but not yet handled, next to the existing `MAX_QUEUED_MESSAGES` cap. The default is about 4 x the transport `maxPayload`.
- [ ] AC8: a message that would push the queue over the byte cap is handled the same way as a message-count overflow today (same error/close behaviour), covered by a test.
- [ ] AC9: the outbound rule is unchanged. `MAX_BUFFERED_BYTES` must still be >= `TOKENS_CHECK_MAX_FRAME_BYTES` (45056) and >= 4 x the message ceiling, and a normal `tokens.result` with 20 re-signed tokens still goes through with the new cap in place (test).

### L4: resume timeouts can't loop forever (client)
- [ ] AC10: a connection that ends because the automatic `group.resume` timed out on the client (`REQUEST_TIMEOUT`, `source === 'client'`) does not count as a stable connection. It does not reset the failure streak or the attempt count, whatever `stableAfterMs` is.
- [ ] AC11: with default options, against a server that answers `hello` but never answers `group.resume`, the client reaches `closed` with reason `gave_up` after `maxAttempts` attempts (test with a blackhole/fake server and fake timers).
- [ ] AC12: in that case the stored token is kept (not deleted), so a later `checkTokens()` or reconnect can still use it.
- [ ] AC13: a resume that succeeds, or a connection that stays up for `stableAfterMs` after a successful resume, still resets the attempt count as it does today. The existing reconnect tests pass.

### L5: cross-tab safety of the token store (client)
- [ ] AC14: when the store merges a group marked dirty (after a failed write), storage wins if the group's stored entry changed since the failed write, meaning it was removed or it now holds a token with a higher `iat`. Tested with two `TokenStore` instances sharing one fake storage.
- [ ] AC15: a token that tab B removed with `forgetGroup` or `forgetAllGroups` is not written back by tab A's next successful write after a failed write in tab A (test).
- [ ] AC16: tab A's older dirty copy does not replace a newer token (higher `iat`) that tab B stored for the same group (test).
- [ ] AC17: if the delete in `forgetAllGroups` fails, a later successful write does not bring back groups that were in storage but not loaded in memory (test).
- [ ] AC18: `packages/client/README.md` says to call `forgetAllGroups` (log out / shared device) with the app's other tabs closed, and explains the remaining cross-tab limits.

### A1: generic error texts (server)
- [ ] AC19: the fixed text for `RATE_LIMITED` is generic (for example "Too many requests"), and so is the text for `NOT_LEADER` (for example "Only the leader can do this"). Codes and `details` stay the same, and texts still never include received values.
- [ ] AC20: tests and docs that assert the old texts are updated. No other error text changes.

### A3: frozen-group member resume test (server)
- [ ] AC21: `apps/sync-server/test/frozen.int.test.ts` has a committed test in which a member resumes with its token into a frozen group while the leader is offline. The member keeps the same participant ID and sees the same position.
- [ ] AC22: in the same test, when the leader resumes, the server's position wins (Q14), members get `leader.online`, and the member receives the leader's position updates again.

### A4: upgrade note (docs)
- [ ] AC23: the root `README.md` has an upgrade note. It says that since #5 the server refuses to start with `MAX_BUFFERED_BYTES` below 45056 (earlier versions accepted values like 32768), and explains how to fix the config.

### General
- [ ] AC24: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm audit --audit-level=high` all exit 0. No new dependencies and no protocol version change.

## Out of scope
- **A2** (commit 445aab3 is not lint-clean on its own): this is history only and was already fixed by 75b63c2. Nothing to change.
- **A5** (dirty-group tracking compares entries by identity, so it may keep more than needed): safe as is, so no fix is needed. AC14 may change this code anyway.
- The full changelog (PRD item 9). A README note is enough here.
- Listening to the browser `storage` event for live cross-tab sync, unless the plan finds it is the simplest way to meet AC14-AC17.
- Any change to the token format, secret rules, expiry or the protocol.

## Open questions
1. L2: what should the default per-app `tokens.check` budget be? Proposed: 600 checks per minute per app, as a constant (not an env var or app setting). Should there also be a global budget across all apps?
2. L3: the security finding (inbound queue, "next to the 32-message cap") and the hand-off note (outbound buffer, `MAX_BUFFERED_BYTES`) describe this differently. This spec treats L3 as a cap on queued **inbound** bytes and leaves the outbound `MAX_BUFFERED_BYTES` rule as it is. Is that right? Should the cap be a fixed constant (proposed: 4 x transport `maxPayload`) or configurable?
3. L4: of the three fix options, this spec picks "a resume timeout does not count as stable" (AC10). Should the client also give up after N consecutive resume timeouts (for example 3), before reaching `maxAttempts`? Or should option validation also require `stableAfterMs > requestTimeoutMs`?
4. A1: are the proposed texts ("Too many requests", "Only the leader can do this") acceptable?

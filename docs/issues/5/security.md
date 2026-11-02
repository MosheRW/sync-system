# Security review (plan): #5 Participant tokens, token rejoin and restart recovery

Issue: https://github.com/MosheRW/sync-system/issues/5 | PR: #6 (draft)
Reviewed: [`architecture.md`](./architecture.md) (head `c361099`) against
[`spec.md`](./spec.md), the Gate 1 decisions Q1-Q15 in [`STATE.md`](./STATE.md),
and the earlier hardening in [`../1/security.md`](../1/security.md) (server) and
[`../3/security.md`](../3/security.md) (client). I also read the current code the
plan touches (`connection.ts`, `in-memory-group-store.ts`, `group-service.ts`,
`dev-key.ts`, `logger.ts`, `limits/constants.ts`).
Reviewer: security | Mode: plan | Round: 1 | Result: **PASS** (0 critical,
0 high, 6 medium, 8 low)

The plan is strong. The design choices that matter most are already right:

- **Fixed header, byte-equal** before any HMAC. This removes the whole
  `alg: none` / RS-HS confusion / `kid` / `jku` / `crit` class by construction.
- **Constant-time compare** of 32 raw signature bytes with `timingSafeEqual`, and
  **parse only after verify**. The length cap and charset check come before
  decoding.
- **Per-app HKDF keys.** A token from app A fails the *signature* on app B, so
  cross-app tokens take the same path as garbage (AC8, AC15). `aud` is still
  checked as a second line.
- **No store access for unverified tokens**, one `TOKEN_INVALID` / `invalid`
  answer for every verification failure, and no listing.
- **`createdAt` comes from the signed `gct` on recreation**, so a group can't
  outlive its max session by being recreated again and again.
- The **leader's slot is reserved** while it is offline, and a leader token whose
  `pid` isn't the record's `leaderId` is invalid.
- **Fail-closed secret rule (Q-A)**, the same as #1 S4. No new dependencies.
- Everything is bounded by existing caps: records are at most `MAX_CONNECTIONS`,
  and so are timers and parked sessions. The ended-groups cap is 100k.
- Raw IDs, tokens and block lists are not logged. Ended-group refs are hashed,
  and nothing is written to disk.

No finding blocks. The medium findings are defence-in-depth gaps and
correctness-of-authorization edge cases. Each one is a small change inside a
planned commit. I recommend folding them in before implementation (section 5).

## 1. Assets and trust boundaries

| Asset | Why it matters |
| --- | --- |
| `TOKEN_SECRET` (and `TOKEN_SECRET_PREVIOUS`) | Anyone who has it can forge leader and member tokens for every app on the server (all per-app keys derive from it). |
| Leader token | A bearer credential for leadership. It lets the holder take the lead (newest wins), end the group, set the block list, and recreate the group after a drop or restart. Refreshed tokens let the holder keep it alive. |
| Member token | A bearer credential for one member identity (`pid`) for up to max session (8 h ceiling). Read access to positions, plus liveness via `tokens.check`. Roughly equal to the group ID in #1, which is also inside the token. |
| Block list | The leader's moderation decision. It is only as strong as the identities it binds (see section 2 on join by ID). |
| Leader recovery data (metadata, position) | What a group, possibly of minors, reads. It now persists on the client in `localStorage`. |
| Server availability and memory | Parking, ended memory, timers and larger frames are new allocation paths. |
| Logs | Must still hold no tokens, raw IDs, block lists, metadata or positions (AC10). |

Trust boundaries (new or changed compared with #1/#3):
1. Client to server: the token is attacker-controlled input until the HMAC
   passes. After the HMAC passes, the claims are server-authored.
2. Leader vs member vs ex-member (holds an unexpired member token) vs blocked
   member, inside one group.
3. Old connection vs new connection holding the same identity (Q5 "newest wins").
4. App A vs app B, which now share one root secret.
5. Server process lifetime: ended-group memory and the block list don't survive a
   restart, and the leader's client is the source of truth.
6. Same-origin scripts vs stored tokens in `localStorage` (Q11).

## 2. Threats (STRIDE, brief)

| | Threat | Covered by the plan? |
| --- | --- | --- |
| S | Forge a token (`alg` tricks, wrong key, other app's key) | Yes: fixed header, HMAC with per-app key, constant time. See L1 (signature canonical form). |
| S | Forge a token after brute-forcing a weak secret offline (every user holds an HMAC sample) | Partly: there is a 32-byte minimum, but no strength check (M3). |
| S | Use a stolen leader token to take over (newest wins), then keep it fresh through refresh | Accepted risk (bearer tokens, Q5, Q11). The plan documents it. See L6 for making takeover visible. |
| S | A replaced (old) connection keeps acting as leader or member | **Partly**: ownership is only checked on disconnect/leave (M4). |
| T | A member raises its role or recreates a group | Yes: role is in the signed claims, recreation needs a leader token, and `pid` must equal `leaderId`. |
| T | Extend a group's life through recreation or by forging future timestamps | Recreation is covered (`gct` signed). Implausible claims and the timer clamp are not bounded (M2). |
| T | Unblock a member by mistake on a leader return with a stale or omitted list | Not defined (L5). |
| R | No audit trail | Intended (privacy). |
| I | Group-liveness oracle through `tokens.check` or resume errors | Yes: only valid token holders learn anything, and only about their own group. |
| I | Tokens, IDs or block lists in logs or errors | Yes (AC10, AC39, redaction as a second line). See L7 on log linkability. |
| I | Recovery data and tokens persisting on shared devices (minors) | **Not covered**: client pruning uses only `exp` (365 d) (M6). |
| I | Laundering forged previous-secret tokens into current-secret tokens after a compromise | **Not covered** in the rotation docs (M1). |
| D | One member token fills a group through several parked or duplicate sessions | **Not covered** (M5). |
| D | Ended-groups flood evicts real entries | Accepted (Q8). See L4. |
| D | Recreation storms after a restart, `tokens.check` CPU, larger frames | Bounded by the connection cap, inbound limiter (20/s), queue cap (32), and 20 HMACs over at most 2 KB each per check. See L8 on frame memory. |
| D | Timers or parking leaking after a group is dropped | Mostly covered. Made explicit in R7. |
| E | Blocked member gets back in | With the same `pid`: blocked. With a new `pid` via join by group ID: possible until item 4 (documented, accepted). |

## 3. Findings

### Critical / High (blocking)

None.

### Medium (advisory, recommended for this issue)

**M1. Rotation after a compromise launders forged tokens. The docs must
separate "routine rotation" from "compromise".**
Plan sec. 5.1, sec. 9 "Secret rotation", AC2, AC41; commits 2, 16, 25.
*Scenario:* the operator learns that `TOKEN_SECRET` leaked and follows the only
documented procedure: new secret as current, old one as `TOKEN_SECRET_PREVIOUS`.
For the next 8 h the attacker can still forge tokens with the leaked secret.
Each one presented to `tokens.check` or `group.resume` comes back **re-signed
with the new secret** (AC2), so forged tokens survive removing the previous
secret until their `gct` runs out. During that window the attacker can recreate
any dropped group whose ID they know, with any `pid` as leader, and join any
known group as a member.
*Fix:*
- README (commit 25): two procedures. **Routine**: current to previous, remove
  after `MAX_SESSION_MINUTES_CEILING + TOKEN_REFRESH_MAX_SECONDS`.
  **Compromise**: replace `TOKEN_SECRET` and **do not** set the leaked value as
  previous. Every group must be recreated from scratch, which is the price of a
  leak.
- Commit 2: when `TOKEN_SECRET_PREVIOUS` is set, log
  `warn token_secret_previous_set` once at startup ("remove after the rotation
  window"), with no value. That way a forgotten previous secret doesn't stay
  accepted forever without anyone noticing.

**M2. Claims are type-checked but not checked for plausibility, and the timer
clamp can fire early.**
Plan sec. 4.1 (claim schema), 4.2, 5 scheduler (`delay clamped to [0, 2^31-1]`),
6.3; commits 1, 4, 5, 12.
*Scenario:* the server is the only signer, so this matters when the key is
compromised (M1, M3) or the clock steps. A token with `gct` in the year 3000
never reaches `gct + maxSession <= now`. With `exp` at
`Number.MAX_SAFE_INTEGER` it never expires. Recreating from it arms a
max-session timer whose delay is clamped to about 24.8 days. If the clamped
timer **fires and ends** the group, the deadline is off. If it never re-checks,
the group lives on.
*Fix (verify step 4-6 and the scheduler):*
- Reject as `invalid`: `exp - iat !== TOKEN_TTL_SECONDS`;
  `iat * 1000 > now + MAX_CLOCK_SKEW_MS`; `gct > now + MAX_CLOCK_SKEW_MS`;
  `lat > now + MAX_CLOCK_SKEW_MS`; `lat > iat * 1000 + 1000` (a token can't
  record activity after it was issued). Use `MAX_CLOCK_SKEW_MS = 300_000`, so a
  small NTP step back doesn't log everyone out.
- `realScheduler.at()`: when the target is beyond the clamp, **re-arm** at the
  clamp instead of running the task. Timer callbacks re-check the deadline
  against `now()` under the lock before ending (the plan already re-reads the
  record).
- Tests (`token-service.test.ts`, `scheduler.test.ts`): each implausible claim
  is `invalid`. A task 30 days out doesn't run at 24.8 days.

**M3. The secret check catches length, not weakness.**
Plan sec. 5.1 (UTF-8 length >= 32), AC1 ("missing or weak" in the user story);
commit 2.
*Scenario:* every participant holds a valid HS256 token, so every participant
has an offline brute-force oracle. A 32-character human secret (for example a
repeated word or a sentence) passes the length rule and can be cracked with a
wordlist. The attacker then forges tokens for **every app** on the server,
because all per-app keys derive from the one root.
*Fix:*
- In `parseTokenSecrets`, for both variables, in every environment (it can only
  be a mistake): reject a secret with fewer than 16 distinct byte values. Random
  base64 of 32 bytes has about 30. Also reject any value printed in the README
  or the example config (keep a `PUBLIC_EXAMPLE_SECRETS` list next to
  `DEV_TOKEN_SECRET`; in production, refuse the dev secret as planned).
- The message names the variable and the rule ("TOKEN_SECRET looks weak: use
  `openssl rand -base64 32`"), never the value. Don't `trim()` the secret
  silently: either use it as is or reject leading/trailing whitespace with a
  clear error, so a copy-paste newline doesn't produce two "different" secrets
  across instances.
- Tests: `'a'.repeat(40)`, a repeated short word, the README example: refused.
  `openssl`-style values: accepted.

**M4. A replaced session must lose every right at once, not only on
disconnect/leave.**
Plan sec. 6.1 "Membership ownership" (ownership checked for `disconnect` and
`leave` only), 6.2 leader and member resume; commits 6, 11, 14.
*Scenario:* tab A (or a stolen-token holder, or the real leader after a thief
took over) is replaced by B. A's socket is still open, and its queue may
already hold `position.update`, `blocklist.set` or `group.end` frames. If
leader actions check `session.membership.role === 'leader'` and the membership
is cleared only in the `afterPending` delivery, A can still broadcast, change the
block list or end the group after it was told `replaced`. Today
`group-service.ts:156` checks `session.role`, which is exactly that pattern.
*Fix:*
- Under the group lock, replacement clears the old session's `membership` (and
  `parked`) **synchronously**, at the same moment the notifier attachment moves.
  Only the `group.ended replaced` *delivery* goes through `afterPending`.
- Every group action (`position.update`, `group.end`, `blocklist.set`,
  `group.leave`, disconnect) authorizes by `notifier.get(key) === session`
  (ownership), not by the session's cached role alone.
- Test (`resume.int.test.ts`): A sends `position.update` and `group.end`
  pipelined right after B's resume. Both get `NOT_IN_GROUP`, members receive
  nothing from A, and the group stays up.

**M5. One member token can occupy several slots or orphan sessions (duplicate
`pid` in parking and admission).**
Plan sec. 6.5 (`drain` adds parked sessions in arrival order), 3
(`addParticipant`); commits 11, 13.
*Scenario:* a member (or an ex-member with a still-valid token) opens 30
connections and sends `group.resume` with the **same** member token on each
while the group is dropped. Each one is parked (one parked group *per
connection*, nothing per `pid`). On recreation, `drain` admits them all.
`in-memory-group-store.ts:43` dedupes the `pid` in `participantIds`, so the
store counts one member, but the notifier key `ns:gid:pid` is overwritten 29
times. The earlier sessions keep a `membership` without an attachment. They are
never told anything, never counted, and their disconnects either no-op or remove
the live one. The same applies to a member resume of a live group while another
copy is parked. In the other direction, a store without dedupe (item 9 Redis)
would let one token fill the group and lock out real members (`GROUP_FULL`).
*Fix:*
- `ParkingLot` is keyed by `ns:gid:pid` as well. Parking a `pid` that is already
  parked replaces the older session (`group.ended replaced`, unparked), so newest
  wins as in AC20.
- `drain` and member resume treat an existing attachment for the same `pid` as a
  replacement. `addParticipant` stays idempotent per `pid` (document it in the
  `GroupStore` contract for item 9).
- Tests (`parking.int.test.ts`): the same token parked on 3 connections leaves
  one parked session and 2 `replaced`, and one admitted member after
  recreation. The group's connected count is correct after each disconnect.

**M6. Tokens and recovery data stay on shared devices far beyond their use.**
Plan sec. 7.2 (prune only expired-by-`exp` = 365 d, then oldest by `lat`),
AC31-AC34, Q11; commits 7, 20, 22, 25.
*Scenario:* a minor uses a reading app on a school or library computer. The
storage document keeps the token **and the group's metadata and latest
position** (what the group read) for up to 365 days, or until 20 newer groups
push it out. Nothing past the group's max session (8 h ceiling) makes the token
usable, so this is pure retention, readable by the next user's devtools or any
same-origin script. The user also has no offline way to wipe it (`endGroup` /
`leaveGroup` need a connection and a live group).
*Fix:*
- Send `maxSessionMinutes` in `hello.ok.limits` (not secret: it is app config
  the client already obeys indirectly). Commit 7 for the server, commit 20 for
  the client.
- `TokenStore` prunes on **load and on write** every entry with
  `gct + maxSessionMinutes <= now`. Until the first `hello.ok`, it uses a
  conservative client constant of 8 h. Leader recovery data is dropped with its
  token.
- Public `forgetGroup(groupId)` and `forgetAllGroups()`: local-only, no
  connection needed (commit 22). README (commit 25): call `forgetAllGroups()` on
  "log out" or "this is a shared device", pick `storage: 'memory'` or
  `sessionStorage` for kiosk-style apps, and use a CSP to reduce the XSS risk
  from Q11.
- Tests (`token-store.test.ts`): an entry past `gct + maxSession` disappears on
  load without a server call, and `forgetAllGroups()` removes the key.

### Low (hygiene)

**L1. Accept only the canonical signature encoding.** Sec. 1.1 step 3 (decode,
then check 32 bytes); commit 4. Node's base64url decoder ignores the 2 unused
low bits of the 43rd character, so 4 different strings verify for each token
(malleability). Nothing keys on token strings today, but item 9 or a future
replay cache might. Fix: require the signature segment length to be exactly 43,
compute the expected signature as base64url text, and `timingSafeEqual` the two
43-byte ASCII buffers (or re-encode the decoded bytes and require equality).
Test: the last character altered within the same 4-bit group gives `invalid`.

**L2. Put the purpose label in HKDF `info`.** Sec. 1.2, commit 4.
`hkdfSync('sha256', secret, 'sync-system/token/v1', namespace, 32)` is sound
(the namespace pattern makes `info` unambiguous). RFC 5869 puts context in
`info`, though. Use `info = 'sync-system/token/v1:' + namespace` and a constant
salt, so a future second use of the root secret (for example item 4 code
hashing) can't collide with a namespace value. Document that changing the label
logs everyone out.

**L3. Issue and re-sign only from known fields.** Sec. 4.1, `TokenService.issue`
/ `resign`; commit 4. Build the payload object explicitly (fixed key order, the
9 known claims only), and use zod `strip` (not `passthrough`) for the verified
claims. A re-signed token then never carries forward unknown claims an older
server version wrote, and item 4 adds claims on purpose rather than by
accident.

**L4. Ended-groups flood.** Sec. 1.3, 9; commit 10. With 1000 authenticated
sockets doing create+end, the 100k cap turns over in seconds and evicts real
entries (Q8 accepted the consequence). Cheap improvements: store 16-byte binary
refs (or 32 hex characters) instead of 64 hex characters, so memory stays about
6 MB at the cap. Log `warn ended_groups_evicting { count }` at most once per
minute, so an operator sees the flood. No per-group detail.

**L5. Block list semantics on a live leader return.** Sec. 6.2 (record present:
"blockList replaced by the request's list"), 7.3 (rejoin reads the cache
first); commits 14, 21. An omitted `blockList` must **keep** the server's list
(only an explicit array replaces it). Otherwise a resume without recovery data
(another device, or a cleared storage) silently unblocks everyone. On the
client, rejoin reads the block list **from storage**, not the in-memory cache,
so a second tab with a stale cache doesn't undo the other tab's block. Test
both.

**L6. `replaced` must not auto-resume, and a leader takeover should be
visible.** Sec. 7.2-7.3, Q-C; commit 21. Keeping the token on `replaced` is the
right call (section 4). The client must treat `group.ended replaced` as final
for that connection, never as an unexpected drop. Otherwise two tabs (or a thief
and the victim) ping-pong resumes up to the inbound limit. Emit the reason to
the app, so the reading app can say "your group was opened on another
device". For a leader that is the only signal of a stolen token. README notes
it.

**L7. Don't log refs of the group-scoped `pid`.** Sec. 4.7, `logger.ts:54`
(`participantRef` is a 12-hex sha256 prefix). Today `participantRef` hashes the
per-connection ID. If the new code logs `participantRef(pid)`, logs can link
one person across reconnects, resumes and restarts within a group for up to 8
h. Keep logging the connection-scoped ref only (`connectionId`). Add the stable
`pid` to the AC10 sentinel test in raw **and** ref form.

**L8. Frame and queue memory grows about 40%.** Sec. 4.6 (`maxPayload` 41 KB to
57 KB), commit 12. The worst case is `MAX_QUEUED_MESSAGES (32) x 57 KB` per
socket times `MAX_CONNECTIONS`. Still bounded and accepted in #1's terms, but
note it in the README sizing section. Consider a per-connection
queued-bytes cap (for example 4 x `maxPayload`) next to the 32-message cap.
Also cap the client's stored document on load: ignore stored text over 256 KB,
and parse at most the first 20 entries.

## 4. Gate 2 questions: security view

**Q-A (missing or dev secret only for `NODE_ENV` exactly `development|test`;
short secret an error everywhere): agree, strongly.** It is the same
fail-closed rule as #1 S4. "Outside production" would let an unset `NODE_ENV`
in a real deployment run with a random secret (tokens die on restart, which is
merely broken) or with the **public** dev secret, where anyone can forge tokens
for every app (critical). Extend it with M3: the weakness check also applies
everywhere.

**Q-B (the `lat` check for leader tokens only; members by `gct` and
liveness; parked members released after inactivity + slack): agree.** A member
token gives read access only, and its holder already knows the group ID, which
in #1 is enough to join. So a replayable member token adds no new capability.
The rule can't extend a group: a member can't recreate, can't refresh `lat`,
and can't keep a frozen group alive past `lat + inactivity + slack`, and `gct`
caps everything at max session. Conditions: M5 (one slot per `pid`) and the
parking bound in sec. 6.5 as written.

**Q-C (client keeps its token on `replaced`): agree.** It is also the safer
choice. Deleting on `replaced` would let a thief who used a stolen token
**erase the real leader's token** with one resume, making the takeover
permanent and invisible. Keeping it lets the real leader take the lead back.
Condition: L6 (no auto-resume on `replaced`, surface it to the app).

**Q-D (leader `group.leave` gives `LEADER_CANNOT_LEAVE`): agree.** An explicit
error is clearer than an implicit freeze. Make sure it is checked with the
ownership rule from M4.

**Q-E (ended group maps to indicator `none`): no security impact.** Agree.

## 5. Required controls (part of the plan), mapped to commits

| # | Control | Commit(s) |
| --- | --- | --- |
| R1 | Fixed header byte-equal; length cap and charset before decode; signature segment exactly 43 characters compared in constant time (L1); parse only after verify; zod `strip` claims (L3) | 1, 4 |
| R2 | Claim plausibility: `exp - iat === TTL`, no future `iat`/`gct`/`lat` beyond 5 min skew, `lat <= iat*1000 + 1000`, `lat >= gct` (M2) | 1, 4 |
| R3 | Scheduler re-arms beyond the clamp instead of firing; callbacks re-check deadlines under the lock (M2) | 5, 9 |
| R4 | Secret rules: Q-A fail-closed env rule; >= 32 bytes and >= 16 distinct bytes everywhere; public example and dev values refused; no silent trim; previous != current; `warn token_secret_previous_set`; values never logged (M1, M3) | 2 |
| R5 | HKDF per-app keys with purpose label in `info` (L2); cross-app = signature failure | 4 |
| R6 | Replacement clears the old session's membership/parking synchronously; every group action authorizes by attachment ownership (M4) | 6, 11, 14 |
| R7 | Drop (`connected === 0`) and end both clear `GroupTimers`, `TokenRefresher` state and parked entries for the group; `server.close()` leaves no timers | 8, 10, 13 |
| R8 | One parked/attached session per `(ns, gid, pid)`; newest wins with `replaced` (M5) | 11, 13 |
| R9 | Omitted `blockList` on a live return keeps the server's list; client sends the list read from storage (L5) | 14, 21 |
| R10 | `tokens.check`: per-connection 10/min on top of the inbound limiter; no store access for invalid tokens; re-sign only for `live`/`recoverable`/`waiting` and only for previous-secret tokens | 16 |
| R11 | Logs: no tokens, raw or ref'd group-scoped `pid` (L7), block-list entries, metadata, positions; ended refs hashed; L4 eviction warn count only | 10, 17 |
| R12 | Client: `maxSessionMinutes` in `hello.ok.limits`; prune by `gct + maxSession` on load/write; `forgetGroup` / `forgetAllGroups`; stored-document size cap (M6, L8) | 7, 20, 22 |
| R13 | Client: `replaced` is final, never auto-resumed, reason surfaced (L6); tokens never exposed via snapshots, events, errors or logs (AC39) | 21, 22 |
| R14 | README: routine vs compromise rotation (M1); secret generation; shared-device and CSP guidance; XSS caveat (Q11); join-by-ID block bypass until item 4 | 25 |

## 6. What I will check in code mode

- `jwt.ts`: header constant compared before HMAC; no string compare of
  signatures; `timingSafeEqual` on equal-length buffers; canonical 43-character
  signature; `JSON.parse` only after the HMAC passes; RFC 7515 A.1 vector; the
  forged-token matrix from AC7 plus L1 and M2 cases.
- `token-secret.ts` / `main.ts`: the Q-A matrix (`development`, `test`, unset,
  `staging`, `production`), length, distinct-byte rule, dev and example values,
  previous rules, no value in any message or log line (child-process stderr
  test).
- `token-keys.ts`: HKDF parameters and labels; keys differ per namespace and per
  secret.
- `resume.ts` / `group-service.ts`: classification order; `pid === leaderId`
  for leader tokens; ownership-based authorization of every action (M4);
  duplicate `pid` handling in parking and drain (M5); block list replace and
  keep rules (L5); `createIfAbsent` under the lock; `EndedGroups` checked before
  recreation.
- Timers and refresher: cleared on drop, end and close; clamp re-arm; callbacks
  under the lock and idempotent.
- `connection.ts`: `tokens.check` limiter before any verification work; schema
  caps (20 tokens, 2048 characters, 256 IDs with pattern); the
  `ALREADY_IN_GROUP` check first; transport payload formula.
- Privacy: the AC10 sentinel test covers the raw `pid`, its ref, token segments
  and block-list entries; the redaction list; `no-disk` static test.
- Client: lazy `localStorage`, defensive load (`__proto__`, oversize, bad
  entries), `gct`-based pruning, `forget*` APIs, deletion on the AC31 events but
  not on `replaced`, no auto-resume on `replaced`, no tokens in
  snapshots/events/errors/logs.
- Scanners: gitleaks on the PR range (the dev secret in `compose.yaml` and code
  is public by design; anything else is a finding), semgrep on changed files,
  `pnpm audit --audit-level=high`, and the lockfile unchanged except the
  workspace.

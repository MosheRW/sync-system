# Security review (plan): #10 Join methods A-D

Mode: plan, round 1. Reviewed: `docs/issues/10/spec.md` (AC1-AC45, Gate 1
decisions Q1.1-Q6.3) and `docs/issues/10/architecture.md` (head bd77182),
against the code they touch on `main` after PR #8:
`apps/sync-server/src/{tokens/jwt.ts, tokens/token-keys.ts, limits/rate-limiter.ts, limits/constants.ts, logging/logger.ts, groups/group-service.ts, ws/connection.ts, config/apps-config.ts}`.
Prior reviews: `docs/issues/5/security.md`, `docs/issues/7/security.md`.

**Verdict: FAIL.** One high finding (H1): the door-code limits are per group
only, so guessing spread over many groups is neither capped nor visible, and
the plan's brute-force numbers (which the user accepted at Gate 1) are off by
more than three orders of magnitude for an untargeted attacker. The fix is
small and stated below. Everything else is medium or low. The crypto design
(per-app, per-purpose HKDF keys, compact HMAC format, generation-based ticket
revocation, server-signed codes blob) is sound.

## 1. Assets and trust boundaries

- **Admission to a group** (a member token, live position, metadata, and from
  item 5 the roster and handoff eligibility). After this issue the only ways
  in with a new identity are a current code or a QR ticket.
- **Join codes** (group code, door code, alphanumeric code): server memory
  (`GroupRecord.codes`, `CodeIndex`), the leader's screen, and the leader's
  client storage (inside the codes blob, plaintext base64url JSON).
- **`TOKEN_SECRET`** and the keys derived from it: token, QR-ticket and
  codes-blob keys, per app.
- **QR tickets**: bearer strings with a lifetime, shown on screen and carried
  in deep links.
- **Display names** in approval requests (users may be minors).
- **Server memory and timers**: code index, door guard, approval queue,
  limiters.
- Untrusted input: every frame after the handshake. The app key ships in the
  client bundle, so "an app's client" means "anyone on the internet". There
  are no per-IP limits (Q5.3), and per-connection limiter state is forgotten
  on disconnect, so per-connection budgets can be reset by reconnecting. Only
  per-group and per-app limits hold against a scripted attacker.

## 2. Threats (STRIDE, brief)

| | Threat | Plan answer |
|---|---|---|
| S | Guess a door code or C code to join someone else's group | Per-group door limits, per-app 600/min budget. Targeted guessing: sound. Untargeted guessing across groups: **not capped (H1)**. |
| S | Forge or reuse a QR ticket | HMAC-SHA256, per-app key, expiry, generation check. Sound. Small generation-reuse window after a restart (L1). |
| S | Leader picks its own codes on recreation (squat a code) | Server-signed blob bound to app (key) and group ID. Sound. Older-blob replay revives rotated codes (M1). |
| T | Cross-purpose confusion (ticket as token, blob as ticket) | Separate HKDF `info` per purpose and per app, different segment counts. Sound (R4). |
| R | Leader can't tell an attack is happening | Rotations and pauses are visible, but sub-threshold guessing is silent (H1). |
| I | Oracle between unknown code, wrong door code, invalid ticket | `CODE_NOT_FOUND` and `QR_INVALID` fixed text, no details, logs without group ref. Sound. Group-code existence is an accepted oracle (Q2.2). |
| I | Codes, tickets, names in logs | Distinct wire names (D5), allowed-field logging, redact paths. Sound; two gaps in redaction (L3). |
| D | Approval spam, pause abuse, budget exhaustion, code-space exhaustion | Bounded queues, fixed budgets, accepted at Gate 1. Pause abuse and code-space squatting remain (M2, M3). |
| E | Non-leader approves, rotates, issues QR | Ownership-checked via notifier (M4 rule from #5), request IDs scoped to the leader's own group. Sound (R12). |

## 3. Findings

### Critical
None.

### High (blocking)

**H1. Door-code guessing spread over many groups is uncapped and silent; the plan's odds are per group only.**
Location: architecture.md 5.3 (door constants), 8.1 "Door code (A)"; spec
AC29, "Defaults" note under the table; `DoorGuard` design in section 3.

Scenario: an anonymous script (public app key, many sockets) enumerates live
group codes of one app (they are openly shown and `DOOR_CODE_REQUIRED` vs
`CODE_NOT_FOUND` is an accepted oracle), then sends at most 4 wrong door codes
per group per 10 minutes. The 10-minute sliding window lets those 4 expire, so
no group ever reaches 5 failures, no door code rotates, and **no leader sees
anything**. The only cap left is the per-app join budget: 600/min = 864 000
attempts/day, each with probability 10^-6 of being right. Expected break-ins:
about **0.86 per day per app** into some random group (minus budget spent on
enumeration), versus the 5 x 10^-4 per group per day in the plan and the
~10^-3 per app per day accepted for method C (Q5.6). Method A is the default
for every app (`["A","D"]`). Impact: a stranger silently holds a 365-day
member token for a group that may contain minors, sees content and position,
and with item 5 sees names and becomes a handoff candidate.

A smaller error in the same section: for one targeted group the steady state
is 5 guesses per 10 minutes, not 15 per 40. After the first pause the three
earlier rotations are still inside the 30-minute window, so every later
rotation triggers a new pause at once. That is about 720 guesses/day
(7 x 10^-4/day per group), bounded per session by `maxSessionMinutes`
(default 180 min: about 100 guesses, ~10^-4 per session). Still fine for a
targeted attack.

Fix (required controls R1a-R1c):
- **R1a. No silent sub-threshold guessing.** Count door failures **since the
  last door-code change**, not in a sliding 10-minute window (or use a window
  at least as long as `maxSessionMinutesCeiling`). Every 5th wrong door code
  against the same door code rotates it and tells the leader. This is
  stricter than AC29, so AC29 still holds. Pause rule unchanged.
- **R1b. App-wide cap on wrong door codes.** A fixed constant
  `DOOR_FAILURES_PER_APP_PER_MINUTE` (recommended **30**). Before the
  constant-time compare, if the app's wrong-door budget for the window is
  used up, answer `RATE_LIMITED` (join-attempt text, `retryAfterMs`) without
  comparing. Record an event only when the compare fails, so correct door codes
  never use the budget. One `warn` log per app per window, namespace only
  (`door_failures_app_budget_exhausted`). The aggregate odds become
  budget x 1440 x 10^-6 per day:

  | Wrong-door budget per app per min | Expected break-ins per app per day at full attack |
  |---|---|
  | none (plan as written, 600 join budget) | ~0.86 |
  | 60 | ~0.086 |
  | **30 (recommended)** | **~0.043 (about 1 in 23 days)** |
  | 10 | ~0.014 |

  This adds no new class of DoS: one client can already use up the app's
  600/min join budget and block every join (accepted, Q5.2). It does make
  blocking method A cheaper. The user should confirm the value at Gate 2.
- **R1c. Honest numbers.** Section 8.1, the spec "Defaults" note and the
  README brute-force reasoning (AC43) state the per-group steady state
  (5 per 10 min, bounded by session length) **and** the per-app aggregate
  with the chosen R1b value, and say that 6-digit door codes are a
  "same room" control: apps that need more should use C or B.

### Medium (advisory; M1 is made a required control)

**M1. An older codes blob brings rotated (leaked) codes back after a restart.**
Location: architecture.md 4.8 "Accepted limit", section 9 "Multi-tab
leaders" and "Older blob replay"; commit 17.
Scenario: the leader rotates because a blocked member knows the codes. A stale
second tab (storage merge rule "newest token `iat` wins") still holds the
pre-rotation blob. The server restarts and the stale tab recreates the group
first: the server accepts the older, correctly signed blob, the leaked codes
come back, and unexpired QR tickets of that older generation work again. The
blocked person is back in as a new identity, which is exactly what AC37's
"mitigation is `codes.rotate`" promises can't happen.
Fix (**R2**, commit 17): the client stores the codes payload's `generation`
next to the blob and never replaces a stored blob with one of a lower
generation for the same group, independent of the token merge rule
(cross-tab merge: highest generation wins). After a successful recreation or
leader return, store what the server returned. Test: two tabs, rotate in one,
the other's older blob never overwrites the newer one.

**M2. Unlimited group creation lets one client squat the 6-digit code space.**
Location: architecture.md 5.3 `MAX_CODE_DRAWS`, section 9; pre-existing in
`group-service.ts` `create()` (no per-app live-group cap or create limit).
Scenario: a script creates groups and disconnects; each stays frozen in memory
until the inactivity limit (20 min default). At about 100 creates per second
it holds ~10 % of an app's 10^6 group codes. Then (a) a mistyped or stale B
code has a 10 % chance of reaching the attacker's group, which receives the
joiner's display name and can approve them into its own group; (b) at a much
higher fill, `CODES_EXHAUSTED` denies group creation (with 20 draws, 80 % fill
gives ~1 % failures). Memory pressure from the same groups is a pre-existing
#1 issue. The new code space makes the squatting worse.
Fix (advisory, follow-up issue): a fixed per-connection `group.create` rate
and a per-app live-group cap; until then, state the limit in the README. Not
blocking, because the root cause predates this issue and C codes and door
codes are unaffected.

**M3. Anyone who knows a group code can keep that group's method A paused.**
Location: architecture.md 5.3 / AC29.
Scenario: 15 wrong door codes, then 5 more every 10 minutes, keep method A
joins of a group paused (correct door codes included) for as long as the
attacker keeps going. Within the 600/min app budget one client can do this to
more than 1000 groups at once. The leader's way out is `codes.rotate` (new
group code; the attacker has to re-enumerate). This is the PRD's chosen
trade-off (Q5.1). R1b caps it at 30 wrong guesses per minute per app, so it
then covers about 60 groups.
Fix (advisory): document it in the README next to the pause. Item 5 can add
"rotate on pause" UI. No plan change needed.

### Low (hygiene; L1-L3 and L7 are required controls)

**L1. A recreation without a blob can reuse an old generation.**
Location: architecture.md D4 (`max(prev + 1, floor(now / 1000))`), 4.8.
Scenario: the leader rotates several times within one second (6/min allowed,
plus door rotations), so the generation runs a few units ahead of
wall-clock seconds; the server restarts within those seconds; the leader
recreates without a blob (`prev = 0`) and gets `floor(now/1000)`, which can
equal an outstanding ticket's generation for the same group ID. That ticket
works again. A server clock stepping back has the same effect (noted in
section 9).
Fix (**R3**, commit 4): use milliseconds, `generation = max(prev + 1, now_ms)`
(a safe integer; the ticket grows by 3 characters and stays far below 256). The
clock-step case stays as a documented NTP assumption.

**L2. Display-name rules miss some invisible and malformed characters.**
Location: architecture.md 4.5.
Scenario: JSON can carry lone surrogates (`\ud800`), which break code-point
counting and rendering in the leader's UI. U+200E/U+200F (LRM/RLM), U+061C
(ALM), U+200B and U+FEFF are format characters that still reorder or hide
text in the prompt ("Teacher" with hidden marks).
Fix (**R9**, commit 1): also reject strings that aren't well-formed UTF-16
(`String.prototype.isWellFormed`, or a surrogate regex), and U+061C, U+200B,
U+200E, U+200F, U+FEFF. Keep ZWJ (U+200D) and emoji tag characters for emoji.
Advisory: the client README tells apps to render names as text only.

**L3. Redaction gaps.**
Location: architecture.md 2.2 `logger.ts`, 8.3.
`JoinCodesPayload.blob` is not in the new `REDACT_PATHS` (`codes` covers it
only at depth 0/1 when the whole object is logged). Also `reason` is already a
redacted path (#5), so log fields named `reason` (planned "fixed enum") are
silently removed. That is not a leak, but it hides the data.
Fix (**R10**, commit 18): add `blob` and `*.blob`; name the enum log field
something else (`cause`, `outcome`), as 6.1 already does for `join_rejected`.

**L4. Per-connection join and `qr.issue` budgets reset on reconnect.**
Location: architecture.md 3 ("forgotten on disconnect").
This matches #7 L-2. They cut noise but are not a security bound. All odds
must rest on per-group and per-app limits (H1 does this).
Fix (advisory): say so in the README brute-force paragraph.

**L5. QR ticket payload is readable.**
The ticket's payload (base64url JSON) shows the group ID and generation to
anyone who sees the QR. After AC36 the group ID is no longer an admission
credential, so this is acceptable. Keep the AC36 static test ("no client
message carries `groupId` as an admission field") so it stays true.

**L6. `QR_TICKET_SECONDS_CEILING` allows 24-hour multi-use tickets.**
An operator can let a photo of the screen work for a day. Fix (advisory): the
README calls tickets bearer credentials and recommends keeping the app value
short. The client README deep-link advice also says: read the ticket from the
fragment, then remove it from the URL (`history.replaceState`), and never log
or persist it.

**L7. Approval settlement must happen exactly once, under the group lock.**
Location: architecture.md 4.6.
Scenario: `join.approve` races the joiner's disconnect, `join.cancel` or the
deadline timer. If they don't serialize, a closed socket's participant is
added (orphan member and token) or the leader gets two outcomes.
Fix (**R11**, commit 11): approve, deny, timeout, cancel, disconnect and group
end all take the group's `KeyedLock`, remove the entry from the queue first
(the first to remove it wins), and approve re-checks the joiner's session is
still open before `addParticipant`.

**Confirmation (Q5.6): method C odds accepted.** 31^8 = 8.5 x 10^11. At the
full per-app budget against 1000 live C groups: ~1.0 x 10^-3 per day per app.
It shares the same budget as A, so an attacker can't spend it on both. Sound.
No change.

## 4. Gate 2 questions: security view

- **Q-A (`createGroup` signature):** API shape only. No security impact.
  Either option is fine.
- **Q-B (door rotations bump the QR generation):** keep the spec (one
  generation). A door rotation already makes the leader re-announce a new
  door code, which disrupts more than a QR re-issue that the app does
  automatically on `codesChanged`. One generation keeps the blob, recovery and
  ticket checks simple. A second counter adds states to get wrong. The
  attacker needs the group code and is bounded by the pause (and by R1b).
  Condition: the README states that a door rotation invalidates tickets, and
  the D7 recipe re-issues on `codesChanged`. With R1a, rotations come every 5
  wrong guesses regardless of time, which is still bounded by the pause.
- **Q-C (`GROUP_ENDED` for pending joiners):** `GROUP_ENDED` is fine. The
  pending joiner already knows the group exists, so a new code reveals
  nothing more. Condition: the frame carries no `groupId` and no `details`, as
  today's `errorMessage(ErrorCode.GROUP_ENDED)` (R13).
- **Q-D (QR refresh):** app-driven is the better choice for security. Tickets
  are minted only while the QR is shown, so fewer valid bearer strings exist.
  An opt-in timer is acceptable if it stops when the app says the QR is
  hidden. Keep the D7 decision.
- **Informational items:** I agree with D4 (with R3's millisecond change), D5
  (distinct wire names), the stricter bidi rule (extended by R9), and D6.

## 5. Required controls (part of the plan), mapped to commits

| # | Control | Commit (architecture 11) |
|---|---|---|
| R1a | Door failures counted since the last door-code change (no 10-min decay); every 5th rotates and notifies the leader (H1) | 9 |
| R1b | `DOOR_FAILURES_PER_APP_PER_MINUTE` fixed constant (recommended 30, user confirms at Gate 2): checked before the compare, recorded only on a wrong compare, `RATE_LIMITED` with `retryAfterMs`, one namespace-only warn per window; test with two apps (H1) | 9 (limiter infrastructure in 8) |
| R1c | Corrected brute-force numbers (per-group steady state and per-app aggregate) in architecture 8.1, spec note and README (H1) | 21 (and an architecture revision now) |
| R2 | Client keeps the highest-generation codes blob per group, across tabs and the token merge (M1) | 17 |
| R3 | Generation in milliseconds: `max(prev + 1, now_ms)` (L1) | 4 |
| R4 | HKDF `info` exactly `sync-system/token/v1:<ns>` (unchanged, pinned bytes), `sync-system/qr-ticket/v1:<ns>`, `sync-system/codes-blob/v1:<ns>`. Keyring cache keyed by purpose and namespace (separate instances or a composite key). Test: keys differ per purpose and per app; ticket/blob/token are never interchangeable in any direction | 3 |
| R5 | `verifyCompact`: length cap first, exact two-segment pattern, 43-character signature, constant-time compare against **every** key, JSON parsed in try/catch, exact claim schema (`v === 1`, `g` matches `GROUP_ID_PATTERN`, `n`/`e` safe non-negative integers, plausibility bound on `e`), result objects instead of throwing with input | 3, 12, 13 |
| R6 | Door code compare: both sides validated to `^[0-9]{6}$` first, then `timingSafeEqual` on two 6-byte ASCII buffers; a paused group never compares | 6, 9 |
| R7 | `CODE_NOT_FOUND` and `QR_INVALID` built from one constant each (fixed text, no `details`, never echo input); deep-equal tests across unknown code, other app's code, unused code type, and every invalid-ticket case; `join_rejected` logs carry no group ref for `not_found` / `qr_invalid` | 6, 12 |
| R8 | Validation order per 4.3: busy, per-connection budget, per-app budget, then normalization and lookup; refused attempts never reach `CodeIndex.lookup` (spy test). Lookup outside the lock is re-checked under the lock | 6, 8 |
| R9 | Display name: rules of 4.5 plus well-formed UTF-16 and no U+061C, U+200B, U+200E, U+200F, U+FEFF; same function on server and client (L2) | 1 |
| R10 | Redact `blob`, `*.blob` in addition to the planned paths; no log field named `reason` for new events (L3) | 18 |
| R11 | Approval settles exactly once under the group lock; approve re-checks the joiner session; request IDs from 16 CSPRNG bytes, looked up only in the acting leader's own group queue (L7) | 11 |
| R12 | `qr.issue`, `codes.rotate`, `join.approve`, `join.deny` authorized by ownership (notifier, M4), not by cached role; per-action `NOT_LEADER` texts | 10, 11, 12 |
| R13 | Codes, blobs and display names are sent only to the ownership-checked leader connection (never broadcast, never to members or pending joiners); pending-joiner frames carry no `groupId`; member-socket frame test | 5, 9, 11, 13 |
| R14 | `CodeIndex` claim is all-or-nothing and synchronous; codes released, timers cancelled and limiters forgotten on end, drop and `close()` (ManualScheduler pending = 0) | 4, 5, 9, 11 |
| R15 | `group.join` removed from schema, dispatch, `GroupActions` and client; static test that no client message type carries a raw `groupId` admission field | 15 |
| R16 | README: corrected odds (R1c), per-connection budgets reset on reconnect (L4), pause abuse and `codes.rotate` (M3), group-code squatting limit (M2), QR tickets are bearer credentials (fragment, strip from URL, never log or persist; door rotations invalidate them) (L6, Q-B), render display names as text (L2), block-list residual (AC37) | 21 |

## 6. What I will check in code mode

- R1a/R1b: `DoorGuard` failure accounting has no time decay before rotation;
  the per-app wrong-door limiter sits before the compare and records only
  wrong compares; tests show 4 + 4 + ... failures over time still rotate, and
  two apps don't share the budget.
- Generation computation (ms) and the generation equality check on tickets.
- `signed-blob.ts`, `qr-tickets.ts`, `codes-blob.ts`, `token-keys.ts`: HKDF
  labels, cache keys, pinned token key bytes, constant-time checks over every
  key, claim schema, no exceptions carrying input.
- `codes.ts`: only `crypto.randomInt` (no `Math.random`, no modulo bias);
  door != group code; bounded draws.
- Error builders for `CODE_NOT_FOUND` / `QR_INVALID`; byte-identical replies.
- Approval queue: lock usage, exactly-once settlement, scoped request lookup,
  caps (10 per group, 1 per connection), timers cleared.
- Ownership checks on all leader actions; codes never in member frames.
- Client: blob storage keeps the highest generation (R2), validation on load,
  deletion with recovery data; no codes, tickets, blob or names in logs or
  error texts.
- Redaction paths and the privacy log-capture tests; `npm audit`, gitleaks and
  semgrep on the changed files.

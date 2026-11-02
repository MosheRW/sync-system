# Security review (plan): #7 Harden token recovery (follow-up to #5)

Mode: plan, round 1. Reviewed: `docs/issues/7/spec.md` (AC1-AC25, D1-D4) and
`docs/issues/7/architecture.md` (head 6d21903), against the code they touch:
`apps/sync-server/src/{server.ts, groups/group-service.ts, limits/rate-limiter.ts, ws/connection.ts}`,
`packages/client/src/{client.ts, token-store.ts, errors.ts}`.
Finding IDs from PR #6 (L1-L5 security, A1-A4 QA) are prefixed `#6-` below,
so they don't clash with this review's IDs.

**Verdict: PASS.** No critical or high finding. One medium finding (M1) that
becomes a required control, five low findings. The plan fixes every
#6 finding it set out to fix.

## 1. Assets and trust boundaries
- **Token secrets** (server process memory). Boundary: `createSyncServer`
  callers (`main.ts`, test helpers, any future entry point).
- **Participant tokens** at rest in browser `localStorage`, shared by every
  tab of the same origin (and by every user of a shared device).
- **Server CPU and memory**: HMAC verification for `tokens.check`, inbound
  message queues per socket.
- **Client availability**: the reconnect loop, which can be steered by a
  hostile or broken server (or a network attacker on `ws://`).
- Untrusted inputs: every WebSocket frame after the upgrade. The app key is
  public (it ships in the client bundle), so "authenticated app" means
  "anyone on the internet" for rate-limit purposes.

## 2. Threats (STRIDE, brief)
| | Threat | Plan answer |
|---|---|---|
| S | A new entry point starts with a random secret, so tokens break on every restart and the Q-A rule is skipped | L1: required field plus runtime `ConfigError`, no fallback. Sound. See L-3 for `previous`. |
| T | A tab writes back a token that another tab removed or replaced | L5 merge rules. Sound, except the read-failure path (M1) and the documented residual (L-4). |
| I | Error texts echo received values | A1 table is `as const`, no interpolation; test checks it. Sound. |
| D | Many sockets on one app multiply HMAC work | L2 per-app budget checked before `verify()`. Sound; side effect in L-2. |
| D | Large queued frames exhaust memory | L3 byte cap 4 x maxPayload, same close path as the count cap. Sound; see L-5. |
| D | A server that never answers `group.resume` keeps the client reconnecting forever | L4 predicate. Sound for the timeout itself; small gap in L-1. |
| E | None new: no route, role or auth change. |

## 3. Findings

### Critical / High (blocking)
None.

### Medium (advisory, made a required control: R5)

**M1. A storage read failure can drop dirty marks and bring back a deleted token.**
Location: architecture.md section 1 "L5", merge rules 2-3; `token-store.ts`
`#readStored()` (it returns `this.#entries` when `getItem` throws).
Scenario: tab A runs `forgetAllGroups()` (log out on a shared device) and
`removeItem` fails, so the groups are marked dirty with their stored token and
memory is empty. On the next operation `getItem` also throws, so `#readStored`
returns the in-memory copy (empty) as if it were storage. Rule 2 sees "mark had
a token, stored entry absent", decides another tab deleted it, and **drops the
mark**. On a later operation the read works again, the group is no longer dirty,
and the old token in storage (never deleted) merges back into memory and is
written again. The same happens after a failed `forgetGroup`. The user logged
out, but the credential comes back.
Fix: `#read()` must tell "read failed" apart from "entry absent". On a read
failure, keep every dirty mark unchanged and use memory for dirty groups
(today's behaviour); apply rules 2 and 3 only to a document that was actually
read. An unparsable or oversized document can keep its current treatment
(empty), since that only ever removes tokens. Add a test: failed remove, then
failed read, then successful read and write: the group stays deleted.

### Low (hygiene)

**L-1. L4: a drop while the automatic resume is still pending can still count as stable.**
Location: architecture.md "L4"; `client.ts` `#connectedAt` is set on `welcome`
(line ~1061), but `group.resume` is sent only after the async `findFresh()`
read, so its timer fires `stableAfterMs + delta` after `#connectedAt`.
Scenario: a hostile server answers `hello`, ignores `group.resume`, and closes
the socket at about 10 s after `welcome`. The close arrives before the client's
resume timer, the drop is `CONNECTION_LOST` (not `REQUEST_TIMEOUT`), and
`connectedFor >= stableAfterMs` resets the attempt count. The loop survives,
although the window is a few milliseconds plus network jitter wide.
Fix (recommended, fits D3's intent "a resume that never completed is not a
stable connection"): also skip the stability reset when the drop happens while
the automatic resume request is still pending. A successful resume still resets
as today, so AC13 is unchanged. If the team keeps the plan as is, record this in
"Deviations / known limits"; it does not block.

**L-2. L2: one anonymous client can use up an app's whole `tokens.check` budget.**
Location: architecture.md "L2"; `group-service.ts` `checkTokens`.
Scenario: the app key is public and the per-connection limiter is forgotten when
a connection closes, so ~60 sockets (or a few sockets that reconnect) sending
garbage tokens hold the app's 600/min budget at zero. Every real user of that
app then gets `RATE_LIMITED` from `checkTokens()`. `group.resume`, joins and
updates are not affected, so impact is limited. This is the accepted cost of D1
and is much cheaper than the HMAC load it prevents.
Fix (advisory): add one `warn` log `tokens_check_app_budget_exhausted` with
`namespace` only, at most once per window per app, so operators can see the
attack; and say in the README "Fixed limits" paragraph that the budget is
shared and can be used up by one client. Never log tokens or connection IDs (AC6).

**L-3. L1: the runtime check validates `current` only.**
Location: architecture.md "L1".
Scenario: an untyped caller passes `{ current: <32 bytes>, previous: 'abc' }`
(string or short buffer); the keyring derives a key from a weak or wrong-typed
previous secret, and tokens signed with it verify.
Fix: check `Buffer.isBuffer(current) && current.length >= MIN_TOKEN_SECRET_BYTES`,
and the same for `previous` when it is not `undefined`. Run the check before the
HTTP server and `WebSocketServer` are created (the plan says "before creating
anything"; today the fallback sits after both). The error names the field only.

**L-4. Residual cross-tab case (accepted, documented).**
Location: architecture.md "L5", "Known residual limit".
A group that tab A stored for the first time, whose write failed, can be written
back after tab B's `forgetAllGroups()`. It needs a failed write plus a log-out
in another tab while A stays open, and the README tells users to close other
tabs first (AC18). Accepting it is sound; tombstones would change the stored
format, which the spec excludes.
Optional narrowing without a format change: record in the mark whether the
storage key existed at the failed write. If it existed then and is missing now,
only `removeAll()` can have removed it, so storage wins for every dirty group.
Only the "very first write ever failed" case would then remain.

**L-5. L3: aggregate inbound memory is still large at the connection ceiling.**
Location: architecture.md "A4" README text.
The per-socket bound (~224 KiB plus the frame being handled) is right, but at
`MAX_CONNECTIONS` 10 000 the worst case is ~2.2 GiB. Fix: state the aggregate
next to the per-socket figure in the README so operators size memory, or lower
`MAX_CONNECTIONS`. No code change.

## 4. Questions raised by the orchestrator

- **Client `errors.ts` keeps the old texts.** No security impact: those texts
  are local fallbacks, contain no received values, and codes are what clients
  act on. Keeping it out of scope is fine; a follow-up is cosmetic only.
- **Residual cross-tab case.** Acceptable as documented (L-4). It is
  independent of M1, which is a real gap in the new rules and must be fixed.
- **Per-connection before per-app ordering.** Sound. The limiter records only
  accepted events, so a socket over its own 10/min never spends the shared
  budget; the reverse order would let one socket at the inbound rate drain it.
  Both checks run before any `verify()`, store or `ended` access (AC5). The
  per-app key is `session.app.namespace` from the handshake, never from the
  message. The cost (a per-app refusal still uses a per-connection slot) is
  harmless.
- **L1 runtime check.** Sound, with L-3 (validate `previous`, `Buffer.isBuffer`,
  run before any socket is created).
- **L5 merge rule.** Sound in principle: comparing by raw stored token string
  (not object identity) and letting storage win only on removal or a strictly
  newer `iat` always errs towards deleting, never towards resurrecting, except
  in the read-failure path (M1). Using unverified `iat` from storage is fine:
  anyone who can write this origin's `localStorage` can already read the tokens.
  The `removeAll()` failure marking (every stored and in-memory group, with its
  stored token, so memory's "absent" wins) is correct.

## 5. Required controls (part of the plan)
| # | Control | Commit |
|---|---|---|
| R1 | `createSyncServer` throws `ConfigError` before creating any server/socket when `tokenSecrets` is missing, `current` is not a Buffer of >= 32 bytes, or `previous` is present and not a Buffer of >= 32 bytes. No random fallback left in `src/`; the message holds no secret value. | 1 |
| R2 | `tokens.check`: per-connection limiter, then per-app limiter keyed by `session.app.namespace`, both before any `verify()` / store / `ended` access. Test asserts `verify` is not called on a refused check. Both limiters cleared in `GroupService.close()`. | 3 |
| R3 | Inbound byte cap checked in `onMessage` before enqueue, using the raw frame size (Buffer, ArrayBuffer, Buffer[]), released in the same `finally` as `queueLength`, closing through `closeFlooded()` only. | 4 |
| R4 | L4 reset skipped for a client-side `group.resume` `REQUEST_TIMEOUT`; the token is not deleted on that path (AC12 test). (L-1 recommended in addition.) | 6 |
| R5 | M1: a storage read failure never drops or changes dirty marks; rules 2-3 apply only to a document that was really read. Test: failed remove, failed read, then successful read and write keeps the group deleted. | 7 or 8 |
| R6 | Error texts come only from the fixed `as const` table; no received value is interpolated; `RATE_LIMITED` / `NOT_LEADER` cannot be sent without an action (type-level). | 2 |
| R7 | No new log field carries a token, participant ID or connection ID; storage errors logged by error name only. | all |
| R8 | No new dependency; lockfile unchanged; `pnpm audit --audit-level=high` exits 0. | all |

## 6. What I will check in code mode
- `server.ts`: no `randomBytes` left; validation is the first statement; tests
  cover missing, `{}`, short `current`, bad `previous`, and nothing listening.
- `group-service.ts`: order of the two limiters and `verify()`; `close()` clears
  both; exact texts per action at all 7 sites; no interpolation.
- `connection.ts`: byte accounting on every path (including frames that arrive
  during the handshake and the frame being processed), release in `finally`,
  no double release.
- `client.ts`: the predicate checks `source === 'client'` and
  `request === 'group.resume'`; whether L-1 was taken or recorded.
- `token-store.ts`: R5; marks compare token strings; `removeAll()` failure marks
  stored and in-memory groups; the residual case is the only one the tests leave open.
- READMEs: shared-budget note, aggregate memory note, `forgetAllGroups` guidance.
- Scanners: gitleaks, semgrep and `npm audit` on the PR range, as installed.

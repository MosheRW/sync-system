# Security review (plan): #12 Limit group creation and live groups per app

Mode: plan, round 1. Reviewed: `docs/issues/12/spec.md` (AC1-AC8, open
questions) and `docs/issues/12/architecture.md` (head fab7539), against advisory
M2 in `docs/issues/10/security.md` and the code they touch on this branch:
`apps/sync-server/src/{groups/group-service.ts, groups/resume.ts, lifecycle/lifecycle-service.ts, limits/constants.ts, server.ts, main.ts, config/apps-config.ts, config/env.ts, storage/redis/{keys.ts, unit-of-work.ts, codes.ts, ended.ts, sweeper.ts}, joins/join-service.ts}`.

**Verdict: FAIL.** One high finding (H1). The plan says one instance's create
budget cannot fill the 10 000 cap, so the cap cannot be used to deny an app.
That is wrong. The reasoning assumes an abandoned group lives about
`inactivityLimitMinutes` (20 min). An attacker who keeps the leader tokens can
keep each abandoned group alive until `maxSessionMinutes` (180 by default, up
to 480) with one cheap, unlimited leader return every 20 minutes. At
120 creates/min one script on **one** instance reaches 10 000 live groups in
about 84 minutes. After that every legitimate `group.create` in the app gets
`APP_GROUP_LIMIT`, for hours, even after the attacker stops. Before this issue
the same effort only squatted about 2 % of the code space. As planned, the cap
turns that squatting into an app-wide denial of service. Everything else is
medium or low. The ordering of the checks, the Lua design, key safety, logging
and the error contract are sound.

## 1. Assets and trust boundaries

- **Group creation availability per app**: the new cap is a shared resource
  every user of the app depends on.
- **The 10^6 six-digit group-code space per app** (method B): squatting it
  routes mistyped codes, with the joiner's display name, to an attacker (M2 of #10).
- **Server memory and Redis**: limiter state, the new `<base>:v1:lg:<ns>`
  sorted sets.
- **Leader tokens** (365-day bearer tokens). Holding one allows a leader
  return to a live group and, after an epoch change, a recreation.
- Untrusted input: every frame after the handshake. The app key ships in the
  client bundle, so anyone can create groups. There are no per-IP limits, and
  per-connection state resets on reconnect. Only per-app and global bounds hold
  against a script.
- Trusted: app config (namespace, limits), server options built in `main.ts`.

## 2. Threats (STRIDE, brief)

| | Threat | Plan answer |
| --- | --- | --- |
| D | Squat the group-code space with abandoned groups (M2) | Cap at 1 % of codes. **Closes M2's squatting part.** |
| D | Fill the cap so nobody else can create (app-wide DoS) | Claimed impossible from one instance. **Wrong (H1).** Accepted for N instances (M3). |
| D | Use up the app's 120/min create budget (per-instance DoS) | Not discussed (M1). Same pattern as the accepted join budgets. |
| D | Leak cap slots through failure paths so the count drifts up | Release on failure, score-bounded pruning. Gaps (M2, L1). |
| T | Redis key injection or script injection | Key parts checked against patterns, constant script, KEYS/ARGV only. Sound. |
| E | Get past the cap with `group.resume` recreations (Q-4) | Needs leader tokens issued before an epoch change, with a fresh `lat`. Bounded, not a bypass (L3). |
| E | Turn off limits through the test-only `groupLimits` option | Not wired in `main.ts` (checked), no env or app field. Guard the values (L2). |
| I | Refusals reveal codes, other groups or other apps | No code is drawn before refusal, fixed texts, `maxLiveGroups` is a public constant, state is per app. Sound (L5 is minor). |
| I | Codes or IDs in logs | Namespace-only, throttled warnings. Sound. |

## 3. Findings

### Critical
None.

### High (blocking)

**H1. One client on one instance can fill the live-group cap and block group creation in the app for hours.**
Location: architecture.md 2 Q-1 "Reasoning" (second bullet), 8 "Self-DoS of an
app through the cap"; `group-service.ts` `resume()`/`resumeLocked()` (no limit on
a live leader return), `lifecycle-service.ts` `activity()`;
`APP_DEFAULTS.maxSessionMinutes = 180`, `MAX_SESSION_MINUTES_CEILING` default 480.

Scenario: a script uses the public app key to create groups at the per-app
budget (120/min, using about 20 sockets to get past the 6/min per-connection
rate), keeps every leader token, and disconnects. Every <20 minutes it resumes
each group with its leader token (no rate limit on a live leader return) and
sends one leader action (`leader.activity` or a position update). That moves
`lastActivityAt` and resets the leader window, and then it disconnects again.
That is about 500 short connections a minute. The groups now live until max
session: 120 x 180 = 21 600 > 10 000, so the cap is full after about 84 minutes.
From then on every create in the app, on every instance with Redis, gets
`APP_GROUP_LIMIT` until the attacker's groups reach max session (up to 3 h by
default, 8 h at the ceiling), after the attack stops. Without the cap the
same attack only holds about 2 % of the code space. The plan's Q-1 shows the
user that "one instance's create budget alone cannot fill the cap", so the
trade-off at Gate 2 would be decided on a wrong claim.

Fix (architect, pick one and show it at Gate 2 with the corrected numbers):
1. **Recommended: make the per-app create budget global and tie it to the cap.**
   Enforce it in Redis, for example as a second sorted set or counter in the
   same `RESERVE_LIVE` script, so it is atomic and not per instance. Size it so
   `creates allowed per app within maxSessionMinutes(app) < MAX_LIVE_GROUPS_PER_APP`
   with margin. For example, a sustained window of the app's
   `maxSessionMinutes` that allows at most about cap/2 creates, plus the 120/min
   burst limit. Then no amount of keep-alive, and no number of instances, can
   fill the cap from the create budget alone. Only connected leaders can (L4).
   This also closes M3.
2. Or keep the budget per instance, but derive it per app so that
   `rate x maxSessionMinutes(app) <= cap / 2` (about 27/min at 180 min, 10/min
   at 480). Or raise the cap per app to at least `2 x rate x maxSessionMinutes(app)`.
   That trades squatting odds for availability, for example 43 200 = 4.3 % at
   the defaults. A test must check this inequality for the ceilings.
3. Or the user explicitly accepts "one client can block creation in an app for
   up to max session", with that sentence (not the current claim) in Q-1, in
   section 8 and in the README residuals. If the user accepts it at Gate 2, I
   will treat H1 as an accepted Medium.

### Medium (advisory)

**M1. One client can use up an app's 120/min create budget on an instance.**
Location: architecture.md 3 step 3; Q-1.
Scenario: 20 reconnecting sockets that each create 6 groups a minute (2
creates/s in total) use up the per-app budget. Legitimate leaders on that
instance get `RATE_LIMITED` for as long as the script runs. This is the same
property the join budgets accepted in #10 (no per-IP limits, Q5.3). It ends as
soon as the attack stops, unlike H1.
Fix: in the README residuals, say that a single client can use up an app's
create budget, and that per-IP limits at the reverse proxy are the operator's
mitigation. No code change.

**M2. Every return path after a reservation must release it, including the cheap, client-triggerable ones.**
Location: architecture.md 3 steps 4-5, 7 AC3 row; `join-service.ts` `initialCodes()` line ~1001.
Scenario: `JOIN_METHOD_NOT_ALLOWED` comes from `initialCodes`, after the
reservation, and any client can trigger it with a disallowed `joinMethods`.
If one failure path is missed (an error return, a throw from `issueCodeSet` or
Redis, a refused commit), every such create leaks a slot until its score:
createdAt + max session (3-8 h), not the 20 minutes the plan assumes. Together
with the 120/min budget, that fills the cap with no keep-alive at all. The
plan's test row only covers `CODES_EXHAUSTED`.
Fix: see R4. Resolve the method set before the reservation (it is a pure
check). Release in one `try`/`finally`-style guard ("stored or released"), and
cover `JOIN_METHOD_NOT_ALLOWED`, `CODES_EXHAUSTED`, a thrown `store.create` and
an abandoned Redis commit.

**M3. With N instances, N x 120 creates/min can reach the global cap (accepted residual).**
Location: architecture.md 8, 6 README.
This is H1's mechanism without the keep-alive. Option 1 of H1 removes it. If
H1 is fixed another way, this stays an accepted, documented residual, and the
README must give the corrected numbers (cap reached in about 10 000 / (N x 120)
minutes with keep-alive).

### Low (advisory)

**L1. `endInvalid` deletes a group without releasing its live-group slot.**
Location: `storage/redis/ended.ts` `endInvalid` (called by `sweeper.ts` for an
invalid stored group); architecture.md 3.1 ("groups that leave Redis without an
`endGroup` ... pruned by score").
The slot leaks until its score (up to 8 h). It is rare and not attacker-driven,
but it is free to fix: add the `ZREM` of `appLive(namespace)` to the
`endInvalid` writes (R6).

**L2. Guard the limit values. Cap `-1` means "no cap".**
Location: architecture.md 3.1 (`register` passes cap `-1`), 4 `server.ts` `groupLimits`.
`main.ts` builds `SyncServerOptions` from explicit fields only (checked), so
`groupLimits` cannot come from clients, env or the apps file today. But a
non-integer, `NaN`, `0` or negative value would make
`ZCARD >= cap` (or the in-memory equivalent) never or always true. A `-1` that
reached `reserve` would turn the cap off. Fix: R7.

**L3. Q-4 recreations at the cap are bounded and are not a bypass.**
A recreation needs a leader token that is valid, not ended, issued before the
current epoch (`issuedInEpoch` false), and still inside its `lat` window. The
supply is the groups that were live, or ended within
`inactivity + refreshMax` (memory mode loses the ended set on restart), before
the epoch changed. That is at most about the cap plus one window of the create
budget, once per restart. The attacker cannot trigger it, and the groups age
out by max session. Accept option 1, with R8.

**L4. An app's `maxConnections` can be as large as the cap.**
`MAX_APP_CONNECTIONS_CEILING` defaults to 10 000, the same as
`MAX_LIVE_GROUPS_PER_APP`. An app configured at the ceiling (or several
instances with Redis) can reach the cap with connected leaders alone, whether
legitimate or a socket-holding attacker. Fix: say in the README that the cap is
global and connections are per instance. Optionally warn at startup when
`maxConnections x expected instances` is near the cap.

**L5. The per-app `retryAfterMs` shows when other users' creates happened.**
The per-app `RATE_LIMITED` details give the age of the oldest create in the
window, which is an aggregate timing signal about other users of the app. It
reveals no group, code or identity, and the join budgets already do the same.
No action needed.

## 4. Required controls (part of the plan)

| # | Control | Chunk |
| --- | --- | --- |
| R1 | **H1:** one of the fixes in H1 is in the revised plan, with corrected Q-1 numbers. If it is option 1 or 2, a test asserts `budget-over-maxSession < cap` for the default and the ceiling `maxSessionMinutes`. If it is option 3, the user's explicit acceptance is recorded in `STATE.md` | 3-5 |
| R2 | Order in `create`: `busy` -> size -> name -> per-connection rate -> per-app rate (global if H1 option 1) -> under the lock: method resolution -> `reserve` -> codes. **Zero code draws and zero stored state** on every refusal (the test plan's counting `codeRandom` and an unchanged code index and `liveGroups` for each path) | 3, 4 |
| R3 | Refusals: `RATE_LIMITED` with `retryAfterMs` only; `APP_GROUP_LIMIT` with `maxLiveGroups` only (the configured constant, never the current count, other apps' state, a group ID or ref); fixed message texts from `error-messages.ts`; the connection stays open | 1, 3, 4 |
| R4 | **M2:** "stored or released" guard. After a `true` reserve, every path that does not store the group releases the slot (error returns and throws), and a Redis reserve registers `onAbandon(ZREM)`. Tests for `JOIN_METHOD_NOT_ALLOWED` (or proof that it is checked before the reserve), `CODES_EXHAUSTED`, a throwing `store.create`, and an abandoned Redis commit: the count is unchanged afterwards | 2, 4 |
| R5 | Lua `RESERVE_LIVE`: a constant string; the key only from `KEYS[1]` (built by `RedisKeys.appLive`, namespace checked against `NAMESPACE_PATTERN`); the member checked against `GROUP_ID_PATTERN` before the call; numbers read with `tonumber` and rejected (`redis.error_reply`) if `nil`. Prune, then idempotent `ZSCORE` update, then cap, then `ZADD`, then extend the TTL in one script. The TTL is only ever extended and handles a key without expiry (`PEXPIRETIME` -1/-2). `appLive` is covered in `keys.test.ts` for a bad namespace | 2 |
| R6 | **L1:** `endInvalid` also removes the group from `appLive(namespace)` in its writes; `endGroup` releases in the same commit as `store.delete` (the plan's `plan.zrem` step); not in `forgetGroup` (cluster `forget`) | 2, 4 |
| R7 | **L2:** `reserve` takes a cap that must be a safe integer >= 1 (else it throws). `register` uses a separate mode flag or a separate script branch, never a cap value that `reserve` could receive. `createSyncServer` validates `groupLimits` values as positive safe integers. `groupLimits` is not read from env, the apps file or any client input, and `main.ts` does not pass it | 2, 3 |
| R8 | **L3/Q-4:** `register` only after `createIfAbsent` returned `created`, with `expiresAt = groupExpiry(namespace, claims.gct)`; undone by `onAbandon` if the recreation's commit fails; the per-connection recreation limiter stays in front. Test: a recreation at the cap succeeds, is counted, and the next create is refused | 4 |
| R9 | Logging: `group_create_app_budget_exhausted` and `app_group_limit_reached` at `warn`, throttled once per app per window, with `namespace` only. No code, group ID, `groupRef`, connection ID or count of another app. No log for per-connection refusals. `LogCapture` test over every refusal path | 3, 4 |
| R10 | Limiter state: the per-connection key is forgotten in `disconnect()`; both limiters (and the warning throttle) are cleared on shutdown; per-app keys are bounded by configured namespaces | 3 |
| R11 | README: the corrected residuals (H1/M3 per the chosen option, M1 per-IP limits at the proxy, L4), the error code, and the Upgrading note. No new dependency (`package.json` unchanged) | 5 |

## 5. What I will check in code mode

- The create path in `group-service.ts`: order of checks, no `await` that draws
  codes before the rates and the reserve, the stored-or-released guard on every
  branch, `release` in `endGroup` in the delete's commit, `register` only on
  `created` in `recreate`.
- `scripts.ts` `RESERVE_LIVE` and `storage/redis/live-groups.ts`: KEYS/ARGV
  only, `tonumber` guards, prune/idempotence/cap order, TTL extension, the
  `onAbandon` undo, `release` inside and outside a unit of work.
- `keys.ts` `appLive` pattern checks; the `endInvalid` `ZREM`.
- `MemoryLiveGroups`: synchronous check-and-add, empty maps deleted, prune.
- `server.ts` / `main.ts`: `groupLimits` validated and not wired from config.
- The H1 fix as chosen (global budget script, or the derived-rate inequality
  test, or the recorded user acceptance).
- Wire: `APP_GROUP_LIMIT` details and text in protocol, server, client and
  reader; the client's `KnownDetails` parsing is tolerant.
- Logs: the `LogCapture` tests and the throttle.
- gitleaks, semgrep on the changed files, `npm audit --audit-level=high`; no
  dependency changes.

## 6. Does the plan close M2 of #10?

- Squatting part (mistyped B codes reaching an attacker, `CODES_EXHAUSTED`):
  **closed** by the cap (at most 1 % fill), whatever happens with H1.
- "Without introducing a worse problem": **not yet**. As planned, the cap that
  closes the squatting opens an app-wide creation DoS from one instance (H1).
  Once R1 is in the plan, M2 is closed.

# Security review (plan): #12 Limit group creation and live groups per app

**Current verdict (round 3, delta check of plan head afd1d71): PASS.** No
critical or high finding. H1 and M3 stay closed for every valid env
configuration. The current required controls are R2.4 as amended by
[Round 3](#round-3-delta-env-config-afd1d71), section R3.5.

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

## 4. Required controls (round 1, superseded by R2.4)

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

## Round 2: revised plan (a379b8d)

Mode: plan, round 2. Reviewed: `architecture.md` at a379b8d ("Revision 1",
Q-1 option A, sections 3, 3.1, 5.2, 7, 8, 9), against round 1 and the code:
`groups/group-service.ts` (`groupExpiry` l. 844-847, recreation
`createdAt: claims.gct` l. 1892), `groups/resume.ts` (l. 54, 91),
`storage/redis/redis-storage.ts` (`expiryOf`),
`storage/redis/scripts.ts` (`COMMIT` and `REDIS_NOW` use Redis `TIME`),
`storage/redis/keys.ts` (existing families), `limits/rate-limiter.ts`,
`config/env.ts` (`MAX_SESSION_MINUTES_CEILING` has no upper `max`),
README "Several instances" requirements (l. 450-456).

**Verdict: PASS.** H1 and M3 are closed. The revision adds one new medium
(M4: the remaining flood DoS is app-wide on every instance and needs only a
few sockets, and the plan understates it) and four lows. None blocks.

### R2.1 H1 and M3: closed

- **Math checked.** `L = maxSessionMinutes + 5 s`,
  `rate = min(120, (5 000 - 120) / L)`. I get 81.2/min at 60, 27.1 at 180, 10.2
  at 480, 0.48 at 10 080. The switch to 120 sits between 40 (121.7) and 41
  (118.8). The table in Q-1 is right. A token bucket of size `b` and rate
  `r` admits at most `b + r x T` in any window `T`. With `T = L` that is
  `<= 5 000`. `min(120, .)` only lowers it.
- **Every live group was charged within the last `L`.** A group's end is
  `createdAt + maxSessionMinutes + slack` (`groupExpiry`, `expiryOf`). A
  recreation keeps `createdAt = claims.gct` (group-service.ts:1892), and
  `resume.ts` refuses tokens whose `gct + maxSession` has passed. So a
  recreated group was charged at its original create, which was inside the
  window. Keep-alive cannot stretch a group past `L`. The number of instances
  does not matter, because the bucket is one Redis hash per app.
- **Across an epoch change** (memory restart, Redis data loss), the bucket
  starts full once more. The bound becomes `2 x burst + r x L` = 5 120. That
  is still about half the cap, so the cap stays a backstop with about 2x
  margin. **The recreation path is not a budget bypass.** It cannot make
  groups that were never charged, it cannot extend `gct`, and it is still
  behind `RECREATIONS_PER_CONNECTION_PER_MINUTE`. L3 stays accepted.
- **Refill semantics.** The refill is a pure function of `(t, a, now)`.
  Refusals write nothing. A charge sets `a = max(a, now)`. A missing key means
  full, and the key expires exactly when the bucket would be full. Cap refusals
  do not charge, and the idempotent re-reserve of a held ID does not charge
  either. Group IDs are server-generated, so a client cannot hit that branch.
  The design is sound. See L7 and L8 for the clock and number formatting.
- **Atomicity.** The budget check, cap check, charge and `ZADD` run in one
  script, and concurrent reserves on two instances serialise in Redis. With
  memory storage every method body is synchronous. Redis is a single endpoint
  (README: no Cluster), so two KEYS in one script are fine.
- **Key families.** `lg` and `lb` collide with none of the existing families
  (`a ap aq c ch due e epoch g ig inst insts live lock p pk q seq t`), and
  both are built through the `NAMESPACE_PATTERN` check.
- **The tests** (inequality for {1, 40, 41, 180, 480, 10 080} and the
  worst-case simulation over `2 x L`) check exactly the property H1 needs.
  R1 is met at plan level.

### R2.2 Round-1 advisories

| Finding | Status |
| --- | --- |
| M1 | Superseded by **M4** (the budget is now global, so the flood residual changed shape) |
| M2 | Addressed: method set resolved before the lock, stored-or-released guard, failure-path tests (R4) |
| M3 | Closed by the global bucket |
| L1 | Addressed: `endInvalid` ZREM (R6) |
| L2 | Addressed: `reserve` validation, `register` as a separate mode, `groupLimits` validated and not wired (R7) |
| L3 | Accepted; re-checked above, not a bypass (R8) |
| L4 | Closed in substance: connected leaders also need a create, so the budget bounds them. README note stays (R11) |
| L5 | No action |

### R2.3 New findings

#### Critical / High
None.

#### Medium (advisory)

**M4. A few sockets keep group creation blocked for the whole app, on every instance, while the script runs. The plan understates this.**
Location: architecture.md Q-1 "What an attacker can still do" (l. 96-101),
section 8 first bullet (l. 482-488), section 6 README residual.
Scenario: the budget is now global, so draining it blocks the app on
**every** instance, not one. Draining it takes only the sustained rate:
about 27 creates/min at the default (10/min at 480), which is 5 (or 2)
connections at 6/min. Reconnecting resets the per-connection limit. A script
that also polls just after each refill takes almost every token. Legitimate
leaders get `RATE_LIMITED` again and again, not "a wait of at most 2.2 s".
Their chance per retry is roughly their share of the attempts. It still ends
when the script stops, there is no lasting state, and other apps are not
affected. That matches the #10 join-budget precedent, so it stays Medium.
Fix:
- Correct the text in Q-1, section 8 and the README. It should say "while a
  flood runs, creation in the app can be refused on every instance for as long
  as it runs; one client with a handful of reconnecting sockets is enough;
  per-IP limits at the reverse proxy are the mitigation". Drop "a wait of at
  most 2.2 s". The orchestrator must show the corrected sentence at Gate 2 (R12).
- Optional (not required): count every `group.create` attempt per connection,
  including attempts refused by the app budget. The plan's order already does
  this, because the per-connection `tryAcquire` runs before `reserve`. A test
  should pin it, so that polling costs fresh connections.

#### Low (advisory)

**L6. Instances that disagree on an app's `maxSessionMinutes` share one bucket at different rates.**
Location: architecture.md 3.1 (ARGV carries the caller's refill rate, the
bucket stores only `{t, a}`); `expiryOf` and `groupExpiry` use the instance's
current app config.
Scenario: the tokens are interchangeable. If instance B runs the app at 60
min (81/min) and instance A at 480 min, an attacker who can steer connections
can let B's calls refill the bucket fast and spend the tokens on A, creating
480-minute groups. That gives about 40 or more long groups a minute, which
breaks the 5 000 bound and can reach the cap (H1 again). The README already
requires the same apps config on every instance (l. 451), so this needs a
misconfiguration, or a rolling config change that lasts for hours. Related:
after a restart that **raises** `maxSessionMinutes`, existing groups live to
the new end, but their scores keep the old end. They are pruned early, so the
cap undercounts for up to one old `L`. That costs some squat margin, not a
denial of service.
Fix (recommended, cheap): pass the group's lifetime (`expiresAt - now`)
instead of a rate, and derive the rate inside the script from the longest
lifetime seen recently. Store `m` (max lifetime in ms) and `mu` (until when)
in the bucket hash. Use `max(m, lifetime)` while `now < mu`, and reset it to
`lifetime` after that. Then every instance refills at the slowest rate any
instance used in the last `L`. The memory store does the same in process.
Also add one README line: a change to `maxSessionMinutes` takes up to one
old max session to settle in the cap count.

**L7. The bucket and the prune use instance clocks, while the rest of the shared Redis state uses Redis `TIME`.**
Location: architecture.md 3.1 (ARGV `now`), section 8 "Clock" (l. 505-508);
scripts.ts `COMMIT` and `REDIS_NOW` ("instance clocks never decide liveness").
Scenario: an instance whose clock runs ahead by `s` gets `s x rate` extra
tokens once and moves `a` into the future. Every other instance then refills
nothing for `s`, and their legitimate creates are refused. Its prune also
drops live entries scored less than `s` ahead, so the cap undercounts. The
effect is bounded by the skew, and NTP is required.
Fix (recommended): take `now` from `REDIS_NOW` inside `RESERVE_LIVE` for the
bucket arithmetic and the prune. Keep the scores (`expiresAt`) on the
instance clock, as the group deadlines are. If the engineer keeps ARGV
`now`, they should say so in "Deviations" and keep the "Clock" bullet.

**L8. Lua number hygiene in `RESERVE_LIVE`.**
Location: architecture.md 3.1 steps 5 and 7, 5.2.
- `PEXPIRE` takes only integers. "Time to full + 1 s" is fractional, so it
  must be `math.ceil`. Otherwise every charge returns an error reply, and every
  create in the app fails with `INTERNAL_ERROR`.
- A Lua number returned to Redis is truncated to an integer. Compute
  `retryAfterMs` with `math.ceil` in Lua, or return the token count as a string.
  Otherwise a `retryAfterMs` of 0.x arrives as 0.
- `MAX_SESSION_MINUTES_CEILING` has no upper `max` (env.ts:88), so an
  operator value can make the rate tiny and `retryAfterMs` or the bucket TTL
  unsafe (> 2^53 ms, or exponent notation when passed to Redis). Clamp both to
  a safe integer, for example `min(value, 1e13)`. Alternatively, validate that
  the TTL and `retryAfterMs` are safe integers in TS before the call. It is
  operator-only, so it stays Low.

**L9. Test the epoch reset in the H1 simulation.**
The simulation runs on one bucket. Add one case that resets the bucket in the
middle of the run (a restart), and assert the live count stays
`<= cap/2 + burst` and no reserve returns `cap`. That pins R2.1's
`2 x burst + r x L` bound.

### R2.4 Required controls (current list for the engineer)

R2, R3, R4, R6, R7, R8, R9 and R10 from round 1 are unchanged. Updated and new
controls:

| # | Control | Chunk |
| --- | --- | --- |
| R1 | **H1 (option A):** global per-app bucket checked in the same atomic step as the cap. The rate comes from `appCreateRefillPerMinute`, and the inequality test covers {1, 40, 41, 180, 480, 10 080}. The worst-case simulation over `2 x L` at 180 and 480, plus the reset case (L9), never exceeds `cap/2 + burst` and never returns `cap`. The `.redis` two-instance test shares one burst | 2, 3, 4 |
| R2 | Order: `busy` -> size -> name -> per-connection rate -> method resolution -> under the lock: `reserve` (budget, then cap, then add) -> codes. Zero code draws and zero stored state on every refusal. A disallowed `joinMethods` makes zero `reserve` calls | 3, 4 |
| R5 | `RESERVE_LIVE` is a constant string. KEYS are only `appLive(ns)` and `appCreateBudget(ns)`. The member is checked against `GROUP_ID_PATTERN` before the call. Every ARGV goes through `tonumber`, with `redis.error_reply` on `nil` or a bad value (cap and burst are integers >= 1, the refill or lifetime is > 0). The mode is exactly `reserve` or `register`, otherwise an error. Steps in order: prune -> held member (no charge) -> `register` -> refill -> rate refusal (no write) -> cap refusal (no charge) -> charge + `ZADD`. TTLs: the set's is only ever extended (`PEXPIRETIME` -1/-2 handled). The bucket's is an integer (`math.ceil`), and the returned `retryAfterMs` is an integer computed with `ceil` in Lua (L8). `keys.test.ts` covers both new keys with a bad namespace | 2 |
| R11 | README: the residuals corrected per M4 (app-wide, every instance, as long as the flood runs, a handful of sockets, per-IP limits at the proxy). Also L4 (the cap and budget are global, connections per instance), the Q-1 rate table, `APP_GROUP_LIMIT`, Upgrading, and the L6 note on changing `maxSessionMinutes`. No new dependency | 5 |
| R12 | **Gate 2 text (M4):** Q-1 and section 8 no longer say "a wait of at most 2.2 s". The user is shown that one client can block creation in an app on all instances while it runs | orchestrator / 5 |
| R13 | Recommended (L6, L7): the rate is derived in the script from the longest recent lifetime (`m`/`mu`), and `now` comes from Redis `TIME` for the bucket and the prune. If either is skipped, record why under "Deviations from plan" | 2 |
| R14 | Recommended (L8): bucket TTL and `retryAfterMs` clamped to safe integers, with a unit test at a very large `maxSessionMinutes` | 2, 3 |

### R2.5 Additions to what I will check in code mode

- `RESERVE_LIVE` line by line: step order, no write on a refusal, `math.ceil`
  on every TTL and returned number, mode whitelist, two KEYS only.
- The bucket arithmetic is shared by memory and Redis, and both give the
  same `retryAfterMs` (contract test).
- Recreation passes `claims.gct` to `groupExpiry` for `register`, never
  `now`.
- Whether R13 and R14 were done or recorded as deviations.
- The M4 wording in the README.

### R2.6 Does the plan now close M2 of #10?

Yes. Creates can hold at most about 5 000 groups (0.5 % of the code space).
The cap cannot be filled by creates. The remaining flood DoS (M4) lasts only
while the attack runs, and it is documented with the operator mitigation.

## Round 3 (delta: env config, afd1d71)

Mode: plan, round 3, scoped to "Revision 2" of `architecture.md` (Q-2
decided as env variables, Q-2.1/Q-2.2, the `GroupCreateLimits` and
`appCreateRefillPerMinute` code in section 3, R13/R14 in 3.1, the new test
rows in section 7, chunk 2). Checked against `config/env.ts` (`NUMERIC_VARS`,
`crossFieldProblems` l. 200-256; messages print only validated integers),
`config/known-vars.ts` (`MAX_` family l. 45, typo suggestion within 2 edits)
and the README's Redis `noeviction` requirement (l. 369).

**Verdict: PASS.** No critical or high finding. Three new lows (L10-L12),
all about operator configuration and none triggerable by a client.

### R3.1 Does the H1 bound hold for every valid config?

Yes. With `rate = min(maxRate, (cap/2 - burst) / L)`, a token bucket admits
at most `burst + rate x L <= burst + (cap/2 - burst) = cap/2` creates in any
window of length `L`. `min(maxRate, .)` only lowers that. The admitted count
is an integer, so it is `<= floor(cap/2)`. The cross rule `cap > 2 x burst`
(both integers) gives `cap/2 - burst >= 0.5`, so the rate is `> 0` and
finite for every finite `L`. I checked the range ends:

| Config | Bound in any window `L` | Notes |
| --- | --- | --- |
| cap 3, burst 1 (smallest) | `<= 1.5`, so 1 live group from creates | Valid but nearly unusable. It is documented, and it is not a security problem |
| cap 100 000, burst 49 999 | `<= 50 000` | The rate is about `1 / L`; the burst is almost the whole budget |
| cap 100 000, burst 1, maxRate 60 000 | `<= 50 000` | The derived term binds for every `L` above about 0.83 min |
| maxRate 1, defaults otherwise | `<= 120 + L` | Stricter only |
| per connection 600 | n/a | Does not touch the app bound. Sliding-window memory is at most `600 x connections` timestamps per instance: operator-chosen and bounded. No finding |

The per-variable ranges, the cross rule (checked only when both values are
valid on their own) and messages that print integers, never raw values,
follow the existing `env.ts` pattern. The `MAX_` names are covered by the
ADR 0015 typo check, so a mistyped name fails at startup instead of silently
keeping the default. That is the right call, and it is a security
improvement over the `GROUP_` names.

### R3.2 Is a cap of 100 000 acceptable against M2 squatting?

Yes, as an operator opt-in. Creates hold at most `cap/2 = 50 000` groups,
which is 5 % of the 10^6 group codes. Recreations after an epoch change can
push that to the cap (10 %) for at most one max session. That is not
attacker-triggerable (L3). `CODES_EXHAUSTED` needs 20 hits in a row
(`0.1^20`), so it stays impossible in practice. A mistyped method B code
reaches a squatter with probability of at most about 5 %. That is below the
11.5 % rejected in round 1, and it only applies to an operator who raises the
default (0.5 %) tenfold for capacity. Condition: the README states the
trade-off with `cap / 2 / 10^6` and both end values (R11 below; already
planned in architecture.md section 6).

### R3.3 R13 adoption, Redis TIME, R14, `groupLimits`

**Mismatched `maxSessionMinutes`, burst or rate bound (same cap): sound.**
While `now < u` the bucket uses `r = min` and `b = min` of every *charged*
reserve. I checked the mixed case, where the minimal `r` comes from one
instance and the minimal `b` from another. Let `j` be the instance with the
longest lifetime `L_max`. Then
`b_eff + r_eff x L_max <= b_j + r_j x L_max = cap/2`. Refused reserves write
nothing, so a starved strict instance records nothing. But it also creates
no groups, so the bound only depends on the instances that did create.
Clamping tokens to the new smaller `b` at the next refill closes the
"leftover larger burst" path.

**Transition bound (the architect's question): confirmed below the cap.**
Let `t` be the moment the first slow, long-lived create lands while fast
groups (lifetime `L_s`, rate `r_s`) are live. Creates in
`[t - L_s, t + L_s]` are at most
`tokens(t - L_s) + r_s x L_s + r_l x L_s <= cap/2 + r_l x L_s`. Since
`r_l x L_s < r_l x L_l <= cap/2 - b`, the live count is `< cap - b`. It
falls back to `<= cap/2` within `L_s`. The architect's looser sum
(`cap/2 + b + r_l x L_s`) is also below the cap whenever `L_s < L_l`. Creates
never reach the cap during a transition. The reverse direction is safe too:
when `u` passes, every group charged under the strict values has passed its
`expiresAt <= u`. Only the skew is left over (L7).

**Redis TIME (L7): closed.** The refill, the charge, the `u` comparison and
the prune use `REDIS_NOW`. The scores and `u` (taken from `expiresAt`) stay
on the instance clock. Comparing them with Redis time is off by at most the
instance skew, which the NTP requirement already bounds.

**R14 (L8): adopted.** `retryAfterMs` and both TTLs are computed with `ceil`
and clamped to `1e13`. The bucket TTL covers `u - now`, so `r` and `b` are
not forgotten before `u`. One formatting detail remains (L12).

**`groupLimits`: still test-only.** Every value is validated, the cross rule
is checked after the overrides, it is not read from env, the apps file or
any client, and `main.ts` does not pass it. `appRefillPerMinute` replaces the
derived rate, so it is not held to the H1 inequality. That is acceptable only
because it is test-only, which R7 already requires. Spawned test servers drop
the parent's `MAX_*` names (`child-env.ts`).

### R3.4 New findings

#### Critical / High
None.

#### Low (advisory)

**L10. A cap mismatch between instances is not covered by R13.**
Location: architecture.md Q-2.2 last paragraph, 3.1 (`r`, `b`, `u`), section 8
"Instances with different values".
Scenario: each instance derives its rate from its *own* cap. The bucket keeps
the smallest `r`, but that `r` can come from a large-cap, short-`L` instance
while another instance creates long-lived groups. Example: X has cap 10 000
and 60 min (81/min), Y has cap 100 000 and 480 min (104/min). The bucket runs
at 81/min, so Y's 480-minute groups add up to about 39 000 live groups. X then
refuses every create with `APP_GROUP_LIMIT` for hours, and its refusals write
nothing, so it never tightens the bucket. This needs the misconfiguration the
README forbids, or a long rolling change of the cap. Measured against Y's own
cap, the bound still holds. Low.
Fix (recommended): also keep the smallest recent cap `c` and the longest
recent lifetime `m` (`expiresAt - now`) in the bucket hash under the same `u`
rule. Use `r_eff = min(r, (c/2 - b) / m)` in the script (and in memory). If
this is skipped, the README "Several instances" notes must say that one
instance with a lower cap can refuse every create while the others run, and
the skip goes under "Deviations from plan".

**L11. A large burst erodes the margin after a bucket reset.**
Location: architecture.md Q-2.1 (the burst is bounded only by the cross
rule), section 7 "R1 (H1) simulation" reset case.
Scenario: each time the bucket starts over within `L` (memory restart, Redis
data loss, a manual key delete), up to `burst` more creates are admitted.
After `k` resets the bound is `cap/2 + k x burst`. At the defaults that is
negligible. With a burst near `cap/2` (for example 49 999 of 100 000), one
reset brings the count just under the cap and two reach it. Restarts are not
attacker-triggerable, and `noeviction` is required (README l. 369), so
eviction cannot reset the bucket. Low.
Fix: also run the simulation's reset case at cap 100 000 / burst 49 999,
asserting `<= cap/2 + burst` (`< cap`) and no `cap` return. Add one README
line: keep the burst well below half the cap (for example `<= cap/4`).

**L12. A tiny rate must not round to 0 on its way to Redis.**
Location: architecture.md 3.1 "Numbers are passed as integer or fixed-point
strings, never exponent notation".
Scenario: `MAX_SESSION_MINUTES_CEILING` has no upper bound, so at cap 3 /
burst 1 the rate can be `5e-8` per minute or smaller. A fixed-point string
with too few decimals (for example `toFixed(6)`) gives `"0.000000"`. The
script's `refill > 0` check then returns `redis.error_reply`, and **every**
create in the app fails with `INTERNAL_ERROR`. Operator-only, Low.
Fix: format the refill so the parsed value stays `> 0`, for example
`toPrecision(17)`. Lua `tonumber` accepts exponent notation for this float;
the L8 concern is only about integer arguments such as `PEXPIRE`. Or use
`toFixed(20)` with an assertion that the parsed value is `> 0`. Extend the
L8/R14 test from `maxSessionMinutes` 10^7 to 10^12 and assert that the
reserve succeeds.

### R3.5 Required controls: changes to R2.4

R2.4 stays in force, with these changes:

| # | Control | Chunk |
| --- | --- | --- |
| R1 | As before, plus: the inequality and simulation tests run at the configured extremes of architecture.md section 7 (smallest valid; cap 100 000 with burst 49 999; cap 100 000 with burst 1 / maxRate 60 000; maxRate 1). The reset case also runs at cap 100 000 / burst 49 999 (L11). `appCreateRefillPerMinute` throws at `cap = 2 x burst` | 2, 4 |
| R11 | As before, plus: the README env rows (defaults, ranges, the cross rule, "same value on every instance"); squat odds `cap / 2 / 10^6` (0.5 % default, 5 % at 100 000, up to twice that through recreations); the L11 burst guidance; the L10 cap-mismatch note if L10 is not implemented | 2, 6 |
| R13 | **Done in plan** (min `r`/`b` until `u`; Redis `TIME`). Recommended addition (L10): the smallest recent cap and longest recent lifetime in the bucket, or the README note plus a Deviations entry | 3 |
| R14 | **Done in plan**, plus (L12): the refill argument stays `> 0` after parsing for every valid config; test at `maxSessionMinutes` 10^12 | 3, 4 |
| R15 | **New (config):** the four names are in `KNOWN_SERVER_VARIABLES` (`MAX_` family) with the Q-2.1 ranges. The cross rule is checked only when both values are valid. Messages print validated integers only, never raw values. A typo of a new name fails at startup with the suggestion. `groupLimits` overrides pass the same cross rule and are never wired in `main.ts` | 2, 4 |

### R3.6 Additions to what I will check in code mode

- `env.ts`: the four `NUMERIC_VARS` entries, the ranges, the cross-rule text
  and the skip when a value is invalid. No raw value in any message.
- `server.ts`: `GroupCreateLimits` built once from `ServerEnv` and frozen;
  the `groupLimits` overrides validated after merging.
- `RESERVE_LIVE`: the effective `r`/`b`/`u` computed before the refill,
  tokens clamped to `b`, nothing written on a refusal.
- How the refill rate is formatted into ARGV (L12).
- Whether L10 was implemented, or noted in the README and under Deviations.

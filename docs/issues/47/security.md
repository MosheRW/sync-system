# Security review (plan): #47 bound create-budget key TTL and batch expired live-group cleanup

Mode: plan. Reviewed: [architecture.md](architecture.md) against
[spec.md](spec.md), `apps/sync-server/src/storage/redis/scripts.ts`
(`RESERVE_LIVE`, `CLAIM_DUE`), `src/groups/live-groups.ts`,
`src/storage/redis/timers.ts`, `src/groups/group-service.ts` (reserve and
register call sites), `test/redis-privacy.redis.test.ts` (AC24) and the #12
security review (H1 closure, R2.1).

**Verdict: PASS.** No critical or high finding. The TTL cap keeps the #12 H1
bound, the 1 ms past the AC's literal bound is acceptable, and the batched
`CLAIM_DUE` terminates and leaves no expired member behind for longer than a
poll. Three low advisories, none blocking. The required controls below are
part of the plan.

## Assets and trust boundaries

| Asset | Why it matters |
| --- | --- |
| Per-app create budget `lb:<ns>` (t, a, r, b, u) | #12 H1 abuse control: creates live at once stay `<= cap / 2`, so one client cannot fill the app's live-group cap (app-wide create DoS, code-space squatting) |
| Live-group sets `live`, `lg:<ns>` (group IDs with end bounds) | Stored group IDs: #35 AC24 retention. `lg:<ns>` is also the cap's count |
| Redis availability | One long script blocks every instance and every app (A2) |

Trust boundary: clients reach this code only through `group.create` (and
recreation through `register`). They control neither the group ID
(server-generated), the end bound (`groupExpiry(createdAt)`), nor any script
argument. The scripts' inputs come from server config and server clocks.

## Threats (STRIDE, brief)

- **DoS (create budget):** a client floods `group.create` to make live
  creates exceed `cap / 2`. The change alters when the budget is forgotten,
  which is exactly when a fresh burst becomes available. Checked in 1.
- **DoS (Redis):** a large expired backlog in `live` makes one script call
  walk it all (A2), or the new re-run loop never stops. Checked in 3.
- **Information disclosure / retention:** `lb:<ns>` or expired group IDs in
  `live` / `lg:<ns>` outlive the group's end bound (AC24). Checked in 2 and 3.
- Spoofing, tampering, repudiation, elevation: no new input, route, auth or
  message. Not applicable.

## Analysis

### 1. `lb:<ns>` at `PEXPIREAT ceil(u) + 1` keeps the H1 bound

- **`u` bounds every charged group of the key's lifetime.** A charge sets
  `u = max(u, score)` while `now < u`, else `u = score` (the new group, which
  ends after every older one, all of which end `<= old u <= now`). Refusals
  write nothing. So the stored `u` is `>=` the end bound of every group the
  current key charged.
- **End bounds do not move past `u`.** `groupExpiry(namespace, createdAt)` is
  `createdAt + L`; `register` (recreation) uses the original `gct`, so it
  writes the same end bound; the `held` branch raises a score only if the
  caller passes a later end, which needs an operator change of
  `maxSessionMinutes` between create and recreation (see note N1).
- **The reset is equivalent to a token bucket that starts full at time X**
  (the expiry). At any `X > u` every group the old key charged has an end
  bound `< X`, so `RESERVE_LIVE` prunes it (`ZREMRANGEBYSCORE -inf (now`)
  before the cap count, and the memory store's prune (`expiresAt < now`) does
  the same. Live groups at any later `T` were then all charged in `[X, T]`
  within the last `L`, so there are at most `burst + rate x L <= cap / 2`.
  The bound does not depend on the rate being the derived one; any
  `rate <= derived` keeps it.
- **The 1 ms boundary is right.** The prune is strict (`< now`), so at
  `now == u` the group whose end is `u` is still counted. If the key were gone
  at that millisecond, a full burst would be admitted next to it (reachable in
  the tightest-headroom config, as the plan says). With target `ceil(u) + 1`
  the key is present at every `now <= ceil(u)` under either expiry comparison
  (Redis treats a key as expired when `now > when`, so it actually stays one
  ms longer, which is harmless: at `now > u` everything charged is pruned and
  the kept bucket is only stricter than a fresh one). At `now == u` the script
  takes the `now >= u` branch: the strict values lapse but `tokens =
  min(burst, t + (now - a) x refill)` still bounds the second burst to
  `rate x L`. Correct.
- **`PEXPIREAT` vs `PEXPIRE`: the argument holds.** Inside a script, Redis
  turns a relative TTL into an absolute time from the script's start time
  snapshot (and checks key expiry against that snapshot), while `TIME` reads
  the clock when called, so `TIME >= snapshot`. A relative `PEXPIRE (ceil(u) +
  1 - now)` can therefore land at `ceil(u)` or earlier, the exact millisecond
  the bound needs. `PEXPIREAT` with a target from the same `TIME` that
  produced `u` and the scores has no such gap, is replicated as is, and
  matches `extend_set`. Same clock domain throughout (L7).
- **Clamp.** `min(ceil(u) + 1, now + MAXT)` can end the key 1 ms before `u`
  only when `u >= now + 1e13 - 1` (about 317 years of group life). No valid
  `maxSessionMinutes` reaches it. No issue.
- **Rolling upgrade.** Old instances write `PEXPIRE max(time to full, u -
  now)`, new ones `PEXPIREAT ceil(u) + 1`; the last charge wins. Both are
  `>= u`, so H1 holds in a mixed fleet.

### 2. Retention of `lb:<ns>` (1 ms past the AC's literal bound)

Acceptable. The key holds no group ID, no user content, no code: five
numbers per app, of which `u` is the end time of the app's latest group
(app-level activity metadata already implied by `lg:<ns>`'s own expiry). One
millisecond past `E` has no privacy impact, and it is what keeps H1 sound.
This is a large improvement over today (up to the 1e13 ms clamp). The
deviation must be written down, not hidden (control C8, advisory L3).

### 3. Memory-store parity and `tidy`

- `ttlMs = max(1, min(ceil(u - now) + 1, MAX_RETRY_AFTER_MS))` and
  `bucketUntil = now + ttlMs` give `ceil(u) + 1` for the integer
  `Date.now()` clock; `reserveNow` keeps the bucket while `now <
  bucketUntil`, i.e. through `now == ceil(u)`. Same instant as Redis (Redis
  keeps one ms more, see 1). Parity holds.
- `tidy` treating a bucket past `bucketUntil` as idle is right: it is the same
  predicate `reserveNow` already uses to treat the bucket as missing, so
  dropping the entry loses nothing the next reserve would have read. It also
  tightens the memory bound (entries go at most `L + 1 ms` after an app's last
  charge, not after a time to full that could be very long).

### 4. `CLAIM_DUE` batching and the `freed` re-run

- **Bounded work per call.** `ZRANGEBYSCORE live -inf (now LIMIT 0 64` is
  `O(log n + 64)`; per member two `ZREM`s. Plus the existing 64-timer loop.
  Each call is short; Redis serves other clients between calls. This closes
  A2.
- **Termination / no livelock.** Every member the read returns is removed
  from `live` in the same call, so each full batch strictly shrinks the set
  of members with score `< now`. The loop re-runs only while a batch was
  full, so it ends after `ceil(backlog / 64) + 1` calls at most, plus what
  expires meanwhile (bounded by the global create rate; the drain is roughly
  64 per round trip, orders of magnitude above it). The one way to livelock
  is a member that is read but not removed (for example a malformed member
  without `:` skipped by a conditional `ZREM`): the head of the range would
  then return the same 64 members forever with `freed = 64`, a tight loop
  against Redis. The plan removes every member from `live` unconditionally;
  this is required (C4) and tested (C6).
- **Yielding.** Every iteration awaits a Redis round trip, so the Node event
  loop serves sockets and timers in between; the existing exits (stopped,
  link not connected, script error) are checked every iteration. A
  concurrent `poll()` only sets `again`; it does not start a second loop.
- **No starvation.** Due timers are claimed in the same call as the cleanup,
  so a cleanup backlog does not delay them; it makes them run sooner (more
  iterations).
- **Retention.** No expired member stays in `live` / `lg:<ns>` beyond the
  drain of the current poll (milliseconds); if a poll stops on an error or
  disconnect, the rest goes on the next poll (`TIMER_POLL_MS`, 1 s), and
  `lg:<ns>` is still pruned by score on every reserve and expires with its
  latest member. Today's behaviour is the same with an unbounded call; the
  batching does not add retention.
- `runDue()` at startup now drains the whole backlog in many short calls
  before it resolves. That is the intended trade (seconds for 10^6 members,
  with Redis responsive), not a risk.

## Findings

### Critical / High

None.

### Medium

None.

### Low (advisory)

| # | Severity | Location | Issue | Fix |
| --- | --- | --- | --- | --- |
| L1 | Low | architecture.md "AC1" bullets 3-4, Docs impact; `docs/operator-guide.md` budget paragraph | The plan says the TTL changes only when `burst > cap / 4`. It also changes whenever time to full exceeds `L`, i.e. `burst > rate x L`, which includes an operator-lowered `MAX_GROUP_CREATES_PER_APP_PER_MINUTE` (min 1; e.g. burst 120, 1/min, `maxSessionMinutes` 60 gives 120 min to full). After an app has been idle for `L` its full burst is back, so over many idle cycles the app can create up to `burst` per `L` instead of the configured per-minute rate. H1 is unaffected (still `<= cap / 2` live). | State the condition as `burst > rate x L` (both causes) in the plan, the code comments and the operator guide, so an operator who lowers the per-minute setting as a throttle knows it limits creates while an app is busy, not across idle periods. Add one unit case with the rate capped below the derived one (e.g. `createRefillPerMinute` small) asserting `ttlMs <= u - now + 1` and the H1 peak `<= cap / 2` |
| L2 | Low | `timers.ts` `claimDue` (plan row) | The new leading `freed` element is parsed with `Number(items[0])`. An unexpected reply (e.g. a script text mismatch during a botched deploy) would shift every pair by one: each claimed timer is logged as invalid and not fired until its lease ends, and a non-numeric `freed` silently stops the backlog re-run. Unlikely (each instance runs its own script text), but cheap to guard. | Check the reply shape: `freed` must be a finite non-negative integer and `items.length` odd; otherwise log once (no members) and treat as `{ claimed: 0, freed: 0 }` without touching `due` |
| L3 | Low | `redis-privacy.redis.test.ts` AC24 loop, #35 AC24 wording | `lb:<ns>` is the one key bounded at `E + 1 ms`. The existing test passes only because at least 1 ms has elapsed between the create and the `PTTL` read. | Note the `+1 ms` for `lb:<ns>` in the AC24 test comment and in the operator guide sentence; in the new Redis test compare `pExpireTime(lb)` with `ceil(u) + 1` (as planned) rather than a `PTTL` that depends on elapsed time |

**N1 (note, no action).** If an operator raises `maxSessionMinutes` between a
group's create and its recreation, `register` raises the group's score past
the bucket's `u`, so that group can outlive the bucket. This is pre-existing
(the old TTL was `u - now` at the defaults too), operator-triggered,
transient (one `L`) and still under the cap backstop, like the epoch reset
the #12 review accepted (`2 x burst + rate x L`).

## Required controls (part of the plan)

| # | Control | Chunk |
| --- | --- | --- |
| C1 | `RESERVE_LIVE` sets the bucket expiry only on the charge path, after the `HSET`, with `PEXPIREAT bucket int(max(min(ceil(u) + 1, now + MAXT), now + 1))`, where `now` and `u` are the script's Redis-`TIME` values. No relative `PEXPIRE` on the bucket anywhere; refusal paths still write nothing | 1 |
| C2 | Memory store: `ttlMs = max(1, min(ceil(u - now) + 1, MAX_RETRY_AFTER_MS))`; `reserveNow` keeps the strict `now < bucketUntil`; `tidy` uses that same predicate (`now < app.bucketUntil ? app.bucket : undefined`) and nothing looser | 1 |
| C3 | Boundary tests as planned: at exactly `u` the bucket is kept and admits only `rate x L` (memory), the tightest-headroom flood case (`cap 100 000`, `burst 49 999`, 180 min) never exceeds `cap / 2` and never returns `cap`, and the Redis test asserts `pExpireTime(lb) === ceil(u) + 1` | 2 |
| C4 | `CLAIM_DUE`: the expired read is `ZRANGEBYSCORE live -inf (now LIMIT 0 <ARGV[4]>`; **every** member read is `ZREM`ed from `live` unconditionally (with or without `:`), and from `lg:<ns>` when it has `:`; no unbounded `ZRANGEBYSCORE` / `ZREMRANGEBYSCORE` over `live` remains; `freed` is the number of members read | 3 |
| C5 | `timers.ts`: `CLAIM_BATCH` is the single constant passed as `ARGV[4]` and compared with both `claimed` and `freed`; `claimed` counts pairs from index 1 only; the existing per-iteration exits (stopped, not connected, error) stay; no member or group ID is logged on the new path (a count is fine) | 3 |
| C6 | Tests: the script-level batch test includes the member without `:` (removed from `live`) and a not-expired member (kept in both sets); the poller test drains `2 x 64 + 1` in one `runDue()`; add one case with exactly 64 expired members showing `runDue()` resolves (one extra call with `freed = 0`) | 4 |
| C7 | No new dependency; `package.json` and the lockfile unchanged | all |
| C8 | Operator guide (and the AC24 test comment) state that `lb:<ns>` ends 1 ms after the app's latest group's end bound, and when the budget refills after idle (with L1's corrected condition) | 5 |

## What I will check in code mode

- C1-C8 against the diff, line by line in both Lua scripts.
- The `RESERVE_LIVE` arithmetic: `ceil` of the stored `u` (a `%.17g`
  float), `int()` formatting of the target, the clamp order.
- `bucketStep` and `tidy` parity with the script, including `now == u`,
  `u <= now` and the 1e13 clamp.
- `CLAIM_DUE` reply shape and its single caller; that a malformed or
  non-prefixed member cannot stall the loop; the `again` logic and every
  loop exit.
- Tests for the boundary, flood, batch, malformed-member and backlog cases,
  and that the #12 / #35 suites (including `redis-privacy` AC24) are
  unchanged and green.
- gitleaks over the PR commits, semgrep on the changed files, `npm audit`
  (high/critical), if installed.

# Architecture: #12 fix(server): limit group creation and live groups per app

Spec: [spec.md](spec.md). Source: advisory M2 in
[`docs/issues/10/security.md`](../10/security.md). Path: fast.
Security plan review: [security.md](security.md) (round 1: FAIL, H1;
round 2: PASS, controls R1-R14 in R2.4).

## Revision 2 (Gate 2 amendment, 2026-11-22)

The user decided Q-1 to Q-5 at Gate 2 (section 2). Plan approved, on
condition of this amendment and a passing security delta check. What changed:

- **Q-2: environment variables with the constants as defaults** (the user's
  choice, over the "fixed constants" recommendation). All four limits are
  env-configurable; the sustained rate stays derived from the configured
  cap and burst and the app's `maxSessionMinutes`, so the H1 bound
  (creates hold `<= cap/2`) holds for any valid values (sections 2, 3).
- **Names in the `MAX_` family** (ADR 0015): `GROUP_` is not a server
  family, so a typo such as `GROUP_CREATE_BURST_PERAPP` would be ignored
  silently and the default used. The variables are therefore
  `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE`,
  `MAX_GROUP_CREATE_BURST_PER_APP`, `MAX_GROUP_CREATES_PER_APP_PER_MINUTE`
  and `MAX_LIVE_GROUPS_PER_APP`. No ADR change (Q-2.1).
- **Startup validation** (Q-2.2): ranges per variable, and one cross rule
  `MAX_LIVE_GROUPS_PER_APP > 2 * MAX_GROUP_CREATE_BURST_PER_APP`, which keeps
  the derived rate `> 0`. Invalid values fail fast with documented
  `Config error` lines (`docs/startup-errors.md`).
- **L6 with env values (R13 adopted):** the Redis bucket keeps the *slowest*
  refill rate and the *smallest* burst any instance used while groups
  created under them can still be live, so instances that disagree on
  `maxSessionMinutes` or on these variables cannot refill faster than the
  strictest of them (3.1). `now` for the bucket and the prune comes from
  Redis `TIME` (L7). R14 (integer clamps) is in the plan too.
- **M4 wording (R12):** Q-1 and section 8 no longer say "a wait of at most
  2.2 s".
- **New chunk 2** `feat(config): add group creation limit variables`;
  later chunks renumbered (section 11). Tests for env parsing, the cross
  rule and the H1 inequality at configured extremes (section 7).
- The `groupLimits` option stays test-only and overrides the env values.

## Revision 1 (after security plan review round 1)

What changed, and why:

- **H1 fixed (Q-1, sections 3, 3.1, 8).** Round 0 said one instance's
  120/min create budget could not fill the 10 000 cap, because an abandoned
  group lives about `inactivityLimitMinutes`. That was wrong: a leader return
  (`group.resume`, not rate limited) plus one leader action resets inactivity,
  so a script that keeps its leader tokens holds every group until
  `maxSessionMinutes` (180 default, 480 at the default ceiling). At 120/min
  one instance fills the cap in about 84 minutes and creation in the app is
  then refused for up to 3 h (8 h) **after the attack stops**.
  The per-instance per-app limiter is replaced by a **global per-app create
  budget** (a token bucket) checked in the same Redis script as the cap
  (in-process with memory storage). Its refill rate is **derived from the
  app's `maxSessionMinutes`** so that all creates that can still be live at
  any moment stay at or below half the cap, for any number of instances and
  with any keep-alive. The cap cannot be filled by creates at all; a flood
  can only keep the app's budget empty while it runs, and creation comes
  back seconds after it stops. Closes H1 and M3.
- **Q-1 numbers corrected**, alternatives shown with corrected numbers
  (per-instance derived rate; accepting the DoS).
- **M2:** the join-method set is resolved before the reserve (pure check),
  `JOIN_METHOD_NOT_ALLOWED` can no longer follow a reservation; a "stored or
  released" guard wraps everything after the reserve; tests for every
  failure path after it.
- **L1:** `endInvalid` also removes the group from the app's live set.
- **L2:** `reserve` validates its numbers; `register` is a separate script
  mode, never a cap value; `groupLimits` is validated.
- **L4, M1:** documented (README residuals); L4 is mostly closed by the
  global budget, since every live group starts with a create.
- **R1-R11** of security.md mapped to chunks (section 9).

## 1. Repo layout

- Layout: `monorepo` (pnpm workspace, `apps/*` and `packages/*`; no
  submodules, `git submodule status` is empty). One branch, one PR.
- Affected packages and their checks (root `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm build`, `pnpm audit --audit-level=high`):

| Package | Path | Why |
| --- | --- | --- |
| `@sync-system/protocol` | `packages/protocol` | New error code |
| `@sync-system/server` | `apps/sync-server` | Limits, live-group store and create budget (memory + Redis) |
| `@sync-system/client` | `packages/client` | Error text and typed details for the new code (the `Record<ClientErrorCode, string>` map requires it) |
| reader | `apps/reader` | One `case` so the new code shows the existing "busy" message |

Redis tests (`*.redis.test.ts`) need a local Redis (GitHub Actions is
billing-blocked; run them with the local Docker CI).

## 2. Decisions

`Decisions: none open.` No ADRs: these are limit values and one error name
for one server feature, the same kind of choice #10 (Q5.2) and #35 (Q-B5)
settled at Gate 2 in architecture.md. No new dependency. ADR 0015 is
unchanged (the new variables use the existing `MAX_` family).

**Gate 2 decisions (user, 2026-11-22):**

| Question | Decision |
| --- | --- |
| Q-1 | **Option A**: global per-app token bucket checked with the cap, sustained rate derived |
| Q-2 | **Environment variables, the constants as defaults** (not the recommended fixed constants); details in Q-2 below |
| Q-3 | **`APP_GROUP_LIMIT`**, `details.maxLiveGroups` = the configured cap |
| Q-4 | As recommended: recreations counted, never refused, not charged |
| Q-5 | As recommended: throttled `warn`, `namespace` only |

Plan approved by the user on condition of Revision 2 and a passing security
delta check (no further Gate 2 stop).

### Q-1. Limits and how the per-app budget is enforced (decided: option A)

Notation: `L(app) = maxSessionMinutes(app) + END_TTL_SLACK_MS` (5 s), the
longest a group can be live; `cap = MAX_LIVE_GROUPS_PER_APP` (default
10 000); `burst = MAX_GROUP_CREATE_BURST_PER_APP` (default 120);
`maxRate = MAX_GROUP_CREATES_PER_APP_PER_MINUTE` (default 120). All numbers
below are for the defaults.

**Option A (chosen): global per-app token bucket, rate derived from max session.**

| Limit | Default (env variable) | Counted |
| --- | --- | --- |
| `group.create` per connection | **6 per minute** (`MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE`, sliding window) | Per connection, in process; forgotten on disconnect |
| `group.create` per app, burst | **120** creates at once (`MAX_GROUP_CREATE_BURST_PER_APP`) | **Global**: in Redis across every instance (one process with memory storage) |
| `group.create` per app, sustained | **`min(maxRate, (cap/2 - burst) / L(app))` per minute** (`maxRate` = `MAX_GROUP_CREATES_PER_APP_PER_MINUTE`, 120) | Global, refilled continuously |
| Live groups per app | **10 000** (`MAX_LIVE_GROUPS_PER_APP`) | Global |

Sustained rate by `maxSessionMinutes` (defaults):

| `maxSessionMinutes` | Sustained creates/min | First create after the budget empties | Full burst back after |
| --- | --- | --- | --- |
| 1 to 40 | 120 (the upper bound) | 0.5 s | 1 min |
| 60 | 81.2 | 0.7 s | 1.5 min |
| **180 (default)** | **27.1** | **2.2 s** | **4.4 min** |
| 480 (default ceiling) | 10.2 | 5.9 s | 11.8 min |
| 10 080 (an operator ceiling of one week) | 0.48 | 124 s | 4.1 h |

Why it closes H1: every live group was created (or recreated, Q-4) within
the last `L(app)`. The bucket admits at most `burst + rate x L(app)` creates
in any window of that length, which is `<= cap/2 = 5 000` by construction.
So, whatever the keep-alive, the number of instances or the number of
sockets, creates alone hold at most 5 000 live groups: **the cap is never
reached by creates**. It stays as the backstop for recreations after an
epoch change (L3) and clock skew.

What an attacker can still do (residual, M4, replaces M1): while a flood
runs, creation in the app can be refused **on every instance for as long as
it runs**. Draining the bucket only takes the sustained rate (about 27
creates/min at the default, 10/min at 480 min), so one client with a handful
of reconnecting sockets is enough, and a script that polls right after each
refill takes almost every token: legitimate leaders get `RATE_LIMITED` again
and again. There is no lasting state: the bucket refills as soon as the
flood stops, and other apps are unaffected (AC4). Mitigation: per-IP limits
at the reverse proxy (README). Every attempt counts against the
per-connection limit, including attempts the app budget refuses, so
polling costs fresh connections (pinned by a test, section 7).

Trade-off for legitimate load: a sustained 27 new groups per minute per app
at the default max session (1 600 per hour), 10 per minute at 480 min; a
burst of 120 leaders starting at once is fine. An app that needs more
concurrent groups than about 5 000 needs a larger cap (the rate scales with
it; see Q-2).

Squatting (the M2 of #10 goal): creates hold at most 5 000 groups = 0.5 % of
the 10^6 group codes, so a mistyped method B code reaches a squatter with
probability at most about 0.5 % (1 % at the cap), and `CODES_EXHAUSTED`
(20 draws) is practically impossible (0.01^20).

**Option B: the same derived rate, but per instance (in-process limiter).**
No budget key in Redis, but each instance has its own 5 000: two instances
with keep-alive reach the cap after about 10 000 / (2 x 27.1) = 184 minutes at
the default, three after about 123 minutes, and creation in the app is then
refused for up to max session (3 h, 8 h at 480) after the attack stops.
Safe only for single-instance deployments (H1 for N = 1, M3 stays).

**Option C: keep 120/min per instance and accept the DoS.** With keep-alive
(one leader return plus one leader action per group every < 20 min), one
client on one instance fills the cap in about 10 000 / 120 = 84 minutes;
N instances in about 84 / N minutes. Then **one client can block group
creation in the app for up to max session (3 h default, 8 h at the default
ceiling) after it stops**. Needs the user's explicit acceptance recorded in
STATE.md (R1).

Rejected: a sustained window of `maxSessionMinutes` length with cap/2 creates
(security's example): the same bound, but once spent it stays spent for a
full max session after the attack, and spending it needs no keep-alive at
all. The bucket has the same bound and recovers in seconds. A cap of at
least `2 x 120 x 480 = 115 200` (11.5 % code fill, a mistyped B code hits a
squatter about 1 in 9): defeats the squatting goal. Rate-limiting leader
returns: penalises flaky networks and still leaves N instances.

### Q-2. Fixed constants, env ceilings, or per app (decided: env variables)

**Decision:** all four limits are environment variables, with the round-0
constants as defaults. The sustained rate is not a variable of its own:
`MAX_GROUP_CREATES_PER_APP_PER_MINUTE` is only its upper bound, and the rate
used is still `min(maxRate, (cap/2 - burst) / L(app))`, so the H1 bound holds
for any valid values.

#### Q-2.1 Variables

| Variable | Default | Range | Why the range |
| --- | --- | --- | --- |
| `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE` | 6 | 1 to 600 | The sliding window keeps one timestamp per accepted create per connection; 600 bounds that memory and is still below the inbound message rate |
| `MAX_GROUP_CREATE_BURST_PER_APP` | 120 | 1 to `MAX_SAFE_INTEGER`, plus the cross rule | Bounded in practice by the cross rule (`<= 49 999`) |
| `MAX_GROUP_CREATES_PER_APP_PER_MINUTE` | 120 | 1 to 60 000 | Upper bound of the derived rate; 60 000 = 1 per ms |
| `MAX_LIVE_GROUPS_PER_APP` | 10 000 | 3 to 100 000 | 3 is the smallest cap the cross rule allows (burst 1). 100 000 keeps the part of the 10^6 group codes that creates can hold at `<= 5 %` (10 % at the cap); round 1 rejected 115 200 for defeating the squatting goal |

Names: all four start with `MAX_`, an existing family of ADR 0015, so a
mistyped name fails at startup ("did you mean ...?") instead of being ignored.
The names first suggested at Gate 2 started with `GROUP_`, which is no
family: a typo there would silently fall back to the default, a weaker limit
than intended. Keeping them would mean adding a `GROUP_` family and amending
ADR 0015 (the ADR says a new prefix needs that). The longest name has 43
characters, below the 48-character cut of `MAX_SHOWN_NAME`.

#### Q-2.2 Startup validation

Follows the existing pattern in `config/env.ts`: each variable goes through
`NUMERIC_VARS` (digits only, positive safe integer, `min`/`max`), with the
existing messages `<name> must be a positive integer` and
`<name> must be between <n> and <n>`. One new cross-field rule in
`crossFieldProblems`, checked only when both values are valid on their own:

```
MAX_LIVE_GROUPS_PER_APP (<n>) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (<n>)
```

(the second `<n>` is `2 x burst`, an integer, like the existing
`4 * MAX_MESSAGE_SIZE_CEILING (<n>)` rule). Why this rule: with integers,
`cap > 2 x burst` means `cap/2 - burst >= 0.5`, so the derived rate
`(cap/2 - burst) / L` is `> 0` for every finite `L`, and the bucket holds
`burst + rate x L = cap/2` at most. `cap = 2 x burst` would give a rate of
0 (no create after the first burst, ever); it is refused. No rule between
the per-connection limit and the others: a per-connection limit above the
burst is allowed and harmless (the app budget still applies).

Not validated at startup, by design: how small the derived rate gets. A cap
just above `2 x burst`, or a large `MAX_SESSION_MINUTES_CEILING`, gives a
tiny but positive rate. The README shows the formula and the default table;
R14 keeps `retryAfterMs` and the bucket TTL safe integers whatever the rate.

Every instance must use the same values (README "Several instances", next
to the apps file). If they do not, the bucket still refills at the slowest
rate and the smallest burst any instance used recently (3.1, L6), so a
mismatch can only make creation stricter, never break the H1 bound. Each
instance checks the cap with its own value.

#### Options presented at Gate 2

1. **Fixed constants in `limits/constants.ts`** (recommended at the time): the same as
   every join, door, QR and `tokens.check` budget ("Fixed, not an app
   setting", #10 Q5.2). Smallest change; no new env variable, `known-vars.ts`
   entry, startup error or config test. The sustained rate is still per app,
   because it is derived from the app's `maxSessionMinutes`. Can be made
   configurable later without a breaking change.
2. Env variable for the cap only (`MAX_LIVE_GROUPS_PER_APP`, default
   10 000): lets large multi-instance deployments raise it; the sustained
   rate scales with it automatically. Costs a `known-vars.ts` entry, env
   parsing and tests, `docs/startup-errors.md`. (The name already passes
   ADR 0015's `MAX_` family.)
3. Per-app field `maxLiveGroups` with an env ceiling: most flexible, most
   work (apps config schema, ceiling comparison, README field table).

Trade-off: 1 cannot be tuned without a release; 2 and 3 add config surface
for a limit nobody has hit yet. The user chose a wider variant of 2: all
four limits as env variables.

### Q-3. Error code for the live-group cap

Decided: option 1, `details.maxLiveGroups` = the configured
`MAX_LIVE_GROUPS_PER_APP` (never the current count).

1. **`APP_GROUP_LIMIT`** (recommended, chosen), `details: { maxLiveGroups: number }`:
   mirrors `APP_CONNECTION_LIMIT` (an app-wide cap); the `GROUP_*` codes
   (`GROUP_FULL`, `GROUP_LOCKED`, `GROUP_NOT_FOUND`) are about one group,
   so `GROUP_LIMIT_REACHED` reads like "this group is full".
2. `GROUP_LIMIT_REACHED` (the spec's example), same details.
3. Reuse `CODES_EXHAUSTED`: no protocol change, old clients already know it,
   but it says "try again now" and is not distinguishable from a real code
   shortage, so it fails the spirit of AC3.

No `retryAfterMs`: the server cannot know when a group will end. With
option A of Q-1 this code is rare (recreations after an epoch change), but
AC3 still needs it.

### Q-4. Recreated groups (`group.resume` after a restart)

Decided: option 1.

1. **Counted, never refused, not charged to the budget** (recommended, chosen): the
   recreation registers the group in the live-group set (`register`, a
   separate script mode) so the count stays true; it restores a group that
   existed and is already limited by `RECREATIONS_PER_CONNECTION_PER_MINUTE`.
   The count may then exceed the cap until groups end; new creates are
   refused meanwhile. Bound (L3): only tokens from before an epoch change,
   inside their `lat` window, once per restart; the groups age out by max
   session.
2. Counted and refused at the cap with `APP_GROUP_LIMIT`: a restart into a
   full app would lose leaders' groups.
3. Not counted: the cap undercounts after a memory restart.

### Q-5. Refusal logging

**Recommended, chosen:** one `warn` per app per minute (per instance) when the app's
create budget is empty (`group_create_app_budget_exhausted`) and when the
cap refuses (`app_group_limit_reached`), with `namespace` only, the same
throttle as `warnAppBudget` in `join-service.ts`. No group code (none is
drawn), no group ID or ref, no connection ID, no count. Per-connection
refusals are not logged.

## 3. Approach

The checks run in `group.create` in this order (R2). Nothing before the
reserve stores state or draws a code:

1. `busy` -> size checks -> display name (unchanged).
2. Per-connection create rate:
   `createLimiter.tryAcquire(session.connectionId, perConnection)`; refused:
   `RATE_LIMITED` for `group.create` with `details.retryAfterMs`. In process,
   checked first, so a socket over its own limit never spends the app's
   budget (the join pattern, `join-service.ts` `budget()`).
3. **Method resolution** (moved out of `initialCodes`, M2):
   `resolveGroupMethods(app.joinMethods, message.joinMethods)`; refused:
   `JOIN_METHOD_NOT_ALLOWED`. A pure check, before the lock and before the
   reserve.
4. Under the new group's lock (`createLocked`), first:
   `liveGroups.reserve(namespace, groupId, { now, expiresAt, burst, refillPerMinute, cap })`
   with `expiresAt = groupExpiry(namespace, now)`,
   `refillPerMinute = appCreateRefillPerMinute(limits, app.maxSessionMinutes)`
   (or the `groupLimits` override), and `burst`/`cap` from `limits` (the
   env values, section 3 "Limits"). One atomic step: budget, then cap, then add.
   - `{ ok: false, reason: 'rate', retryAfterMs }`: `RATE_LIMITED` with
     `details.retryAfterMs`, plus the throttled warning.
   - `{ ok: false, reason: 'cap' }`: `APP_GROUP_LIMIT` with
     `details.maxLiveGroups`, plus the throttled warning.
   - Either refusal: nothing drawn, nothing stored, no budget charged for a
     cap refusal.
5. **Stored-or-released guard** (R4): from a successful reserve until
   `store.create` resolves, one `try`/`finally` with a `stored` flag; if the
   group was not stored (an error return such as `CODES_EXHAUSTED`, a throw
   from `initialCodes`/`issueCodeSet`/Redis, a throwing `store.create`),
   `finally` calls `liveGroups.release(namespace, groupId)` next to the
   existing `releaseCodes`. With Redis, the reserve also registers
   `work.current()?.onAbandon(ZREM)`, so an abandoned commit drops the slot.
6. `initialCodes(app, groupId, methods)` now takes the resolved methods and
   can only fail with `CODES_EXHAUSTED`.

A create that passes the budget and then fails at codes or storage keeps its
budget charge (no refund): a full or failing app must not be hammered at
full speed. A cap refusal does not charge: no group was created.

The per-connection limiter is a `SlidingWindowRateLimiter` in `GroupService`
(window `GROUP_CREATE_WINDOW_MS = 60_000`), synchronous and in-process like
`recreateLimiter`; its key is forgotten in `disconnect()` and it and the
warning throttle are cleared on shutdown next to `recreateLimiter.clear()`
(R10). There is no in-process per-app limiter any more: the per-app budget
lives in the live-group store.

**Limits** (Revision 2). The four values come from `ServerEnv`
(section 2, Q-2), read once in `createSyncServer` and passed into
`GroupServiceDeps` as one frozen object:

```ts
/** group.create limits (#12), from the env or the test-only groupLimits. */
export interface GroupCreateLimits {
  perConnectionPerMinute: number; // MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE
  appBurst: number;               // MAX_GROUP_CREATE_BURST_PER_APP
  appMaxPerMinute: number;        // MAX_GROUP_CREATES_PER_APP_PER_MINUTE (upper bound)
  maxLiveGroups: number;          // MAX_LIVE_GROUPS_PER_APP
}
```

The defaults are named constants in `limits/constants.ts`
(`DEFAULT_GROUP_CREATES_PER_CONNECTION_PER_MINUTE = 6`,
`DEFAULT_GROUP_CREATE_BURST_PER_APP = 120`,
`DEFAULT_GROUP_CREATES_PER_APP_PER_MINUTE = 120`,
`DEFAULT_MAX_LIVE_GROUPS_PER_APP = 10_000`) plus the range bounds of Q-2.1;
`env.ts` imports them for `NUMERIC_VARS` (as it already imports
`TOKENS_CHECK_MAX_FRAME_BYTES`). Nothing else reads the defaults directly.

The derived rate (pure, in `limits/constants.ts`):

```ts
/** Sustained group.create rate per app (#12 H1): burst + rate x L <= cap / 2. */
export function appCreateRefillPerMinute(
  limits: Pick<GroupCreateLimits, 'appBurst' | 'appMaxPerMinute' | 'maxLiveGroups'>,
  maxSessionMinutes: number,
): number {
  const lifetimeMinutes = maxSessionMinutes + END_TTL_SLACK_MS / MINUTE_MS;
  const derived = (limits.maxLiveGroups / 2 - limits.appBurst) / lifetimeMinutes;
  return Math.min(limits.appMaxPerMinute, derived);
}
```

It throws (programming error) if `maxLiveGroups <= 2 x appBurst`; the env
cross rule (Q-2.2) and the `groupLimits` validation make that unreachable
from config.

### 3.1 Live-group store with create budget (new, both storages)

A new storage part `liveGroups: LiveGroupsStore` on `Storage`:

```ts
/** Per-app create budget and limits (#12). Values validated by `reserve`. */
export interface CreateBudget {
  /** Server clock; the memory store's clock. Redis uses its own TIME instead (L7). */
  now: number;
  /** The group's end bound (instance clock), its score and the `u` horizon. */
  expiresAt: number;
  /** Bucket size, safe integer >= 1. */
  burst: number;
  /** Refill per minute, finite and > 0. */
  refillPerMinute: number;
  /** Live-group cap, safe integer >= 1. */
  cap: number;
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'rate'; retryAfterMs: number }
  | { ok: false; reason: 'cap' };

/** Live groups per app (#12): the cap's count and the create budget. Never logged. */
export interface LiveGroupsStore {
  /** Charges the app's budget and adds `groupId` unless the budget is empty or the app is at the cap. Throws on invalid numbers. Idempotent for a held ID (no charge). */
  reserve(namespace: string, groupId: string, budget: CreateBudget): Promise<ReserveResult>;
  /** Adds `groupId` without budget or cap (recreation, Q-4). */
  register(namespace: string, groupId: string, expiresAt: number): Promise<void>;
  /** Removes `groupId` (group ended, invalid, or its create failed). */
  release(namespace: string, groupId: string): Promise<void>;
  /** Forgets local state (server shutdown). */
  clear(): void;
}
```

The bucket: `tokens` (a float) and `at` (ms), plus the strictest recent
parameters (Revision 2, R13 for L6): `r` (the slowest refill rate, per
minute), `b` (the smallest burst) and `u` (until when they hold, ms).
On every `reserve`, before the refill:

- if `now < u`: `r = min(r, refillPerMinute)`, `b = min(b, burst)`,
  `u = max(u, expiresAt)`;
- else (or a missing bucket): `r = refillPerMinute`, `b = burst`,
  `u = expiresAt`.

So `r` and `b` hold until every group created under them can have ended;
the bound `b + r x L <= cap/2` then holds even when instances disagree on
`maxSessionMinutes` or on the env limits (a mismatch only makes creation
stricter for up to one `L`). Transition, worst case: groups created at a
faster rate with a shorter `L_s` (at most `cap/2`) can overlap for up to
`L_s` with the first long groups created at the slow rate (at most
`b + r x L_s`), so the count stays below the cap and drops back under
`cap/2` within `L_s`; the cap stays the backstop. Refill with the effective values:
`tokens = min(b, tokens + max(0, now - at) x r / 60 000)`; a missing bucket
is full (`tokens = b`). Refused when `tokens < 1`, with
`retryAfterMs = min(ceil((1 - tokens) x 60 000 / r), MAX_RETRY_AFTER_MS)`.
Charge: `tokens -= 1`, `at = max(at, now)` (never moves back on clock skew).
A refusal writes nothing (the `r`/`b`/`u` update is only written with a
charge, so a refusal cannot tighten or loosen anything).

R14 (L8): `MAX_RETRY_AFTER_MS` and the bucket TTL are clamped to
`1e13` ms (a safe integer, about 317 years) and always integers
(`Math.ceil` / `math.ceil`), so a large `MAX_SESSION_MINUTES_CEILING` or a
cap just above `2 x burst` cannot produce an unsafe number, exponent
notation in a Redis argument or a fractional `PEXPIRE`. The bucket TTL is
`max(time to full at r, u - now) + 1 s`, clamped the same way, so `r`/`b`
are not forgotten before `u`.

Clock (R13 for L7): with Redis, `now` for the refill, the charge, the `u`
comparison and the prune is Redis `TIME` (the existing `REDIS_NOW` snippet
in `scripts.ts`); `expiresAt` (the scores) stays on the instance clock like
every group deadline. With memory storage, `now` is the server clock.

- **Memory** (`MemoryLiveGroups`, `src/groups/live-groups.ts`): with memory
  storage there is one process, so "global" and "per process" are the same.
  `Map<namespace, { live: Map<groupId, expiresAt>, bucket }>` (the bucket
  with the same `t, a, r, b, u` and the same shared arithmetic, so both
  storages give the same `retryAfterMs`); every method
  body is synchronous (check, charge and add atomic in-process, like
  `CodeIndex`); `reserve` first drops entries past `expiresAt`; an app's
  entry is deleted when its live map is empty, its bucket is full and `u`
  has passed, so the
  number of keys is bounded by apps with live groups or recent creates. A
  restart loses the bucket and the set (both start empty/full); recreations
  register (Q-4).
- **Redis** (`RedisLiveGroups`, `src/storage/redis/live-groups.ts`), two
  keys per app, both built by `RedisKeys` with the namespace checked against
  `NAMESPACE_PATTERN`:
  - `appLive(ns)` -> `<base>:lg:<ns>`: sorted set, member = group ID (checked
    against `GROUP_ID_PATTERN` before the call), score = `expiresAt`.
  - `appCreateBudget(ns)` -> `<base>:lb:<ns>`: hash
    `{ t: tokens, a: at, r: slowest rate per minute, b: smallest burst, u: until }`.
  - A new constant Lua script `RESERVE_LIVE` in `scripts.ts`. KEYS: the set,
    the bucket. ARGV: mode (`reserve` | `register`), member, expiresAt,
    and for `reserve` cap, burst, refill per minute. `now` is Redis `TIME`
    inside the script (L7). Numbers are passed as integer or fixed-point
    strings, never exponent notation (L8). Steps (R5):
    1. Mode is exactly `reserve` or `register`, else `redis.error_reply`.
       Every number via `tonumber`; `nil`, or for `reserve` cap/burst not an
       integer >= 1 or refill not > 0: `redis.error_reply`.
    2. `ZREMRANGEBYSCORE set -inf (now` (prune).
    3. Member already present: raise its score to `expiresAt` if higher,
       extend the TTL, return ok (no charge).
    4. Mode `register`: `ZADD`, extend the TTL, return ok.
    5. Effective `r`/`b`/`u` (above), refill; `tokens < 1`: return
       `{rate, retryAfterMs}` (integer, `math.ceil`, clamped) without writing.
    6. `ZCARD >= cap`: return `cap` without charging.
    7. Charge (`HSET t a r b u`), `PEXPIRE` the bucket to the integer TTL
       above (a missing bucket is full, so expiry is exact), `ZADD`, extend
       the set's TTL.
    Float fields (`t`, `r`) are stored with `string.format('%.17g')` and
    read with `tonumber`; Lua numbers returned to Redis are integers only.
    The set's TTL is only ever extended to its largest score: read with
    `PEXPIRETIME` (handles -1 no expiry and -2 missing) and `PEXPIREAT` only
    when larger.
  - Mirrors `RedisCodeIndex.claim`: a fresh reservation registers
    `work.current()?.onAbandon(...)` that `ZREM`s it if the task or its
    commit fails (best effort; the score bounds it anyway; the budget charge
    is not refunded). `release` inside a running unit of work adds a commit
    step `plan.zrem(key, groupId)` (like `RedisCodeIndex.release`), else
    runs its own unfenced plan.
- `reserve` (both storages) throws before any call if `cap` or `burst` is
  not a safe integer >= 1 or `refillPerMinute` is not finite and > 0 (R7).
  `register` never takes a cap.
- `GroupService.endGroup` releases in the same commit as `store.delete` (the
  `plan.zrem` step). Not in `forgetGroup` (that also runs for the cluster
  `forget` op, which only drops local state on other instances) (R6).
- `RedisEndedGroups.endInvalid` adds `plan.zrem(keys.appLive(namespace), groupId)`
  to its writes (L1, R6). The memory sweeper has no invalid documents.
- `recreate` calls `liveGroups.register(...)` only after `createIfAbsent`
  returned `created`, with `expiresAt = groupExpiry(namespace, claims.gct)`;
  a failed recreation commit undoes it through `onAbandon`; nothing on
  `exists` (R8).
- Groups that leave Redis without an `endGroup` (TTL expiry after an outage,
  a crashed instance) are pruned by score at the next reserve: drift is
  bounded by the group's end bound, never permanent.

Rejected: counting from the code index (groups with only method D or C have
no group code, and Redis code keys cannot be counted per app); counting from
the global `keys.live()` set (members `ns:gid` of every app, no per-app count
without a scan); an `INCR`/`DECR` counter (drifts for ever on a crash; the
sorted set self-heals by score); checking the cap inside the commit script
(changes the commit script for every write); a separate budget script before
the lock (two round trips, and a cap refusal would still charge).

## 4. Files to create / modify

| Path | Change |
| --- | --- |
| `packages/protocol/src/errors.ts` | Add `APP_GROUP_LIMIT` with a doc comment (per Q-3). |
| `packages/protocol/test/codes.test.ts` | Covered by the existing key = value loop; add one explicit assertion. |
| `apps/sync-server/src/limits/constants.ts` | Chunk 2: the four `DEFAULT_*` values (6, 120, 120, 10 000) and the range bounds of Q-2.1 (per connection max 600, per-app rate max 60 000, cap min 3 and max 100 000), documented like the join constants. Chunk 4: `GROUP_CREATE_WINDOW_MS = 60_000`, `MAX_RETRY_AFTER_MS = 1e13`, `GroupCreateLimits`, `appCreateRefillPerMinute(limits, maxSessionMinutes)` (section 3). |
| `apps/sync-server/src/config/known-vars.ts` | Add the four names to `KNOWN_SERVER_VARIABLES` (all in the `MAX_` family; no new prefix, ADR 0015 unchanged). |
| `apps/sync-server/src/config/env.ts` | Four `ServerEnv` fields (`maxGroupCreatesPerConnectionPerMinute`, `maxGroupCreateBurstPerApp`, `maxGroupCreatesPerAppPerMinute`, `maxLiveGroupsPerApp`), four `NUMERIC_VARS` entries with the defaults and ranges, the cross rule `MAX_LIVE_GROUPS_PER_APP (<n>) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (<n>)` in `crossFieldProblems`, and the fields in the returned `serverEnv`. Not app ceilings (`AppCeilings` unchanged). |
| `docs/startup-errors.md` | One row in "rules that span variables" for the new cross rule, with the fix "Raise `MAX_LIVE_GROUPS_PER_APP` or lower `MAX_GROUP_CREATE_BURST_PER_APP`". The per-variable messages are the existing generic rows. |
| `apps/sync-server/src/groups/live-groups.ts` (new) | `LiveGroupsStore`, `CreateBudget`, `ReserveResult`, the shared validation and bucket arithmetic, `MemoryLiveGroups`. |
| `apps/sync-server/src/storage/redis/live-groups.ts` (new) | `RedisLiveGroups`. |
| `apps/sync-server/src/storage/redis/keys.ts` | `appLive(ns)` -> `<base>:lg:<ns>`, `appCreateBudget(ns)` -> `<base>:lb:<ns>`. |
| `apps/sync-server/src/storage/redis/scripts.ts` | `RESERVE_LIVE` Lua script (constant string, all values in KEYS/ARGV). |
| `apps/sync-server/src/storage/redis/ended.ts` | `endInvalid`: `ZREM` from `appLive(namespace)` in the same plan (L1). |
| `apps/sync-server/src/storage/storage.ts` | `liveGroups` on `Storage`; `memoryStorage` wires `MemoryLiveGroups`. |
| `apps/sync-server/src/storage/redis/redis-storage.ts` | Wires `RedisLiveGroups(ctx, work)`. |
| `apps/sync-server/src/server.ts` | Pass `storage.liveGroups` and the `GroupCreateLimits` built from `env` into `GroupServiceDeps`; optional test-only `groupLimits?: { perConnection?, appBurst?, appRefillPerMinute?, maxLiveGroups? }` on `SyncServerOptions`, each overriding its env value (`appRefillPerMinute` replaces the derived rate), same pattern as `endedGroupsCap` / `replayCap`. `createSyncServer` throws if a given value is not a positive safe integer (`appRefillPerMinute`: finite and > 0), or if the resulting cap is not `> 2 x` the resulting burst. Not read from env, the apps file or any client input; `main.ts` does not pass it (R7). |
| `apps/sync-server/src/joins/join-service.ts` | `initialCodes(app, groupId, methods)` takes resolved methods; only `CODES_EXHAUSTED` remains as a failure. |
| `apps/sync-server/src/groups/group-service.ts` | Per-connection limiter, method resolution before the lock, `reserve` with budget in `createLocked`, the stored-or-released guard, release in `endGroup`, `register` in `recreate`, forget in `disconnect`, clear on shutdown, throttled warnings. |
| `apps/sync-server/src/ws/error-messages.ts` | Fixed text for `APP_GROUP_LIMIT`, e.g. `'The app has too many live groups; try later'`. |
| `packages/client/src/errors.ts` | `MESSAGES` text and `KnownDetails.APP_GROUP_LIMIT: { maxLiveGroups?: number }` (tolerant parsing). |
| `apps/reader/src/group/errors.ts` | `case 'APP_GROUP_LIMIT':` next to `CODES_EXHAUSTED` -> `errBusy`. `RATE_LIMITED` on create already maps to `errRateLimited` with the wait. |
| Tests (section 7) | New `group-create-limits.int.test.ts`, `live-groups.test.ts` (bucket arithmetic, validation, the H1 simulation), contract `liveGroupsContract` in `test/contracts/state.ts` run from `storage-contracts.test.ts` and `redis-storage-contracts.redis.test.ts`; a Redis multi-instance case; additions to `constants` tests, `keys.test.ts`, the `endInvalid` Redis test, `error-messages.test.ts`, client `errors.test.ts`, reader error test. Config (chunk 2): `env.test.ts`, `config-matrix.test.ts` (`VALID_VALUES` for the four names; its key list must equal `KNOWN_SERVER_VARIABLES`), `unknown-vars.test.ts` (a typo of a new name is flagged with the suggestion), the startup-errors doc test and the README drift test (`repo-hygiene.test.ts`) pick the new names up. |
| `README.md` | Chunk 2: four rows in the "Environment variables" table (default, range, the cross rule, "same value on every instance"); the README drift test requires them in the same chunk as `known-vars.ts`. Chunk 6: the rest (section 6). |
| `packages/client/README.md`, `docs/conventions.md` | Docs chunk (section 6). |

## 5. Contracts

### 5.1 Wire (protocol stays version 1)

`group.create` gains two refusals; its success reply is unchanged.

| Refusal | Frame |
| --- | --- |
| Per-connection rate, or the app's create budget is empty | `{type: 'error', reqId, code: 'RATE_LIMITED', message, details: {retryAfterMs: number}}` (same shape as `tokens.check` / join refusals) |
| Live-group cap | `{type: 'error', reqId, code: 'APP_GROUP_LIMIT', message, details: {maxLiveGroups: number}}` (the configured `MAX_LIVE_GROUPS_PER_APP` of the refusing instance, never the current count) |

Fixed message texts from `error-messages.ts`. The connection stays open; no
group, code, token or timer is created (R3). Precedent for adding codes
without a version bump: #10 and #13. An older client that receives
`APP_GROUP_LIMIT` fails its `z.enum(ErrorCode)` parse and rejects the request
as `INVALID_SERVER_MESSAGE`; acceptable because server and clients ship from
this repo, and it is listed under Upgrading.

### 5.2 Redis data

Two new keys per app, no user data (namespaces and group IDs are already key
parts):

- `<prefix>:v1:lg:<namespace>`: sorted set of group IDs scored by their end
  bound (ms), `PEXPIREAT` at the largest score.
- `<prefix>:v1:lb:<namespace>`: hash `{t, a, r, b, u}` (tokens, last charge ms,
  slowest recent rate, smallest recent burst, until when they hold),
  `PEXPIRE` (integer, clamped) at `max(time to full, u - now) + 1 s`.

Commands: `TIME`, `ZREMRANGEBYSCORE`, `ZSCORE`, `ZCARD`, `ZADD`, `ZREM`, `HMGET`,
`HSET`, `PEXPIRE`, `PEXPIREAT`, `PEXPIRETIME` inside the script: all
covered by the README's ACL (`+@read +@write +@scripting`); `PEXPIRETIME`
needs Redis 7, within the README's minimum (7.2) and already used by the
existing scripts. No migration: the keys are created on the first create
after the upgrade; groups that existed before the upgrade are not counted
until they end (undercount for at most one max session). Documented in
Upgrading.

`Docker impact: none.`

## 6. Docs impact

- `README.md`:
  - **Chunk 2 (config):** four rows in the "Environment variables" table:
    `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE` (`6`, 1 to 600),
    `MAX_GROUP_CREATE_BURST_PER_APP` (`120`; `MAX_LIVE_GROUPS_PER_APP` must
    be > 2 x this), `MAX_GROUP_CREATES_PER_APP_PER_MINUTE` (`120`, 1 to
    60 000, upper bound of the derived rate), `MAX_LIVE_GROUPS_PER_APP`
    (`10000`, 3 to 100 000); each says "same value on every instance".
  - **Chunk 6 (docs):** "Fixed join limits" renamed "Join and creation
    limits": the creation rows name their variables and defaults (6 per
    connection per minute; per app a burst of 120 and a sustained rate
    `min(MAX_GROUP_CREATES_PER_APP_PER_MINUTE, (MAX_LIVE_GROUPS_PER_APP / 2
    - MAX_GROUP_CREATE_BURST_PER_APP) / (maxSessionMinutes + 5 s))` with the
    Q-1 table for the defaults; 10 000 live groups per app); the error
    codes; why (creates can hold at most half the cap, so the cap cannot be
    filled by creates); that raising the cap raises the sustained rate and
    raising the burst lowers it, and that a cap just above `2 x` the burst
    leaves almost no sustained rate.
  - "Several instances" requirements: the four variables must be the same
    on every instance, like the apps file; if they are not, the bucket
    follows the strictest values used recently, and each instance checks
    the cap with its own value (L6).
  - "Limits with several instances" table: create rate per connection = per
    instance; per-app create budget and live groups per app = global.
  - Residuals, replacing the "Group-code squatting ... Tracked in issue #12"
    bullet (R11, M4 wording): creates hold at most 0.5 % of group codes at
    the defaults (1 % at the cap; `cap / 2 / 10^6` in general); while a
    flood runs, creation in an app can be refused on every instance for as
    long as it runs, and one client with a handful of reconnecting sockets
    is enough; it ends when the flood stops; per-IP limits at the reverse
    proxy are the operator's mitigation; the cap and the budget are global
    while connections are per instance, and raising
    `MAX_SESSION_MINUTES_CEILING` lowers the sustained create rate of apps
    that use the longer sessions (L4); a change to `maxSessionMinutes` or to
    the four variables takes up to one old max session to settle in the
    cap count and the bucket (L6).
  - Errors list in "Protocol (v1) in brief": add `APP_GROUP_LIMIT`.
  - "Upgrading": live groups created before the upgrade are not counted;
    old clients see `APP_GROUP_LIMIT` as an invalid server message; four new
    optional variables, the defaults keep the documented limits.
- `docs/startup-errors.md` (chunk 2): the new cross-rule row.
- `packages/client/README.md`: errors table row for `APP_GROUP_LIMIT`; note
  that `createGroup()` can now reject with `RATE_LIMITED` (`retryAfterMs`).
- `docs/conventions.md`: one row under "Sync server" recording the Gate 2
  choices (Q-1 to Q-5: derived global bucket, the four `MAX_` env variables
  with their defaults, `APP_GROUP_LIMIT`) with a link to this file.
- No `package.json` change (no new dependency).

## 7. Test plan

Server tests use `TestClock`/manual scheduler and lowered `groupLimits`
(for example per-connection 2, app burst 3, refill 1/min, cap 2) so no test
creates thousands of groups; one test checks the default values.

| AC / control | Test |
| --- | --- |
| Config: defaults | `env.test.ts`: with none of the four set, `parseEnv` gives 6, 120, 120, 10 000 (the `DEFAULT_*` constants). |
| Config: per variable | `env.test.ts`, for each of the four: `abc`, `0`, `-1`, `1.5`, `01`, empty, and a value above `MAX_SAFE_INTEGER` give `<name> must be a positive integer`; just outside the range (per connection 601, per-app rate 60 001, cap 2 and 100 001) gives `<name> must be between <n> and <n>`; the range ends (1, 600, 60 000, 3, 100 000) are accepted. No message contains the raw value. |
| Config: cross rule | `env.test.ts`: cap 240 with burst 120 (equal to `2 x burst`) gives `MAX_LIVE_GROUPS_PER_APP (240) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (240)`; cap 241 with burst 120 passes; cap 3 with burst 1 passes; the rule is skipped (only the own-value problem is reported) when either value is invalid. |
| Config: harness | `config-matrix.test.ts` `VALID_VALUES` for the four names; `unknown-vars.test.ts`: `MAX_GROUP_CREATE_BURST_PERAPP` is flagged with "did you mean `MAX_GROUP_CREATE_BURST_PER_APP`?"; the startup-errors doc test finds the new row; the README drift test finds the four rows. |
| R1 (H1) inequality, defaults | Unit: for `maxSessionMinutes` in {1, 40, 41, 180, 480, 10 080}, with the default limits, `appCreateRefillPerMinute(defaults, m) > 0`, `<= appMaxPerMinute`, and `appBurst + rate x (m + END_TTL_SLACK_MS/60 000) <= maxLiveGroups / 2` (relative tolerance `1e-9` for floating point; the admitted count is an integer). Values at 180 and 480 match the README (27.1, 10.2). |
| R1 (H1) inequality, configured extremes | Same assertions for every combination of limits {defaults; smallest valid (cap 3, burst 1, rate bound 1); tightest headroom at the largest cap (cap 100 000, burst 49 999); widest headroom (cap 100 000, burst 1, rate bound 60 000); rate bound 1 with default cap and burst} and `maxSessionMinutes` in {1, 41, 180, 480, 10 080, 10^7}; and `appCreateRefillPerMinute` throws for `maxLiveGroups = 2 x appBurst`. |
| R1 (H1) simulation | Unit on `MemoryLiveGroups` with a simulated clock, for the default limits at `maxSessionMinutes` 180 and 480, and for cap 3 / burst 1 and cap 100 000 / burst 1 / rate bound 60 000 at 180: reserve as fast as the bucket allows for `2 x L` simulated minutes and never release (worst-case keep-alive): the live count never exceeds `cap / 2` and no reserve returns `cap`. Reset case (L9): drop the bucket in the middle of the run; the count stays `<= cap / 2 + burst` and no reserve returns `cap`. |
| L6 (R13) strictest recent values | `liveGroupsContract` (memory and Redis): reserves with a fast rate and a slow rate on one app alternate (two "instances"): the admitted count over `L` matches the slow rate; a larger burst on one caller does not raise the bucket above the smaller one until `u` passes; after `u` the new values apply. `.redis`: two server instances configured with different `MAX_GROUP_CREATE_BURST_PER_APP` share the smaller burst. |
| L7 (R13) Redis clock | `.redis`: a reserve whose instance clock is far ahead does not mint tokens or move `a` beyond Redis `TIME`, and does not prune entries scored after Redis `TIME`. |
| L8 / R14 clamps | Unit and `.redis`: at `maxSessionMinutes` 10^7 with cap 3 / burst 1, `retryAfterMs` and the bucket TTL are safe integers `<= 1e13`, the script returns no error, and `retryAfterMs >= 1` for a fractional wait. |
| M4 (optional fix, pinned) | int: attempts refused by the app budget still count against the per-connection limit (the connection gets the per-connection `RATE_LIMITED` after its 6th attempt even if all 6 were refused by the budget). |
| AC1 per-connection rate | int: one client creates, ends, creates ... until refused: `RATE_LIMITED`, `details.retryAfterMs > 0`; the code index size and live count are unchanged by the refused create (a `codeRandom` that counts calls: zero draws); after the window passes, create works; a reconnect resets it. |
| AC2 per-app budget | int: several clients of app-a exceed the burst: `RATE_LIMITED` with `retryAfterMs`, zero draws, live count unchanged; after `retryAfterMs` one more create works (refill); a connection already over its own rate does not spend the app budget. |
| AC2 across instances | `.redis`: two instances on one prefix share the app's budget: burst 3 split over both admits exactly 3. |
| AC3 live-group cap | int (cap 2, large burst): fill the cap with abandoned groups (create, disconnect): the next create gets `APP_GROUP_LIMIT` with `maxLiveGroups`, distinct from `RATE_LIMITED`, zero draws, no group stored, budget not charged; after one group ends (`group.end`), a create works again. |
| R4 (M2) failure paths | int: after a successful reserve the live count is unchanged afterwards for `CODES_EXHAUSTED`, a throwing `store.create` (store stub) and, in `.redis`, an abandoned commit (fenced or failing commit). A disallowed `joinMethods` returns `JOIN_METHOD_NOT_ALLOWED` with zero `reserve` calls (spy) and an unchanged budget. |
| R6 / L1 | `.redis`: `endInvalid` of a counted group removes it from `appLive`; `forgetGroup` does not; `endGroup` removes it in the delete's commit. |
| R7 / L2 | Unit: `reserve` throws for cap/burst 0, -1, 1.5, `NaN`, `Infinity` and refill 0, -1, `NaN`; the script returns an error reply for a non-number ARGV and for a mode other than `reserve`/`register`; `createSyncServer` throws for an invalid `groupLimits` (including a cap `<= 2 x` burst after the override); `main.ts` builds no `groupLimits` (grep-style assertion or review); a server built from a parsed env with non-default values uses them (int: `MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE=2` refuses the 3rd create; `MAX_LIVE_GROUPS_PER_APP=3`, burst 1 reports `maxLiveGroups: 3`). |
| AC3 storage parity | `liveGroupsContract` for memory and Redis: reserve to the cap, refuse at the cap without charging, budget empties and refills with the right `retryAfterMs`, idempotent re-reserve without charge, release frees a slot, `register` ignores budget and cap, expired entries pruned, per-app isolation, TTLs set and only extended (Redis). |
| AC3 across instances | `.redis`: the cap counts groups of both instances; concurrent reserves on both at cap - 1 admit exactly one. |
| R8 / Q-4 | int: a recreation at the cap succeeds, is counted, does not charge the budget, and the next create is refused with `APP_GROUP_LIMIT`. |
| AC4 isolation | int: app-a with an empty budget and at its cap; app-b creates normally. |
| AC5 / R9 logs | `LogCapture` over every refusal path: no 6-digit or alphanumeric code, no group ID or ref, no connection ID, no count; each warning appears once per minute per app with `namespace` only; none for per-connection refusals. |
| R10 | Unit: `disconnect()` forgets the per-connection key; shutdown clears the limiter and the throttle. |
| `keys.test.ts` | `appLive` and `appCreateBudget` reject a bad namespace. |
| AC6 README | Docs chunk; QA reviews. |
| AC8 checks | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Redis tests locally; no `package.json` dependency change. |

Existing tests must keep passing with the default values: some create up to
13 groups per app in one server, below the burst of 120; any test that
exceeds a limit gets a raised `groupLimits` rather than a changed default.
Tests that spawn the server already drop the parent's `MAX_*` names
(`test/helpers/child-env.ts`), so a developer's shell cannot change them.

## 8. Risks / edge cases

- **App-wide create DoS while a flood runs** (residual, M4): while a flood
  runs, creation in the app can be refused on every instance for as long
  as it runs. One client with a handful of reconnecting sockets (about 5 at
  the default, 2 at 480 min) drains the sustained rate, and a script that
  polls right after each refill takes almost every token, so legitimate
  leaders are refused again and again. It does not outlast the attack:
  creates cannot fill the cap (H1 closed), whatever the keep-alive or the
  number of instances (M3 closed), and the bucket refills when the flood
  stops. Operator mitigation: per-IP limits at the reverse proxy.
- **Legitimate load above the sustained rate**: an app that needs more than
  about 27 new groups per minute for hours (default max session) is
  throttled. The operator raises `MAX_LIVE_GROUPS_PER_APP` (the rate scales
  with it, up to `MAX_GROUP_CREATES_PER_APP_PER_MINUTE`) at the cost of
  squat margin (at most 5 % of codes at the 100 000 maximum).
- **Misconfigured limits** (Revision 2): a cap just above `2 x` the burst, or
  a large `MAX_SESSION_MINUTES_CEILING`, gives a tiny sustained rate; valid
  but nearly unusable, documented with the formula. R14 keeps every number
  a safe integer.
- **Instances with different values** (L6): the bucket follows the slowest
  rate and smallest burst used while their groups can be live, so the H1
  bound holds; creation is stricter than either config for up to one `L`
  after a change. Each instance checks the cap with its own
  `MAX_LIVE_GROUPS_PER_APP`, so the instance with the lower cap refuses
  first; `details.maxLiveGroups` shows the refusing instance's value.
- **Long operator ceilings**: a `MAX_SESSION_MINUTES_CEILING` of a week
  gives apps that use it 0.48 creates per minute at the defaults. Documented.
- **Cap reached after an epoch change**: recreations (Q-4) can push the
  count over the cap for at most one max session after a Redis data loss or
  a memory restart; new creates get `APP_GROUP_LIMIT` meanwhile. Not
  attacker-triggerable (L3).
- **Reservation leaks**: every path after a reserve that stores no group
  releases (guard, section 3 step 5); a crash between reserve and commit
  leaves a slot until its score passes (at most max session plus slack).
- **Fenced or unreachable Redis**: `reserve` throws like other storage calls;
  the existing handling (1001 / `INTERNAL_ERROR`) applies; `onAbandon`
  drops the slot.
- **Clock** (L7): with Redis the bucket, `u` and the prune use Redis `TIME`;
  the scores (`expiresAt`) use the instance clock like every group deadline,
  so a skewed instance can only shift its own groups' end bounds by its
  skew; the bucket's `at` never moves back; instances must keep clocks in
  sync (already required).
- **Rate charged on later failure**: intended (section 3).

## 9. Security

Security-sensitive: yes

- Abuse limits on a message handler that accepts anonymous input
  (`group.create`, public API key): order of checks, no code drawn before
  refusal, per-app isolation, global per-app budget (`group-service.ts`,
  `groups/live-groups.ts`).
- New Redis key families and a Lua script: key parts checked in `keys.ts`,
  constant script with `KEYS`/`ARGV` only, numbers validated
  (`keys.ts`, `scripts.ts`, `storage/redis/live-groups.ts`).
- `endInvalid` writes (`storage/redis/ended.ts`).
- Logging of refusals: namespace only (`group-service.ts`).
- New wire error code and details (`packages/protocol/src/errors.ts`).
- Secrets/config (Revision 2): four new env variables that set abuse
  limits; startup validation and the cross rule that keeps the H1 bound
  (`config/env.ts`, `config/known-vars.ts`); messages print validated
  integers only, never raw values (echo rules of `docs/startup-errors.md`).

Findings of [security.md](security.md) (rounds 1 and 2, controls R1-R14 of
R2.4) and where they are handled (chunk numbers of section 11):

| Finding / control | Handling | Chunk |
| --- | --- | --- |
| H1, R1 | Global per-app token bucket with derived rate (Q-1 option A), now from the env limits; the cross rule keeps the rate `> 0`; inequality tests at the defaults and at configured extremes; simulation incl. the reset case (L9) | 2, 3, 4, 5 |
| M1 / M4, R11, R12 | M4 wording in Q-1, section 8 and the README; per-IP limits at the proxy; the per-connection count of budget-refused attempts is pinned by a test | 5, 6 |
| M2, R4 | Method resolution before reserve; stored-or-released guard; failure-path tests | 4, 5 |
| M3 | Closed by the global budget (option A) | 3, 5 |
| L1, R6 | `endInvalid` ZREM; release in `endGroup`'s commit; not in `forgetGroup` | 3, 5 |
| L2, R7 | `reserve` validation; `register` as a separate mode; mode whitelist; `groupLimits` validated (incl. the cross rule), test-only, not wired in `main.ts`; env values validated at startup | 2, 3, 4 |
| L3, R8 | `register` only on `created`, undone on abandon; test at the cap | 5 |
| L4 | README; mostly closed, since every live group needs a create | 6 |
| L5 | No action (aggregate timing only) | - |
| L6, R13 | Done: the bucket keeps the slowest rate and smallest burst until `u` (covers both `maxSessionMinutes` and env mismatches); README notes | 3, 6 |
| L7, R13 | Done: Redis `TIME` for the bucket, `u` and the prune | 3 |
| L8, R14 | Done: `math.ceil` on every TTL and returned number, clamps to `1e13`, no exponent notation in arguments; test at `maxSessionMinutes` 10^7 | 3, 4 |
| L9 | Reset case in the H1 simulation | 4 |
| R2 | Section 3 order (method resolution moved before the lock; it is pure) | 4, 5 |
| R3 | Section 5.1 | 1, 5 |
| R5 | Section 3.1 script steps | 3 |
| R9 | Q-5, `LogCapture` tests | 5 |
| R10 | Section 3 | 4 |

## 10. Implementer model

Implementer model: opus
Security-sensitive abuse limits, a new storage part with a Lua script that
combines a token bucket (with strictest-recent parameters and Redis `TIME`)
and a cap atomically across instances, unit-of-work and abandon handling,
four validated env variables, a wire error code, and more than 3 files.

## 11. Implementation chunks

1. `feat(protocol): add APP_GROUP_LIMIT error code` (protocol, server
   `error-messages.ts`, client `errors.ts`, reader `errors.ts`, their tests)
2. `feat(config): add group creation limit variables` (the `DEFAULT_*`
   values and range bounds in `limits/constants.ts`, the four names in
   `known-vars.ts`, `ServerEnv` fields and `NUMERIC_VARS` in `env.ts`, the
   cross rule, the `docs/startup-errors.md` row, the four README env-table
   rows, `env.test.ts`, `config-matrix.test.ts`, `unknown-vars.test.ts`).
   Parsed only; nothing reads the values yet.
3. `feat(storage): add live-group store with per-app create budget`
   (interface, validation, bucket arithmetic with `r`/`b`/`u` and clamps,
   memory, Redis with `TIME`, keys, script, `endInvalid` ZREM, `Storage`
   wiring, contract tests, multi-instance tests)
4. `fix(server): limit group creation rate per connection`
   (`GroupCreateLimits` built from the env in `server.ts`,
   `appCreateRefillPerMinute` with the H1 inequality tests at the defaults
   and configured extremes and the simulation incl. the reset case,
   per-connection limiter, validated test-only `groupLimits`, method
   resolution moved before the lock and `initialCodes` signature, int tests)
5. `fix(server): enforce per-app create budget and live-group cap`
   (`reserve` in `createLocked`, stored-or-released guard, release in
   `endGroup`, `register` in `recreate`, throttled warnings, int tests incl.
   failure paths, env values in effect, M4 pin, isolation and logs)
6. `docs(server): document group creation limits` (README limits section,
   several-instances notes, residuals, errors, Upgrading; client README;
   `docs/conventions.md` Gate 2 row)

The Gate 2 decisions match the recommendations except Q-2 (env variables);
no option-dependent variants remain.

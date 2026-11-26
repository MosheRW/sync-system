# Security review (plan): #41 shared join-attempt limits

Mode: plan. Reviewed: `docs/issues/41/spec.md`, `docs/issues/41/architecture.md`,
`docs/decisions/0024-join-budget-while-redis-is-unreachable.md` (Proposed),
`docs/issues/35/security.md` section 7 (P2-6, F22), and the current code
(`joins/join-service.ts`, `limits/rate-limiter.ts`, `limits/constants.ts`,
`storage/redis/keys.ts`, `scripts.ts`, `live-groups.ts`, `ws/connection.ts`).

**Verdict: PASS.** No critical or high finding. The plan closes F22 (P2-6)
for the code-guessing budget. Findings S1-S6 are low advisories. Choosing
option 2 of ADR 0024 would add one medium advisory (section 5). The
required controls JB1-JB9 (section 4) join the plan. I check them in code mode.

## 1. Assets and trust boundaries

| Asset / boundary | Notes |
| --- | --- |
| Per-app join budget (600 / 60 s) | The only bound on guessing 6-digit group codes and 8-character codes (F22). It also caps door-code attempts, since every door attempt is a `group.joinByCode`. |
| New key `<prefix>:v1:lj:<ns>` (sorted set) | Lives in the Redis trust zone. It holds the namespace (already in `lg:`/`lb:`), random members and attempt times, and nothing else. |
| `JOIN_BUDGET` Lua script | Runs on the request path of an unauthenticated-to-group input (any client of the app). Every dynamic value goes in `KEYS`/`ARGV`. |
| Instance clocks | The score is the caller's clock. Skew between instances is now a property the security control depends on (S1). |
| Redis availability | The failure mode of a security control (ADR 0024). |

The client is untrusted. The namespace comes from the authenticated app
config (`session.app.namespace`), not from the message. The app's API key
ships in client bundles, so treat "any client of the app" as "anyone".

## 2. Threats (STRIDE, brief)

- **Spoofing / elevation:** none new. Join authorization is unchanged.
- **Tampering:** key or script injection through the namespace. This is
  closed by the `keys.ts` part check and a constant script (JB1).
- **Info disclosure:** codes, tickets or connection IDs stored or logged in
  the new key or its errors. The plan stores none (JB5).
- **DoS:**
  - (a) An attacker spends the shared app budget. This is a global lockout
    of the app's joins, by design (S3).
  - (b) An attacker drives Redis latency to trip a fail-open path back to
    N x budget (ADR 0024, section 5).
  - (c) Refusals cost one script call each. This is bounded by 10 per
    connection per minute and the connection caps.
- **Repudiation:** not relevant. Refusal logs stay namespace-only.

## 3. Findings

No critical, no high, no medium (with ADR 0024 option 1 or 3).

| # | Sev | Location | Issue / scenario | Fix |
| - | --- | --- | --- | --- |
| S1 | Low | architecture "Clock" | Each call prunes with its caller's clock, and `ZREMRANGEBYSCORE` deletes the entries for everyone. An instance whose clock is ahead by `s` removes the other instances' entries `s` ms early, so the global budget loosens by about `s / W`. If `s >= W` (60 s), that instance prunes every entry that peers write and the budget degrades towards N x 600 (today's state, no worse). The plan cites `MAX_CLOCK_SKEW_MS` as the NTP assumption, but that constant is 300 s, five times the window, so it doesn't bound this. Nobody can change a server clock from the network, so this is low. | Operator guide: state that instance clocks must agree well within a second (NTP) and that skew loosens the shared join budget. Optional hardening: when the heartbeat already reads Redis `TIME`, log `clock_skew` (warn, no IDs) when `abs(local - redis)` exceeds 5 s. Keep the `retryAfterMs` clamp `[1, W]` (JB4). |
| S2 | Low | ADR 0024 option 1 text | "Nothing is charged (the script did not run, or ran atomically)" is not exact. On a command timeout the script may have run and charged one attempt while the client gets `1001` (the F23 pattern). That fails conservative and is harmless, but the record should be accurate. | Reword: "at most one attempt is charged; a timed-out script may still have run". No code change. |
| S3 | Low | architecture "Risks", existing #10 AC28 | The shared app budget is a lockout lever. Anyone with the app's (public) key can spend 600 attempts a minute and refuse every legitimate join of that app, now on every instance at once (before: each instance separately). This is the intended single-instance behaviour of #10 AC28, so it's not new risk. | Accept. Keep the once-per-window `join_app_budget_exhausted` warning so operators see it. No change. |
| S4 | Low | architecture "Not in scope", `wrongDoorLimiter` | The per-app wrong-door budget (60/min) stays per instance, so it allows up to 60 x N a minute. Its real bound is lower: every door attempt is a `group.joinByCode` and spends the now-global 600/min join budget, so the effective cap is `min(60 x N, 600)`. Per group, the global rotation after 5 failures and the method A pause still hold. | A follow-up issue is fine, not blocking. Moving it needs the check/compare/record block (N2) to stay atomic, for example a Redis `check` + `record` pair with a reserve-then-refund, so it deserves its own plan. The operator guide's limits table keeps it "Per instance". |
| S5 | Low | operator guide line ~496 / table | `tokens.check` per app (600/min) also stays per instance and multiplies by N. It isn't a guessing bound (tokens are signed), only a load bound. | Keep it listed as per instance in the table. When line ~496 drops "join", keep "token-check". |
| S6 | Low | `JOIN_BUDGET` arguments | `limit` and `windowMs` come from `ARGV` and bound memory (`ZCARD <= limit`) and the TTL. Today the only caller passes constants, but nothing caps them. | Validate in TS before the call (`limit <= 10_000`, `windowMs <= 3_600_000`) as `checkBudget` does for the create budget. The script keeps its positive-integer checks. |

Confirmed with the code:

- **Only the per-app join budget multiplies by N among the join limits.**
  - `joinLimiter` is keyed by `connectionId`. A connection lives on one
    instance, so it is exact.
  - The per-group door failures, rotations and pause are already global
    (`DoorStateStore` in Redis).
  - The spec's "per code/IP bucket" doesn't exist. No IP is read (#35
    P2-8).
  - `wrongDoorLimiter` (S4) and `tokens.check` (S5) also multiply, but
    neither is the code-guessing bound. The join budget caps the wrong-door
    budget.
- **Atomicity.** One script does prune, count, refuse-or-add and expire on
  one key. Redis serializes scripts, so the 601st attempt is refused
  whichever instance gets it.
- **Parity with `SlidingWindowRateLimiter`.**
  - The inclusive `ZREMRANGEBYSCORE -inf (now - W)` equals `time > cutoff`.
  - Only accepted attempts are recorded.
  - The refusal returns the oldest score + W - now.
- **Key-space / memory.**
  - There is one key per configured app. Namespaces come from the server's
    app registry, not from the client.
  - Each key holds at most `limit` (600) members: `ZCARD` is checked before
    `ZADD`, and skew can't add past it.
  - Each key has a TTL of W after its last accepted write, and the refusal
    path repairs a missing TTL.
  - That is about 600 x 30 bytes per busy app: negligible.
- **Privacy.**
  - The key holds the namespace only.
  - Members are 8 random bytes in hex. A collision only undercounts by one,
    which is negligible.
  - Scores reveal join-attempt timing per app for at most 60 s. That is
    acceptable and below the "bounded by E" rule.
  - Nothing new is logged under option 1 or 3.
- **Injection.**
  - The key is built by `keys.ts` with `NAMESPACE_PATTERN`.
  - The script source is constant.
  - The member is checked in TS and in Lua.
- **No fence needed.** The budget is app-scoped. A frozen instance that
  writes late only adds attempts (conservative).

## 4. Required controls (part of the plan)

- **JB1 Key and script.**
  - `keys.appJoinBudget(ns)` is the only way to build the key, with the
    `NAMESPACE_PATTERN` part check.
  - `JOIN_BUDGET` is a constant `LuaScript`. Every dynamic value goes in
    `KEYS`/`ARGV`, and it touches only `KEYS[1]`.
  - No string concatenation of request data in TS or Lua.
- **JB2 Argument validation in the script.**
  - `now` is finite and `>= 0`.
  - `limit` and `windowMs` are positive integers.
  - `member` is exactly 16 chars matching `^[0-9a-f]+$`.
  - Any failure returns `redis.error_reply` (becomes `StorageReplyError`,
    then `INTERNAL_ERROR`).
  - TS caps per S6.
- **JB3 Sliding-log semantics.**
  - Prune is inclusive at `now - W`.
  - Check `ZCARD >= limit` before any write.
  - `ZADD` only on accept, then `PEXPIRE W` on every accept.
  - The refusal path sets `PEXPIRE W` when `PTTL == -1`.
  - Numbers given to Redis are written as integers (for example
    `string.format('%.0f', x)` or the original `ARGV` string). No `%.14g`
    rounding of millisecond times.
- **JB4 Strict reply parse.**
  - The reply is `{'ok'}` or `{'rate', ms}`. `ms` is clamped to `[1, W]`
    in Lua and again in TS, and a non-integer `ms` becomes 1.
  - Anything else throws (no silent accept).
- **JB5 Privacy.**
  - Members come from `crypto.randomBytes(8)` as hex and carry nothing
    else.
  - No code, door code, ticket, connection ID, IP, name or group ID goes
    in the key, members or logs.
  - Errors are logged through `safeErr`, never with the key, member or
    reply.
  - `join_app_budget_exhausted` stays `{event, namespace}`.
- **JB6 Order and no bypass.**
  - The per-connection memory check runs first, then the shared budget.
  - Both run before name or code normalization, the code lookup and the
    QR ticket verify, in `joinByCode` and `joinByQr`.
  - No `catch` in `spendJoinAttempt` or `RedisJoinBudget` lets a failed
    budget step reach the lookup, except what ADR 0024 explicitly decides
    (JB7).
- **JB7 Failure behaviour per the Gate 2 decision on ADR 0024.**
  - Option 1: nothing catches `StorageUnavailableError`, so
    `ws/connection.ts` closes with `1001`. A `StorageReplyError` gives
    `INTERNAL_ERROR`. Neither runs a lookup.
  - Option 3: catch `StorageUnavailableError` from the store only. Every
    other error propagates.
  - Option 2: see section 5.
  - Tests as in the plan, including "no lookup ran" (the spy count).
- **JB8 No production bypass.**
  - `Storage.joinBudget` is set only by `RedisStorage`.
  - No `SyncServerOptions` or env switch to disable or resize it.
  - The memory store path is unchanged.
- **JB9 Docs.** The operator guide states:
  - the per-app join budget is global, and the per-connection one is per
    connection;
  - the ADR 0024 outage behaviour;
  - the clock agreement note (S1);
  - that the wrong-door per-app budget and `tokens.check` stay per instance
    (S4, S5).

## 5. ADR 0024, security view

The partial-failure window is small but attacker-influenced: an attacker who
can raise Redis latency (heavy legitimate-looking load, big documents) can
make the budget script time out more often than the lookups after it.

- **Option 1, fail closed with `1001`: recommended, I agree.**
  - The guessing bound never loosens.
  - One rule for every storage failure (ADR 0014).
  - Clients already back off with full jitter on `1001`, which also takes
    load off a sick Redis.
  - Cost: availability only, in the rare budget-only failure.
- **Option 3, `RATE_LIMITED` with a fixed `retryAfterMs`: acceptable on
  security grounds, not preferred.**
  - It fails closed.
  - The client gets a false "too many attempts" message.
  - Clients retry every ~1 s without jitter while the connection stays
    open, so a struggling Redis gets more script calls.
  - It splits one condition into two signals.
- **Option 2, fail open to the per-instance budget: medium advisory if
  chosen (not blocking).**
  - It brings back F22 (N x 600) under exactly the conditions an attacker
    can cause.
  - It is never worse than 1.0.0 today, which is why it is not high.
  - If the user picks it, these are required:
    - catch only `StorageUnavailableError` from the `JOIN_BUDGET` call,
      never `StorageReplyError`, `KeyPartError` or parse errors;
    - the fallback uses the same 600 / 60 s and the same clock, and is
      never unlimited;
    - fallback entries are never copied to Redis;
    - `join_budget_fallback` warn, `{event, namespace}`, once per window
      per app;
    - a test that the 601st attempt in fallback mode is refused.

## 6. What I will check in code mode

- `storage/redis/scripts.ts` `JOIN_BUDGET`: JB1-JB4, line by line,
  including the inclusive prune, the TTL on every accept and the
  refusal-path repair, integer formatting, and the clamp.
- `storage/redis/keys.ts` `appJoinBudget` and `test/keys.test.ts`
  (invalid namespace throws).
- `storage/redis/join-budget.ts`: strict parse, member generation, no
  logging of key or member, error classes per JB7.
- `joins/join-service.ts`: `spendJoinAttempt` order (JB6), no new catch
  beyond the ADR decision, `warnOnce` fields unchanged, `close` and
  `limiterSize`.
- `storage.ts`, `redis-storage.ts`, `server.ts`, `group-service.ts`
  wiring: no bypass switch (JB8).
- Tests: two-instance sharing (lookup spy stays at 600), parity, TTL,
  skew clamp, privacy dump, the ADR 0024 test for the chosen option, and
  the existing `redis-privacy` and `join-bruteforce` suites unchanged.
- `docs/operator-guide.md` and `docs/conventions.md` per JB9, the ADR
  status and wording (S2).
- Scanners: gitleaks, semgrep and `npm audit` as available. No new
  dependency is expected.

# 0024. Join-attempt budget while Redis is unreachable

- Status: Accepted (Gate 2, 2026-11-26: user chose the recommended option 1)
- Date: 2026-11-26
- Issue: #41

## Context

#41 moves the per-app join-attempt budget (600 attempts per app per minute,
`group.joinByCode` and `group.joinByQr`, any outcome) from process memory to
Redis, so every instance on one prefix shares it (see
`docs/issues/41/architecture.md`). The question is what a join attempt gets
when the Redis step of that budget fails with `StorageUnavailableError`
(connection lost, command timeout, `LOADING`, `BUSY`, ...).

What exists today:

- ADR 0014 (Accepted): a request whose storage step fails closes its
  connection with `1001` ("temporarily unavailable"), and upgrades get HTTP
  503 while the store is `unreachable`. Clients back off and resume. The
  server never falls back to memory for storage.
- In Redis mode a join cannot succeed without Redis anyway: the very next
  step of `group.joinByCode` is the code lookup in Redis, and
  `group.joinByQr` reads the group under its Redis lease. So in a **full**
  outage every option below ends the same way (`1001`). The options only
  differ for a **partial** failure: the budget script alone times out or
  fails while the following commands work (load spikes, a slow script, a
  failover in the middle of the request).
- Other Redis reply errors (`WRONGTYPE`, a script bug) are
  `StorageReplyError`: `INTERNAL_ERROR` to the requester only (security C8).
  This does not change under any option.
- The budget is the code-guessing bound for 6-digit group codes and
  8-character codes (#35 security F22, P2-6).

## Options

1. **Fail closed, as ADR 0014 (recommended).** The budget step's
   `StorageUnavailableError` propagates like any other storage failure: the
   connection closes with `1001` and nothing is looked up. At most one
   attempt is charged: the script is atomic, but a timed-out script may
   still have run and charged the attempt the client never got an answer
   for (fails conservative). No new code path.
   - Pros: one rule for every storage failure; the guessing bound never
     loosens, whatever an attacker can do to Redis latency; nothing to
     configure; the client already treats `1001` as "reconnect with
     backoff". In a full outage the user sees exactly what they see today.
   - Cons: in a partial failure a join that could have worked is refused
     (the client retries after reconnecting). The guarantee "the budget is
     never bypassed" costs a little availability in rare cases.
2. **Fail open to the per-instance budget.** On `StorageUnavailableError`
   from the budget script only, the attempt is charged to an in-memory
   sliding window per instance (today's limiter, same 600 per minute), and
   the join goes on; one `join_budget_fallback` warning per app per minute
   per instance. (Failing open with **no** limit at all is not offered: it
   would remove the guessing bound exactly when Redis is under stress.)
   - Pros: a fault in the budget step alone never blocks joins.
   - Cons: whoever can make Redis slow (load) gets back the N-times
     budget this issue removes; a second limiter and a second code path to
     keep correct and test; in a full outage it changes nothing (the lookup
     still fails), so it buys availability only in the rare partial case.
3. **Fail closed with `RATE_LIMITED`.** Reply `RATE_LIMITED` with a fixed
   `retryAfterMs` (for example 1 s) and keep the connection.
   - Pros: an answer per request; the connection stays open.
   - Cons: contradicts ADR 0014 ("requests that need storage close with
     `1001`"); apps would show "too many join attempts" to a user during an
     outage, which is false; two signals for one condition.

## Recommendation

**Option 1.** The budget is a security control (code guessing); it should
not loosen under exactly the conditions (Redis stress) an attacker can
cause. Joins need Redis right after the budget anyway, so failing open buys
almost no availability, and Option 1 keeps one rule for every storage
failure with no new code.

Trade-off: in the rare case where only the budget step fails, a join that
could have succeeded is refused with `1001`, and the client joins after it
reconnects.

## Decision

Accepted: **option 1**. A `StorageUnavailableError` from the join budget
step propagates like any other storage failure: the connection closes with
`1001`, no code lookup or QR ticket check runs, and at most one attempt is
charged (a timed-out script may still have run). A `StorageReplyError`
stays `INTERNAL_ERROR` to the requester only. No fallback to an in-memory
budget.

## Consequences

- Option 1: no wire protocol change; the operator guide says the join
  budget is global and that a join attempt during an outage closes with
  `1001` like other requests.
- Option 2: the operator guide names the fallback and its warning event;
  the per-instance limiter stays in `JoinService` next to the Redis one.
- Option 3: the protocol notes describe `RATE_LIMITED` as also meaning
  "storage unavailable" for joins.
- Any option: the memory store (one instance, no Redis) is unchanged.

# Security review (plan): #86 stale pubsub probe result can replace a healthy link

Mode: plan. Reviewed: [architecture.md](architecture.md), [spec.md](spec.md),
`apps/sync-server/src/storage/redis/pubsub.ts` (`probe`, `replace`, `reopen`,
`baseline`, `onLinkState`, `close`), `connect.ts` (`bounded`,
`ClientSubscriber.probe`, `openSubscriber`), `redis-storage.ts:173-180`,
`config/redis.ts`, and control C15 / finding F20 in
[#35 security.md](../35/security.md).

**Verdict: PASS.** Critical 0, high 0, medium 0, low 3.

## Assets and trust boundaries
- **Asset:** the at-most-once delivery guarantee (ADR 0012). A stalled
  subscriber link must be found and replaced, so no session keeps running on
  a link that silently loses effects (removed members still attached, missed
  `detach`/leader effects, C14/F19 depend on this).
- **Asset:** availability of every group session on an instance (a replace
  closes all of them with 1001).
- **Boundary:** sync-server to Redis subscriber connection. Redis and the
  network path are partially trusted: they can stall, black-hole or drop.
  No client input, auth, secret, PII, schema or dependency is involved.

## Threats (STRIDE, short)
| | Who / what | Can do | Plan's answer |
|---|---|---|---|
| D | A stalled or slow Redis / network path, with `REDIS_COMMAND_TIMEOUT_MS` above the 5 s heartbeat | Today: several pending PINGs, each late `false` replaces the new healthy link, every session on the instance closed with 1001 again | Fixed: one probe in flight, stale results ignored |
| T/E (of the control) | The fix itself | Weaken C15: a stuck in-flight flag turns stall detection off; ignoring results hides a stall on the current link | Token-scoped flag, cleared in `finally` and by `replace()`/`close()`; stale check compares the captured link with `this.sub` |
| D | A probe or reopen that never settles | Blocks every later tick forever | Every awaited call under the guard is bounded (see below) |
| D | Two ticks with no link | Two subscriber links opened in parallel (connection leak) | `reopen()` runs under the same guard |

## Analysis of the focus points

1. **A genuinely stalled current link is still replaced.** The probed link is
   captured before the `await`; the result is dropped only when that link is
   no longer `this.sub`, or the instance is `closed`, `replacing` or `down`.
   In each of those cases the link is already gone or already being resynced:
   - not current / `replacing`: `replace()` already resynced and opened a new
     link, which is probed on the next tick (flag cleared by `replace()`).
   - `closed`: shutdown, nothing to protect.
   - `down`: `onLinkState('down')` already resynced (link unhealthy). On `up`
     it resyncs again and runs `baseline()`, which itself PINGs the
     subscriber and replaces on failure (`baseline_failed`). A link that stays
     `down` stays unhealthy: fail closed. This matches the existing pre-await
     `if (this.down) return`, so it is not a new gap.
   Test 4 pins detection on every new link.
2. **Rejected probe fails closed.** `sub.probe().catch(() => false)` turns a
   rejection into a failed probe of that link, under the same stale check,
   and removes the unhandled rejection from `void pubsub.probe()`. Test 5.
3. **The flag can't stick.** Cleared in `finally` on every settle path (only
   if the token is still its own), and by `replace()` and `close()`. The
   token check stops an old call's `finally` from clearing a newer probe's
   flag (which would reopen overlap, the original bug).
4. **Skipped ticks can't hide a stall indefinitely.** Every `await` under the
   guard is bounded by a timer in `connect.ts`:
   - `ClientSubscriber.probe()`: `bounded(PING, timeoutMs)` and catches
     (`connect.ts:354-361`), `timeoutMs` is 100 to 30000 ms (`config/redis.ts:19-20`).
   - `reopen()`: `openSubscriber()` is `bounded(connect, connectTimeoutMs)`;
     `subscribe` is bounded; `baseline()` uses the bounded command link and
     the bounded subscriber PING; the error path's `close()` is bounded and
     then `destroy()`s.
   So the longest skip is one probe (at most 30 s) or one reopen (connect
   timeout plus a few command timeouts). Worst-case detection is
   `heartbeat + timeout`, the same as before the fix (the first PING still had
   to time out). While no link exists (`sub === undefined`) or a replace is
   running, `healthy` is false, so skipping never reports a stalled link as
   healthy.
5. **No new DoS / resource issue.** The fix lowers load: at most one
   in-flight tick PING (plus at most one leftover on a just-replaced link,
   which `old.close()` destroys, so it settles at once), and at most one
   tick-driven `reopen()` at a time. No new timers, listeners, queues or
   allocations per message. `baseline()`'s own PING is outside the guard; it is
   bounded and pre-existing, so that's fine.

## Findings
| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | architecture.md "Approach" 3, "Risks" first bullet | The guard's safety rests on an invariant in another file: `SubscriberLink.probe()` (and everything `reopen()` awaits) always settles within a bounded time. A later change to `connect.ts` or a new `SubscriberLink` implementation could drop the bound. Stall detection would then turn off silently on that instance. | Required control RC4: state the contract in the `probe()` doc comment in `pubsub.ts`. Optional later hardening, outside this fast-path fix: a watchdog in `RedisPubSub`, so a tick probe pending longer than `timeout + heartbeat` counts as failed. |
| L2 | Low | architecture.md "Approach" 1 ("no replace, no log") | A stale or ignored probe result leaves no trace, and neither does a rejected `sub.probe()`. Operators can't tell that overlap happened, which matters when `REDIS_COMMAND_TIMEOUT_MS` is set above the heartbeat. | Optionally add a `debug` event (e.g. `pubsub_probe_stale`) with no payload beyond the event name. Never log the error object raw; use `safeErr` if anything. |
| L3 | Low | Docs impact (operator guide "none") | With `REDIS_COMMAND_TIMEOUT_MS` above the 5 s heartbeat, probes now skip ticks, so stall detection takes up to `heartbeat + timeout` (35 s at the max). The behaviour is the same as before, but the operator guide doesn't say it. | Optional: one sentence in the `REDIS_COMMAND_TIMEOUT_MS` row of `docs/operator-guide.md`. Not blocking. |

## Required controls (part of the plan)
- **RC1 Captured-link stale check.** Compare the link captured before the
  `await` with `this.sub` after it. Ignore the result when they differ, or when
  `closed`, `replacing` or `down` is set. Never call `replace()` for a link
  that is not current.
- **RC2 Token-scoped in-flight flag.** A per-call token, set before the first
  `await` (including the `reopen()` branch), cleared in `finally` only if it
  is still the same token. `replace()` and `close()` also clear it.
  **Required test (in addition to tests 1-6):** an old probe that settles after
  `replace()` has cleared the flag and a new probe is in flight on `sub1` must
  not clear the new flag. A further tick must still be skipped (count
  `sub1.probe` calls == 1).
- **RC3 Fail closed on rejection.** A rejected `sub.probe()` counts as
  `false` for that link (subject to RC1), with no unhandled rejection
  (test 5 checks with an `unhandledRejection` listener or vitest's default
  failure on unhandled rejections).
- **RC4 Settle contract documented and kept.** The `probe()` doc comment says
  that `SubscriberLink.probe()` and `reopen()` must settle within a bounded
  time, or stall detection stops. The PR must not change `bounded`,
  `ClientSubscriber.probe`, `openSubscriber` or `baseline` in a way that
  removes a bound.
- **RC5 No weakening of the existing pre-checks.** `closed` / `replacing` /
  `down` early returns and the `sub === undefined` reopen path stay as they
  are. The only new early return is the in-flight skip.
- **RC6 Tests 1 and 3 fail on the pre-fix code.** The engineer records the
  before/after output, as the plan says. The existing
  `multi-delivery.redis.test.ts` stalled-link test still passes (real-link
  stall detection end to end).

## What I will check in code mode
- `pubsub.ts` diff matches the sketch: RC1 to RC5. The token is set before
  any `await`, the `finally` is token-guarded, and `replace()`/`close()` clear
  the flag.
- No changes to `connect.ts` bounds, `redis-storage.ts` tick, timings or
  config defaults.
- `test/pubsub-probe.test.ts` covers tests 1-6 plus the RC2 extra test, is
  deterministic (no real timers), and checks no unhandled rejection.
- No new logging of error objects or payloads. Scanners: gitleaks, semgrep
  on changed files, `npm audit --audit-level=high` (no dependency change
  expected).
- Changeset is patch-level and makes no claims beyond the fix.

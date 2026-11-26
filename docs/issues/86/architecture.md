# Architecture: #86 fix(sync-server): stale pubsub probe result can replace a healthy link

Path: fast. Spec: [spec.md](spec.md). Root cause: [#80 architecture](../80/architecture.md), "Root causes" item 3.

## Repo layout
Monorepo (pnpm workspaces, no submodules). Only `apps/sync-server` is
touched. Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (root), and in
`apps/sync-server`: `npx vitest run` (with `SYNC_TEST_REDIS_URL` set so the
Redis files run, see #80 test plan for the container command).

## Decisions
Decisions: none open.

## The bug
`RedisPubSub.probe()` (`apps/sync-server/src/storage/redis/pubsub.ts:338-347`)
is called on every heartbeat tick (`redis-storage.ts:173-180`):

```ts
if (!(await this.sub.probe())) this.replace('stalled');
```

1. No in-flight guard: when the command timeout is longer than the probe
   interval, several PINGs are pending on the same stalled link.
2. No check after the `await`: the first failure replaces the link; once
   the new link is up (`replacing` false again), each later `false` from the
   **old** link calls `replace('stalled')` on the new, healthy link. Every
   group session on the instance closes with 1001 again.

## Approach
All changes in `RedisPubSub` (`pubsub.ts`). No change to `SubscriberLink`,
`connect.ts`, `redis-storage.ts`, timings or config.

1. **Capture the probed link.** `const sub = this.sub;` before the `await`.
   After it, the result is ignored (no replace, no log) when
   `sub !== this.sub || this.closed || this.replacing || this.down`.
   The same pattern already guards `baseline()` (`pubsub.ts:270`, `:273`)
   and message delivery (`pubsub.ts:235`).
   - `down` after the await: the link dropped meanwhile; `onLinkState`
     already resynced and will re-baseline on `up`. This matches the
     existing pre-check (`if (this.down) return`).
2. **One probe in flight.** New field `private probing: object | undefined`
   holding a per-call token. `probe()` returns at once (skips the tick)
   while `this.probing` is set. The token covers the whole body, including
   the `reopen()` branch when `this.sub` is undefined (so two ticks cannot
   open two subscriber links either).
3. **The flag always clears.**
   - `try { ... } finally { if (this.probing === token) this.probing = undefined; }`
     covers success, failed PING, a timed-out PING (`SubscriberLink.probe()`
     is bounded by the command timeout and returns `false`,
     `connect.ts:354-361`) and a rejection.
   - `replace()` and `close()` set `this.probing = undefined`, so the new link
     is probed on the next tick even if a PING on the old link is still
     pending. The token check stops that old call's `finally` from clearing
     a newer probe's flag.
   - A rejected `sub.probe()` (not expected: the real link catches) is
     treated as a failed probe of that link, under the same stale-link
     check, instead of an unhandled rejection from `void pubsub.probe()`.
     This keeps stall detection fail-closed.

Sketch (the engineer may adjust names, not behaviour):

```ts
async probe(): Promise<void> {
  if (this.closed || this.replacing || this.probing !== undefined) return;
  const token = {};
  this.probing = token;
  try {
    const sub = this.sub;
    if (sub === undefined) { await this.reopen(); return; }
    if (this.down) return;
    const ok = await sub.probe().catch(() => false);
    // A result for a link that was replaced, dropped or closed meanwhile is not this link's.
    if (sub !== this.sub || this.closed || this.replacing || this.down) return;
    if (!ok) this.replace('stalled');
  } finally {
    if (this.probing === token) this.probing = undefined;
  }
}
```

Alternatives rejected:
- *Only the stale-link check, no guard:* fixes the double replace but still
  piles up to `timeout / interval` PINGs (up to 6 at 30 s / 5 s) on a
  stalled link. The guard is one field.
- *Only the guard:* not enough when `replace()` comes from another path
  (`lagging`, `regressed`, `subscribe_failed`) while a probe is pending; the
  late result would still hit the new link (and if `replace()` did not
  clear the flag, the new link would not be probed until the old PING
  settles).
- *Move the guard into `redis-storage.ts`'s interval:* the race is in
  `RedisPubSub`'s state; keeping it there keeps the fix in one file and out
  of `redis-storage.ts`, which #41/#48 may touch.

## Files to create / modify
- `apps/sync-server/src/storage/redis/pubsub.ts`: `probing` token field;
  `probe()` as above; `replace()` and `close()` clear `probing`; doc comment
  on `probe()` states the two rules (one in flight, stale results ignored).
- `apps/sync-server/test/pubsub-probe.test.ts` (new): unit tests with a fake
  subscriber link whose `probe()` returns test-controlled deferred promises.
  Copy the small `FakeSub` / `deferred` / `tick` / `setup` harness from
  `test/pubsub-sequence.test.ts` (do not edit that file or extract a shared
  helper, to keep the diff away from parallel work).
- `.changeset/pubsub-probe-race.md` (new): patch changeset for
  `@mosherw/sync-system-server`.

Not touched (parallel work): `test/main-redis.redis.test.ts`,
`test/multi-process.redis.test.ts` (#87), `test/multi-delivery.redis.test.ts`,
`redis-storage.ts`, `connect.ts`, `docs/roadmap.md`.

## Contracts
No API, protocol, message, config or schema change. Observable change only
in the failure case: one `pubsub_link_lost{cause:'stalled'}` and one resync
per stalled link instead of several.

## Docker impact
Docker impact: none.

## Docs impact
- `.changeset/pubsub-probe-race.md` (patch, server): a stalled pub/sub link
  now costs one resync even with `REDIS_COMMAND_TIMEOUT_MS` above the 5 s
  heartbeat; before, late probe results could close every session on the
  instance again.
- `docs/operator-guide.md`: none (it does not describe probe overlap; the
  `REDIS_COMMAND_TIMEOUT_MS` row stays correct).

## Risks / edge cases
- **Stuck flag = stall detection off.** If `SubscriberLink.probe()` never
  settled, the guard would skip every later tick. Mitigations: the real link
  bounds the PING by the command timeout and catches (`connect.ts:354-361`,
  `bounded` at `:307-319`); `replace()`/`close()` clear the flag; a test
  covers each settle path. The engineer must not remove the bound.
- **Longer detection with long timeouts:** with one probe in flight, a stall
  is found after at most `interval + timeout` (it was the same before: the
  first PING still had to time out). No change at defaults.
- **`reopen()` under the guard:** a slow reopen (subscribe + baseline, each
  bounded) skips ticks meanwhile. Intended: no second link is opened.
- **`leave()`/`rejoin()` during a probe:** same `sub` object, so the result
  still counts. Correct: the PING checks the connection, not the channel.
- **Link `down` during a probe:** the late `false` is ignored; the `down`/`up`
  path already resyncs and re-baselines. Before the fix it replaced as well;
  this removes one more extra resync, it does not hide a stall (a link that
  comes back `up` is probed again on the next tick).

## Security
Security-sensitive: yes
- Area: the subscriber-link stall detection control (security C15/F20,
  `RedisPubSub.probe()`), part of the at-most-once delivery guarantee
  (ADR 0012): a stalled link must be found and replaced so no session keeps
  running on a link that silently lost effects.
- The change narrows when a failed probe replaces the link. It must not
  weaken detection: a genuinely stalled **current** link is still replaced
  exactly once (test 4), a rejected probe still counts as failed, and the
  in-flight flag cannot stay set (tests 3 and 5).
- Availability (DoS-ish): removes a path where one stalled link causes
  repeated mass 1001 closes on an instance.
- No input handling, auth, secrets, crypto, PII, schema or dependency change.

## Implementer model
Implementer model: opus
Security-sensitive (C15/F20) async-race fix; the reasoning about which
settle/replace interleavings may clear the flag needs care, even though the
change is small and in one file.

## Test plan
New file `apps/sync-server/test/pubsub-probe.test.ts`, deterministic (no
real timers): each `FakeSub.probe()` returns a deferred the test resolves,
which models "command timeout > probe interval" exactly (the next tick
fires while the previous PING is pending). It is the same interleaving as
the old fast timings of the stalled-link test (150 ms ticks, 500 ms
timeout), without the flakiness of a timing-based Redis test.

| # | Test | AC |
|---|---|---|
| 1 | **Overlapping ticks on a stalled link, double replace.** Start; `sub0.probe` returns pending deferreds. Call `probe()` twice (two ticks). Resolve the first `false` → link replaced, `sub1` subscribed and healthy. Resolve the second `false`. Expect: `resyncs === 1`, one `pubsub_link_lost`, `subs.length === 2`, `sub1` not closed, `healthy`. **Must fail on the pre-fix code** (2 resyncs, 3 links). | AC1, AC2, AC4 |
| 2 | **Skip while in flight.** Two `probe()` calls while the first PING is pending: `sub0.probe` is called once (count calls on the fake). | AC2 |
| 3 | **Stale result after a replace from another path.** A probe is pending on `sub0`; the link is replaced by `regressed` (emit a high then a far lower sequence, as in `pubsub-sequence.test.ts`). The next tick probes `sub1` (flag cleared by `replace()`). Resolve the old `sub0` PING `false`. Expect one resync, `sub1` kept. **Must fail on the pre-fix code.** | AC1, AC3 |
| 4 | **Genuine stall still detected, exactly once.** `sub0.probe` resolves `false` → one replace; later ticks on `sub1` answering `true` do nothing; then `sub1.probe` resolves `false` → replaced again (second resync, `sub2`). Detection works on every new link. | AC5 |
| 5 | **Flag clears on every settle path.** After a probe that resolves `true`, one that resolves `false`, and one whose `probe()` rejects: the next tick calls `probe()` on the current link again. The rejection counts as a failed probe (one replace) and produces no unhandled rejection. | AC3 |
| 6 | **Close during a probe.** `close()` while a PING is pending, then resolve it `false`: no resync, no new link opened. | AC1 |

Before/after proof: the engineer runs tests 1 and 3 against the unchanged
`pubsub.ts` (e.g. `git stash push -m 86-prefix -- apps/sync-server/src/storage/redis/pubsub.ts`
with the SHA-based apply/drop rules, or a scratch copy) and records the
failing output in `STATE.md` → Deviations/notes and the PR; they are not
committed failing.

Regression: `apps/sync-server` full `npx vitest run` with
`SYNC_TEST_REDIS_URL` set (including the unchanged
`multi-delivery.redis.test.ts` stalled-link test and
`pubsub-sequence.test.ts`), plus `pnpm lint`, `pnpm typecheck`, `pnpm build`.
Failures in `main-redis.redis.test.ts` / `multi-process.redis.test.ts`
under load are #87's, noted not fixed.

## Implementation chunks
1. `fix(sync-server): ignore stale pubsub probe results and skip overlapping probes`
   (`pubsub.ts`)
2. `test(sync-server): cover overlapping and stale pubsub probes`
   (`test/pubsub-probe.test.ts`)
3. `chore(release): add a patch changeset for #86`
   (`.changeset/pubsub-probe-race.md`)

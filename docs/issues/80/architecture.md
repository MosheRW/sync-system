# Architecture: #80 test: make load-sensitive tests stable under machine load

Path: fast. Spec: [spec.md](spec.md).

## Repo layout
- Layout: `monorepo` (pnpm workspaces `apps/*`, `packages/*`; no submodules).
- Touched package: `apps/sync-server` (`@mosherw/sync-system-server`), three
  test files only. No product code, no test helper, no config.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (root).
  Redis suites need `SYNC_TEST_REDIS_URL` (see Test plan).
- Not touched (owned by #78, branch `fix/78-sync-server-flaky-tests`):
  `main.test.ts`, `redis-startup.test.ts`, `release-files.test.ts`,
  `apps/sync-server/vitest.config.ts`.

## Decisions
Decisions: none open.

## How the evidence was gathered
Measured in this worktree on 2026-11-25 (Windows 11, 8 threads, Vitest
4.1.12) against Redis 7.2.17 in Docker with CI's flags and password
(`redis://:ci-only-redis-password@127.0.0.1:6391`). "Stress" means the three
files (or a diagnostic copy of a test) run while a full `apps/sync-server`
`vitest run` and a full `apps/reader` `vitest run` run at the same time. The
diagnostic test file was temporary and is not committed.

## Root causes (with evidence)

### 1. `redis-privacy.redis.test.ts` AC24: a lease key is released between the scan and `PTTL` (reproduced)
- **Reproduced, even without load** on this machine: 2 of 6 quiet runs of
  the test alone, 2 of 6 stress runs. Always the same message:
  `t…:v1:lock:app-a:<groupId>: expected -2 to be greater than 0` at
  `redis-privacy.redis.test.ts:130`.
- The loop (`redis-privacy.redis.test.ts:128-136`) lists keys with
  `inspect.keys(prefix)`, which is a `SCAN` (`test/helpers/redis.ts:55-60`;
  the spec says `KEYS`, the effect is the same), then sends one `PTTL` per
  key. The two are not atomic.
- The test waits for `leader.offline` on the member
  (`redis-privacy.redis.test.ts:126`), but that message is sent *before* the
  group's lease is released:
  - `GroupLock.runTask` commits, then flushes the outbox, which sends
    `leader.offline` (`src/groups/group-lock.ts:208-218`).
  - Only after `runTask` returns does `run` release the lease in its
    `finally` (`src/groups/group-lock.ts:167-171`), a compare-and-delete
    (`LEASE_RELEASE`, `src/storage/redis/scripts.ts:426-429`) on
    `<prefix>:v1:lock:<ns>:<groupId>` (`src/storage/redis/keys.ts:108-110`).
  - So the scan can see the lease, the `DEL` lands, and `PTTL` returns `-2`
    ("no such key"). That is a race in the test, not a missing TTL: the
    lease is always set with `PX` (`src/storage/redis/lease-lock.ts:65-72`).
- Only `:lock:` keys are transient at that point (the test runs on a
  `ManualScheduler`, so no timer task can run). No other key vanished in any
  run.

### 2. `heartbeat.test.ts` "heartbeat on real sockets": helper waits add up to more than the 5 s default (not reproduced)
- **Not reproduced**: the three real-socket tests took 108-307 ms alone and
  112-468 ms under stress, in 6 stress runs.
- The reported failure was a Vitest 5 s *test timeout*, not one of the
  helpers' own descriptive errors. The block (`heartbeat.test.ts:118-161`)
  has no test timeout, so it gets Vitest's default 5 s, while one test's
  helper waits are each bounded on their own, and their bounds add up to
  more than 5 s:
  - `RawClient.connect` upgrade: up to 3 000 ms (`test/helpers/raw-client.ts:156-159`),
  - `waitForType('hello.ok')`: up to 2 000 ms (`test/helpers/raw-client.ts:277`),
  - `waitUntil(… total === 0, 2000)`: up to 2 000 ms (`heartbeat.test.ts:144`, `:156`),
  - plus `startTestServer` and server close.
  Under heavy CPU contention (the reported run had a security review running
  in parallel) each step can take a large part of its own bound without
  failing, and the sum passes 5 s. Vitest then kills the test before any
  helper can report which step was slow.
- This is the same class as #78 (the per-test budget is below what the
  test's own waits allow), not a logic error in the heartbeat.

### 3. `multi-delivery.redis.test.ts` "a stalled subscriber link is found by its probe and replaced": stale probe results replace the new link again (reproduced, root-caused)
- **Reproduced**: a diagnostic copy of the test, run 8 times per pass,
  failed 7/8 under stress, 3/8 when it ran inside a stressed full suite, and
  1/8 alone. The real test also failed in a stressed full suite
  (`× … replaced (C15, F20) 1399ms`). Failures were
  `socket closed while waiting for group.joined`,
  `socket closed while waiting for position.updated` (the message QA saw on
  PR #75), and once `unexpected response 503` on the upgrade.
- **B's logs in every failure show the link replaced 2 or 3 times**, e.g.
  `pubsub_link_lost(stalled) pubsub_resync ws_closed pubsub_link_lost(stalled) pubsub_resync pubsub_link_lost(stalled) pubsub_resync ws_closed`.
  Every passing run shows exactly one.
- Mechanism:
  - The probe timer fires every `timings.heartbeatMs`
    (`src/storage/redis/redis-storage.ts:172-180`), which is **150 ms** in
    the test cluster (`test/helpers/cluster.ts:16-25`).
  - Each probe is a `PING` bounded by the command timeout
    (`src/storage/redis/connect.ts:354-361`, `bounded` at `:307-319`), which
    is **500 ms** in the test cluster (`test/helpers/cluster.ts:69`).
  - `RedisPubSub.probe()` (`src/storage/redis/pubsub.ts:338-347`) has no
    in-flight guard and does not check, after its `await`, that the link it
    probed is still the current one:
    `if (!(await this.sub.probe())) this.replace('stalled');`
  - So with a stalled link, up to 4 probes are in flight on it. The first to
    time out calls `replace('stalled')` (`pubsub.ts:366-378`), which closes
    the sessions with 1001 and opens a new link. The others time out 150,
    300, 450 ms later. Once the new link is up, `replacing` is false again,
    so each stale `false` calls `replace('stalled')` on the **new, healthy**
    link, which closes every B session again, including the test's `again`.
- Why it passes on a quiet machine: the test's whole tail (reconnect,
  `connectReady`, `group.resume`, the move) finishes in 30-60 ms after the
  first replace, before the first stale probe result at +150 ms (measured
  `closed@668 … moved@712`). Under load the tail takes longer than 150 ms
  (`closed@820 connected@856 ready@862` then closed), and the stale replace
  hits it.
- **This is a product race, but the test cluster's timings are what expose
  it.** In production the probe interval is `INSTANCE_HEARTBEAT_MS = 5 000`
  (`src/limits/constants.ts:315`) and the default command timeout is
  `2 000` (`src/config/redis.ts:15`), so a probe always finishes before the
  next one starts and the race can't happen. It can happen only if an
  operator sets `REDIS_COMMAND_TIMEOUT_MS` above 5 000 (allowed up to
  30 000, `src/config/redis.ts:20`): then a stalled link costs two or more
  resyncs instead of one. See Open questions.

## Approach
No assertion removed, no retries, no global timeout change, no product code.

1. **AC24, tolerate only a vanished lease key.** In the loop at
   `redis-privacy.redis.test.ts:128-136`, right after `const ttl = await
   inspect.client.pTTL(key);`, skip the key when `ttl === -2 &&
   key.includes(':lock:')`, with a two-line comment: the group's lease is
   released just after `leader.offline` is sent (`group-lock.ts`), so it can
   vanish between `SCAN` and `PTTL`. Every key that still exists keeps
   `ttl > 0` and its bound. A lease that still exists is still bounded by
   `end`. Any other key that returns `-2`, or any key with `-1` (no TTL),
   still fails. This is narrower than the spec allows (it allows any `-2`),
   on purpose: only the lease was ever seen to vanish.
2. **Heartbeat, explicit block timeout.** Give
   `describe('heartbeat on real sockets', …)` the option `{ timeout: 15_000 }`
   (Vitest's describe options; per-test `{ timeout }` is the pattern in
   `test/restart-process.int.test.ts:87`, `test/multi-process.redis.test.ts:83`).
   15 s is above the sum of the helper bounds (about 7 s plus start/close),
   so a slow step now fails with the helper's own message (`timed out waiting
   for dead peer terminated`, `raw upgrade timed out`) instead of an anonymous
   5 s timeout. The unit tests in the first `describe` keep the default.
   One comment line names #80 and the reason. No wait, interval or
   assertion changes.
3. **Stalled link, production probe ratios in this test only.** In
   `multi-delivery.redis.test.ts:374-392`:
   - start the cluster with
     `startCluster({ redisTimings: { ...FAST_TIMINGS, heartbeatMs: 1_500, selfFenceMs: 3_000, livenessMs: 4_500 } })`
     (import `FAST_TIMINGS` from `./helpers/cluster.js`). `redisTimings`
     replaces `FAST_TIMINGS` as a whole (`cluster.ts:96-98`), hence the
     spread. This keeps production's ratio heartbeat : self-fence :
     liveness = 1 : 2 : 3 (`constants.ts:311-321`) and makes the probe
     interval (1 500 ms) three times the command timeout (500 ms), like
     production's 5 000 vs 2 000: at most one probe is ever in flight.
   - then `await cluster.converged();` (existing helper, `cluster.ts:40-47`):
     with a 1.5 s heartbeat, each instance must have the other in its
     live-instance cache before the group starts, which 150 ms used to give
     almost for free.
   - **add** one assertion at the end: B logged exactly one
     `pubsub_link_lost`, e.g.
     `expect(b!.ts.logs.records().filter((r) => r.event === 'pubsub_link_lost')).toHaveLength(1);`
     This makes the test say what its title says (found once, replaced once,
     the replacement stays), and it fails loudly if the stale-probe race
     ever comes back in this configuration.
   - Everything else stays: `connections === 2`, the stall of connection 1,
     the 1001 close, `cause: 'stalled'`, the `waitUntil(connected, 5_000)`,
     the resume and the delivered move. The file's `testTimeout: 30_000`
     (`multi-delivery.redis.test.ts:27`) covers the slower detection (about
     2 s) and `converged()` (about 3 s).
   - **Verified before planning** with the diagnostic copy: 24/24 passes
     with these timings (8 quiet, 16 under stress), each run logged exactly
     one `pubsub_link_lost(stalled)`, against 11 failures in 24 with the
     current timings.

### Alternatives rejected
- **Fix `RedisPubSub.probe()` (capture the link, ignore a result for a
  replaced link, skip a tick while a probe is in flight).** It is the real
  fix for the product race, but it is product code, which the spec puts out
  of scope, and it changes a security control (C15/F20 stall detection)
  that deserves its own issue and security review. Proposed as a follow-up
  (Open questions). With it in place, this test would pass with the old
  timings too; the plan's timings stay valid either way.
- **Raise `commandTimeoutMs` or lower it below 150 ms for the test.** Higher
  makes more probes overlap (worse). Lower (minimum 100 ms) makes every
  command on the loaded machine time out.
- **Longer `next()` timeouts or a retry around the resume.** The socket is
  *closed*, not slow; waiting longer changes nothing, and a retry would hide
  the double replace.
- **AC24: wait until no `:lock:` key exists before scanning.** Also
  deterministic, but the lease would then never be checked at all; the skip
  keeps checking it whenever it is still there.
- **AC24: tolerate `-2` for every key** (what the spec allows). Broader than
  the evidence needs.
- **Raise `testTimeout` in `vitest.config.ts`.** Owned by #78 and global.

## Files to modify
- `apps/sync-server/test/redis-privacy.redis.test.ts`: skip a `:lock:` key
  whose `PTTL` is `-2` in the AC24 loop, with a comment.
- `apps/sync-server/test/heartbeat.test.ts`: `{ timeout: 15_000 }` on the
  "heartbeat on real sockets" block, with a comment.
- `apps/sync-server/test/multi-delivery.redis.test.ts`: production-ratio
  timings and `converged()` in the stalled-link test, plus the
  exactly-one-`pubsub_link_lost` assertion and a comment pointing at the
  stale-probe race.

No product code, schema, contract, dependency, helper or config changes.
Docker impact: none.

## Overlap with PR #75 (#47, `fix/47-live-group-limits`, not merged)
`git diff origin/main...origin/fix/47-live-group-limits -- '*redis-privacy*'`
adds 9 lines (a comment and two `pExpireTime` assertions on `lb:app-a` /
`lg:app-a`) right **after** the loop's closing brace (after current line
136). This plan inserts 3-4 lines **inside** the loop, after line 129. The
hunks don't overlap, so git should merge either order without a conflict;
if the context lines collide, keep both changes. The new assertions read
`pExpireTime` on keys that are not leases and exist at that point, so the
race in this plan doesn't affect them. Whichever PR merges second should
re-run the AC24 test once.

## Docs impact
Docs impact: none. Only three test files change. No setup, script, env
variable, protocol, convention or operator behaviour changes (running the
Redis suites with `SYNC_TEST_REDIS_URL` is already how CI does it,
`.github/workflows/ci.yml:66`).

## Risks / edge cases
- **AC24 skip could hide a missing lease TTL?** No: a lease without a TTL
  returns `-1`, not `-2`, and still fails `ttl > 0`.
- **Heartbeat "keeps a client that answers pings"** (`heartbeat.test.ts:133-138`,
  40 ms interval, client and server in one event loop) could in theory see
  a loop stall longer than one interval and terminate a healthy client.
  Never observed (it is not the reported failure); not changed. If the
  stress runs show it, report it as a deviation, don't bump numbers.
- **Stalled-link test is slower**: about 5-6 s instead of about 1 s.
- **The exactly-one assertion** could only fail if a healthy link's `PING`
  took over 500 ms under load (a genuine false "stalled"). It never did in
  24 runs; if it shows up in the stress plan, report it rather than
  dropping the assertion.
- **Other load-flaky tests seen during the stress runs, out of scope here**
  (see Open questions): `main-redis.redis.test.ts` "the process exits 1
  after a Redis failure while starting (AC4)" (child killed by the 30 s
  spawn timeout, `SIGTERM`), `multi-process.redis.test.ts` "a killed
  process's clients reconnect…" (`server did not start`), and
  `redis-storage-contracts` R13 (`test/contracts/state.ts:421`), which
  PR #75's commit `968e47b` already changes. The #78 files also failed, as
  expected.

## Security
Security-sensitive: no
Test-only changes to three test files; no auth, input handling, user data,
secrets, crypto, schema or dependency changes. The stall-detection control
(security C15/F20) is still tested end to end and gets one stricter
assertion. The product race found in `RedisPubSub.probe()` is not fixed
here; it is reported as a follow-up.

## Implementer model
Implementer model: sonnet
Three small test-file edits with exact lines and code given above, following
existing patterns (`{ timeout }` options as in
`test/restart-process.int.test.ts:87`, `startCluster` options and
`converged()` as in the other `multi-*.redis` tests), root causes already
proven, no open decisions, not security-sensitive.

## Test plan
Redis for local runs, same as CI (`.github/workflows/ci.yml:45-50`, `:66`):
```
docker run -d --rm --name issue80-redis -p 127.0.0.1:6391:6379 \
  redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335 \
  redis-server --requirepass ci-only-redis-password --save "" --appendonly no \
  --maxmemory-policy noeviction
export SYNC_TEST_REDIS_URL=redis://:ci-only-redis-password@127.0.0.1:6391
```
(Exactly `SYNC_TEST_REDIS_URL`: a wrong name silently skips the 22 Redis
files. Check that the run reports the Redis tests as run, not skipped.)

| AC | How it is shown |
|---|---|
| AC24 tolerates a vanished key, bound kept for existing keys | Before the change, `npx vitest run test/redis-privacy.redis.test.ts -t AC24` 10 times: expect some `-2` failures on a `:lock:` key (2/6 here). After: 10/10 pass. Negative check, not committed: temporarily make the skip apply to nothing (e.g. `':lockX:'`) and see the old failure come back; temporarily `PERSIST` one group key in the test before the loop and see `ttl > 0` fail. |
| Heartbeat passes under load | Block option visible in the diff; the three real-socket tests pass in every stress round below. No `expect`, wait or interval changed. |
| Stalled link passes under load, not weakened | Stress rounds below, plus the test alone 10 times. The diff keeps every existing `expect` and adds the exactly-one assertion. |
| Reliable across repeated runs with two suites in parallel | **Stress procedure**, at least 3 rounds: start `cd apps/sync-server && npx vitest run` and `cd apps/reader && npx vitest run` in the background, then run `cd apps/sync-server && npx vitest run test/heartbeat.test.ts test/redis-privacy.redis.test.ts test/multi-delivery.redis.test.ts` 3 times in the foreground while they run. All three target tests must pass in every foreground run **and** inside the background full sync-server run. Record results in `STATE.md`. Failures of the #78 files or the out-of-scope tests listed in Risks are noted, not fixed. Before the change this procedure failed the AC24 test in 3 of 6 foreground runs and the stalled-link test in the background suite. |
| No weakening beyond the allowed | `git diff origin/main -- apps/sync-server/test` shows only: the `:lock:` `-2` skip, the block timeout, the cluster timings/`converged()`, and one added assertion. |
| lint, typecheck, test, build | `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `SYNC_TEST_REDIS_URL` set), `pnpm build`. |
| No deps, no product code | `git diff origin/main --stat` lists only the three test files and `docs/issues/80/`. |

## Implementation chunks
1. `test(server): skip a lease key released during the AC24 ttl scan`
   (`redis-privacy.redis.test.ts`)
2. `test(server): give the real-socket heartbeat tests an explicit timeout`
   (`heartbeat.test.ts`)
3. `test(server): probe the stalled link at production timing ratios`
   (`multi-delivery.redis.test.ts`, including the exactly-one assertion)

No docs chunk (Docs impact: none). Commits carry only the `Refs: #80`
trailer (orchestrator decision for this issue).

## Open questions
- **Follow-up fix issue for the product race** in `RedisPubSub.probe()`
  (`src/storage/redis/pubsub.ts:338-347`): a probe result for a link that
  was already replaced replaces the new link again (an extra resync, all
  the instance's group sessions closed with 1001 a second time). Reachable
  in production only with `REDIS_COMMAND_TIMEOUT_MS` above 5 000. Suggested
  fix: compare the probed link to `this.sub` after the `await`, and skip a
  tick while a probe is in flight. Touches security control C15/F20, so it
  should get a security plan review. Recommend the orchestrator open it.
- **Other load-flaky tests outside #78 and #80** seen in the stress runs:
  `main-redis.redis.test.ts` AC4 and `multi-process.redis.test.ts` (both
  spawn server processes and hit their 30 s bounds under stress). Not in
  this spec; a follow-up issue or an addition to #78 is the user's call.

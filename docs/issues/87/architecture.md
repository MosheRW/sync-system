# Architecture: #87 test(sync-server): main-redis AC4 and multi-process reconnect tests flaky under load

Path: fast. Spec: [spec.md](spec.md). Approach reused from #80
([architecture](../80/architecture.md)): measure, root-cause, then fix only
the bound the evidence shows is wrong, with an explicit, justified number.

## Repo layout
- Layout: `monorepo` (pnpm workspaces `apps/*`, `packages/*`; no submodules).
- Touched package: `apps/sync-server` (`@mosherw/sync-system-server`): two
  test files and one test helper. No product code, no vitest config.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (root).
  Redis suites need `SYNC_TEST_REDIS_URL` (see Test plan).

## Decisions
Decisions: none open.

## How the evidence was gathered
Measured in this worktree on 2026-11-26 at `8dd503c` (Windows 11, 8 threads,
Vitest 4.1.12, Node via tsx) against Redis 7.2.17 in Docker with CI's image
digest, flags and password (`redis://:ci-only-redis-password@127.0.0.1:6393`,
same as `.github/workflows/ci.yml:45-50`, `:66`). "Stress" = a full
`apps/sync-server` `vitest run` and a full `apps/reader` `vitest run` in the
background while the foreground runs. A temporary diagnostic test (not
committed, deleted) spawned the same children the two tests spawn, with the
same env, and timestamped every log line the child wrote, with a 120 s bound
instead of 30 s.

| Run | Child start → exit / `server_listening` | of which before `redis_connected` |
|---|---|---|
| Quiet, AC4 child (3 runs) | 6.1 / 7.4 / 8.3 s, then `exit 1` | 5.8 / 7.1 / 8.0 s |
| Quiet, multi-process pair (3 × 2) | 6.1 to 9.7 s | 5.9 to 9.3 s |
| Stress, AC4 child (5 runs) | **32.1 / 35.0 / 47.2 / 44.1 / 40.9 s**, then `exit 1` | 30.4 to 45.9 s |
| Stress, multi-process pair (5 × 2) | **29.4 to 41.1 s** | 28.4 to 40.1 s |

Plus, quiet: `node --import tsx -e 0` takes 0.9 s, and
`node --import tsx -e "await import('./src/main.ts'); …connect.ts; …redis-storage.ts"`
takes **6.3 to 8.7 s**: loading the server's source graph through tsx is
almost the whole start time.

The real tests, unchanged, under stress:
- Round 1 (background full suite): `multi-process` failed with
  `Error: server did not start` at 30 149 ms.
- Round 2 (foreground run of both files, and the background full suite):
  both failed in both runs, with exactly the issue's messages:
  `AssertionError: expected 'SIGTERM' to be null` (AC4, 30.6 s) and
  `Error: server did not start` (multi-process, 30.1 s).
- Both pass quietly (AC4 test 3.9 s, multi-process 4.0 s).

## Root causes (with evidence)

### 1. `main-redis.redis.test.ts` "the process exits 1 after a Redis failure while starting (AC4)": load/timing, not a product bug (reproduced)
- The test `spawnSync`s `node --import tsx src/index.ts` with
  `timeout: 30_000` (`main-redis.redis.test.ts:181-195`). When the bound
  passes, Node sends `SIGTERM`, so `child.signal` is `'SIGTERM'` and the
  first assertion (`:196`) fails.
- Under stress the child needed 32 to 47 s (table above). **All but about
  1 s of it is before the first log line** (`redis_connected`), i.e. node
  start plus tsx compiling and loading the server's modules. That is a test
  harness cost: production runs the compiled build (`dist`), not tsx.
- The child is not hung: in every run (quiet and stress) it printed
  `Startup error: Redis authentication failed (REDIS_URL)` and exited with
  status 1 within 50 to 180 ms of that line. So the close path in
  `src/main.ts:104-114` (`server.close()` closes the Redis link, nothing
  keeps the process alive, `src/index.ts:15-16` sets `exitCode`) works under
  load; the in-process twin test (`main-redis.redis.test.ts:139-175`) also
  passed in every stress run.
- The product's own timeouts are not involved: the connect timeout
  (`DEFAULT_REDIS_CONNECT_TIMEOUT_SECONDS = 10`, `src/config/redis.ts:14`)
  starts only when `connectRedis` runs, after the slow module load, and the
  whole post-boot phase took at most 2.1 s under stress.

### 2. `multi-process.redis.test.ts` "a killed process's clients reconnect…": load/timing, not a product bug (reproduced)
- `startProcess` rejects with `server did not start` when the child has not
  logged `server_listening` within 30 000 ms (`multi-process.redis.test.ts:42`).
  The test starts two children at once (`:105`), which doubles the boot
  work at the worst moment.
- Under stress each child of the pair needed 29.4 to 41.1 s to
  `server_listening`, again almost all of it before `redis_connected`;
  `redis_connected → instance_registered → startup_sweep → server_listening`
  took 0.5 to 2.1 s. Same cause as 1: tsx boot under CPU contention.
- Nothing after startup failed in any run (reconnect, `group.resume`, the
  delivered move).

### Not #86 (stale pubsub probe race)
Neither failure reaches the probe. The probe timer is armed only after
`pubsub.start()` in `RedisStorage.start` (`src/storage/redis/redis-storage.ts:166-180`).
The AC4 child fails at `epoch.current()` (the `GET` its Redis user lacks),
before that; the multi-process child had not even logged `redis_connected`
when the 30 s bound hit. `pubsub.ts` is not touched (PR #94 fixes #86).

## Approach
No assertion removed or loosened, no retries, no skips, no vitest config
change, no product code. Only the bound on the spawned child's start is
raised, to a named, documented value, and each test's own timeout is set
above it so a slow child still fails with the test's clear message.

1. **Shared child start bound.** In `apps/sync-server/test/helpers/child-env.ts`
   (already imported by both tests) export
   `export const CHILD_START_MS = 120_000;` with a doc comment saying:
   how long a spawned `node --import tsx src/index.ts` may take to start
   (or fail to start); tsx loads the whole source tree in each child: 6 to
   10 s quiet, up to 47 s with the sync-server and reader suites in
   parallel (#87); production runs the compiled build, so this is a harness
   bound, not a server startup budget. 120 s is about 2.5 times the worst
   start measured.
2. **AC4 process test** (`main-redis.redis.test.ts:177-204`):
   - `spawnSync(..., { timeout: CHILD_START_MS })` instead of `30_000`.
   - test timeout `CHILD_START_MS + 30_000` instead of `60_000` (the
     `spawnSync` blocks the worker, so the Vitest timeout can only fire
     after it returns; the extra 30 s covers the ACL user setup and removal).
   - All five `expect`s stay as they are, including `child.signal` null.
     A child that really hangs still gets `SIGTERM` at the bound and fails
     the same assertion.
3. **Multi-process test** (`multi-process.redis.test.ts`):
   - `startProcess`'s timer (`:42`) uses `CHILD_START_MS`; the message stays
     `server did not start`.
   - test option `{ timeout: CHILD_START_MS + 60_000 }` instead of
     `90_000`: both children start in parallel inside one bound, the
     remaining 60 s covers the rest of the test (every step after start is
     bounded on its own: `TestClient.next` 2 s default,
     `test/helpers/test-client.ts:99`).
   - No other change; every `expect` stays.
4. One comment line at each changed bound: `// #87: see CHILD_START_MS.`

### Production timing ratios (as in #80)
Not applicable here: no product timing is involved in either failure. The
children already run with production defaults (`NODE_ENV=production` for the
multi-process pair, default connect and command timeouts), and those were
never close to their limits.

### Alternatives rejected
- **Spawn the compiled `dist` build instead of tsx** (production-like, boots
  much faster). `pnpm test` runs before `pnpm build` in CI
  (`ci.yml:61-80`) and locally it would test a stale build. Changes how the
  tests run; out of proportion.
- **Warm the tsx cache in a `beforeAll`.** tsx already caches transforms on
  disk; the quiet 6 to 9 s is mostly module loading, and under contention
  it still scales with load. Does not remove the load sensitivity.
- **Run the spawning files serially** (Vitest `poolMatchGlobs`,
  `fileParallelism`, `maxWorkers`). Shared `vitest.config.ts`, coordinated
  with #78, and slows every run. Not needed.
- **Retry the spawn.** Hides a real hang if one ever appears.
- **Convert `spawnSync` to async `spawn`** in the AC4 test. Works, but a
  larger change for no gain; `spawnSync` with an explicit bound is the
  existing pattern (`main.test.ts:260-276`).

## Files to modify
- `apps/sync-server/test/helpers/child-env.ts`: export `CHILD_START_MS`
  (120 000) with the evidence comment.
- `apps/sync-server/test/main-redis.redis.test.ts`: AC4 process test uses
  `CHILD_START_MS` for `spawnSync` and `CHILD_START_MS + 30_000` as its
  test timeout.
- `apps/sync-server/test/multi-process.redis.test.ts`: `startProcess` uses
  `CHILD_START_MS`; test timeout `CHILD_START_MS + 60_000`.

No product code, schema, contract, dependency or config changes.
Docker impact: none.

## Coordination
- **#78 / shared vitest config:** no change to `apps/sync-server/vitest.config.ts`
  or any shared config. Nothing to coordinate.
- **#86 / PR #94:** independent (see "Not #86"); no shared files.
- `test/main.test.ts:260-276` (#78's file) and `test/restart-process.int.test.ts:52`
  spawn the same tsx child with the same 30 s bound. They were not seen
  failing in these runs (the `main.test.ts` child exits at the config
  error, before the lazily imported Redis modules load), so they stay
  unchanged here; they can adopt
  `CHILD_START_MS` if they ever flake (see Open questions).

## Docs impact
Docs impact: none. Test-only change; no setup, script, env variable,
protocol or operator behaviour changes.

## Risks / edge cases
- **Slower failure when a child really hangs:** a hung child now costs up
  to 120 s instead of 30 s before it fails. Acceptable: it still fails with
  the same message and assertion.
- **Loads heavier than measured** (more than about 2.5 times the stress
  here) could still pass 120 s. Then report, don't raise again blindly.
- **Other load-flaky tests in the same full runs**, out of scope: round 2's
  background suite also failed `multi-cluster.redis.test.ts` AC18 (test
  timeout 30 s, listed in the issue comment as a separate candidate).
- **Pre-existing deterministic failure on main:** `test/release-files.test.ts`
  "keeps bundles and outputs outside the repo in a fixed per-version folder
  (L11, #81)" fails on `8dd503c`, alone and quiet
  (`expected '# Releasing…' not to contain 'export IMG="$(mktemp -d)"'`).
  Unrelated to this issue (RELEASING.md vs its test); see Open questions.
  The engineer must not fix it here.

## Security
Security-sensitive: no
Test-only change to two test files and one test helper: no auth, input
handling, user data, secrets, crypto, schema, endpoint or dependency
changes. The AC4 test keeps every assertion, including that no Redis
password reaches stdout or stderr.

## Implementer model
Implementer model: sonnet
Three small test edits with exact values given here, root causes proven,
following the existing per-test timeout and spawn-bound pattern
(`test/main.test.ts:260-276`, `test/multi-process.redis.test.ts:83`), no
open decisions, not security-sensitive.

## Test plan
Redis for local runs, as CI:
```
docker run -d --rm --name issue87-redis -p 127.0.0.1:6393:6379 \
  redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335 \
  redis-server --requirepass ci-only-redis-password --save "" --appendonly no \
  --maxmemory-policy noeviction
export SYNC_TEST_REDIS_URL=redis://:ci-only-redis-password@127.0.0.1:6393
```
(Exactly `SYNC_TEST_REDIS_URL`: a wrong name silently skips the 22 Redis
files. Check the run reports the Redis tests as run, not skipped.)

| AC | How it is shown |
|---|---|
| Root cause recorded with evidence | This document ("How the evidence was gathered", "Root causes"). |
| Both tests pass reliably under concurrent load | **Stress procedure**, at least 3 rounds: start `cd apps/sync-server && npx vitest run` and `cd apps/reader && npx vitest run` in the background, then run `cd apps/sync-server && npx vitest run test/main-redis.redis.test.ts test/multi-process.redis.test.ts --reporter=verbose` 3 times in the foreground while they run. Both target tests must pass in every foreground run **and** inside every background full sync-server run. Record pass/fail and the two tests' durations in `STATE.md` (to show the margin to 120 s). Before the change this failed both tests in round 2 (foreground and background) and multi-process in round 1. |
| Quiet runs still fine | The two files alone, 3 times: all pass, durations about as before (4 s each). |
| A hung child still fails clearly (not committed) | Temporarily set `CHILD_START_MS` to `1_000`: AC4 fails on `expected 'SIGTERM' to be null`, multi-process on `server did not start`, not on an anonymous Vitest timeout. Revert. |
| No weakening, no skip | `git diff origin/main -- apps/sync-server/test` shows only the new constant, the two bounds and the two test timeouts; no `expect` changed or removed, no `.skip`/`.todo`. |
| Only test files change; vitest config untouched | `git diff origin/main --stat` lists only the three test files and `docs/issues/87/`. |
| lint, typecheck, test, build | `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `SYNC_TEST_REDIS_URL` set), `pnpm build`. The pre-existing `release-files.test.ts` L11 failure and out-of-scope load failures (Risks) are noted in `STATE.md`, not fixed. |

## Implementation chunks
1. `test(server): add a shared start bound for spawned server processes`
   (`test/helpers/child-env.ts`)
2. `test(server): give the AC4 exit-code child the shared start bound`
   (`test/main-redis.redis.test.ts`)
3. `test(server): give the multi-process children the shared start bound`
   (`test/multi-process.redis.test.ts`)
4. `docs(state): record stress verification for #87` (`docs/issues/87/STATE.md`)

No docs chunk beyond STATE (Docs impact: none).

## Open questions
- **`release-files.test.ts` L11 fails deterministically on main** (`8dd503c`):
  `RELEASING.md` contains `export IMG="$(mktemp -d)"`, which the test
  forbids. Not part of #87. Possibly related to #90 (REL/IMG guards in
  RELEASING.md). Recommend the orchestrator check with the user whether
  #90 covers it or a new issue is needed.
- **`main.test.ts` and `restart-process.int.test.ts`** keep the 30 s spawn
  bound. Not seen failing; if they flake, they can import `CHILD_START_MS`
  (`main.test.ts` was #78's file, #78 is closed).

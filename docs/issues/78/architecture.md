# Architecture: #78 fix(sync-server): flaky test failures in the full parallel test run

Path: fast. Spec: [spec.md](spec.md).

## Repo layout
- Layout: `monorepo` (pnpm workspaces `apps/*`, `packages/*`; no submodules).
- Touched package: `apps/sync-server` (`@mosherw/sync-system-server`), test
  files only. No product code, no other package.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (root:
  `pnpm -r test && node --test "scripts/release/*.test.ts"`).

## Decisions
Decisions: none open.

## Why the full run is different
Root `pnpm test` runs `pnpm -r test`, which runs up to 4 workspace packages at
once. Each `vitest run` starts its own pool of workers on this 8-thread
machine, and some tests are heavy on their own (`apps/reader`
`build-output.node.test.ts` runs a Vite production build,
`packages/react` `package.test.ts` runs `tsc`). Other worktrees on the same
machine may run tests at the same time. CPU and disk time per test grow by a
large factor, while Vitest's default `testTimeout` stays at 5 s.

## Root causes (with evidence)
Measurements were taken in this worktree on 2026-11-25 (Windows 11, Node
24.18, Vitest 4.1.12). "Alone" means the three files run by themselves;
"stress" means the full sync-server suite run while a full root `pnpm test`,
the reader suite and the client suite run at the same time.

### 1. `main.test.ts` "exits non-zero and prints the config error to stderr": timing/load
- The test runs `spawnSync(node --import tsx src/index.ts)`. tsx compiles the
  server's TypeScript source in the child on every run. The child alone takes
  1.0–2.2 s from the shell; inside the test, 1.1–2.4 s alone and 3.3 s under
  stress.
- `spawnSync` has `timeout: 30_000`, but the test has **no** test timeout, so
  it gets Vitest's default 5 s. Under the full-run load it goes over 5 s.
  Vitest still reports a timeout for a synchronous body that took too long.
- The sibling tests that spawn tsx children already give the test the
  child's budget: `test/redis-lazy-load.test.ts:54-60` (`timeout: 60_000` on
  the child and `}, 60_000)` on the test) and
  `test/main-redis.redis.test.ts:194-204`. `main.test.ts:250-276` is the only
  one that doesn't. That missing timeout is the bug.

### 2. `redis-startup.test.ts` "reports a refused port as unreachable, fast": timing/load (reproduced)
- **Reproduced under stress:** failed with a 5 s timeout at 6.5 s
  (`redis-startup.test.ts:86`). It passed in the other runs.
- It is the first test in the file to call `connectRedis`, so it pays for the
  lazy `import('@redis/client')` (`src/storage/redis/connect.ts:208`,
  ADR 0010). The time goes into loading the module, not into the refused
  connect:
  - Probe test: `import('@redis/client')` took 440–680 ms, then each
    refused-port `connectRedis` took 12–34 ms, both with the file's own
    unawaited `close()` pattern and with an awaited one.
  - The test itself took 0.48–0.53 s alone, 1.4–3.8 s with two other files
    alongside, and 6.5 s (failed) under stress. Plain `node` import of
    `@redis/client` takes 2.1–2.6 s.
- The test's own assertion `Date.now() - started < 5000` measures that same
  module load, so it is load-sensitive too, besides the 5 s test timeout.
  It is meant to prove "refused is reported fast, not after the 10 s connect
  timeout".
- The other three tests in the file stayed small: black-hole ~1.05 s (its
  1 s connect timeout by design), TLS 22–183 ms, self-signed 85–309 ms (the
  self-signed one spawns `openssl req -newkey rsa:2048`, which uses a lot of
  CPU).

### 3 + 4. `release-files.test.ts` "has no old placeholder scope …" and "names the Docker Hub mirror …": not reproducible; most likely timing/load; stale expectation and environment ruled out
- **Not reproduced:** they passed in 3 consecutive full root `pnpm test` runs
  (exit 0; 196 s, 192 s, 167 s), in the stress run, and in 3 alone runs.
- **Stale expectation ruled out.** Neither test can fail by assertion unless a
  tracked file outside the history paths contains `@sync-system/`,
  `docker.io/mosherw` or a bare `mosherw/sync-system-server`. `git grep` finds
  0 such files at main `d37f1b3` and at every #27 commit (`3e31e8e`,
  `67905de`, `5fe56cb`, `7c6c41e`, `537d290`, `6c00cfc`). The only
  `@sync-system/` hits are `docs/decisions/0001`, `0007`, `0008` and `0009`,
  which the test excludes on purpose.
- **Environment / concurrent mutation ruled out.**
  - No test in the repo writes to a tracked path. Every
    `writeFileSync`/`rmSync`/`cpSync` in `apps/*/test`, `packages/*/test` and
    `scripts/release/*.test.ts` targets `mkdtemp`/`tmpdir`, the untracked
    `dist`, or a fixture copy.
  - The tests list files with `git ls-files` (tracked only), relative to
    their own checkout, so other worktrees cannot add hits.
  - The #27 worktree (`vigilant-northcutt-4e9791`) and the other worktrees
    have no modified tracked files, and nothing in the #27 worktree's tracked
    files matches.
- **Most likely cause: timing/load, like 1 and 2.** These are the only two
  tests that run `git ls-files` and then read every tracked file (856 files,
  1.6 MB, each test separately). Each takes 280–430 ms alone, ~3x the next
  slowest test in the file. Whole-repo I/O on Windows is the work that suffers
  most from disk and antivirus contention. The original #27 output wasn't
  kept, so this can't be proven after the fact. The fix below removes the
  repo scan from the per-test budget anyway.

## Approach
Give each slow test the budget it really needs, and keep the cost the test
doesn't measure out of its timed window. No assertion changes, no skips, no
global timeout change.

1. **`main.test.ts` process entry.** Add a per-test timeout of `60_000` to the
   `it('exits non-zero and prints the config error to stderr', …)` (same
   pattern as `redis-lazy-load.test.ts:60`). Keep the child's `spawnSync`
   `timeout: 30_000` below it, so a hung child still fails with a clear
   `status` assertion instead of a test timeout. One comment line: the child
   compiles the source with tsx, which is slow under the parallel run (#78).
2. **`redis-startup.test.ts`.** Add a `beforeAll(async () => { await
   import('@redis/client'); }, 60_000)` at the top of the describe block, with
   a comment explaining it. It warms the lazy client import (Vitest
   externalizes `node_modules`, so the import in `connect.ts:208` then comes
   from Node's module cache, as the probe showed). Production code and its
   lazy-load behaviour (tested in `redis-lazy-load.test.ts`) are unchanged.
   The `< 5000` and `< 3000` assertions stay exactly as they are; they now
   measure only the connect, which is what they are named for. Also give the
   self-signed certificate test `{ timeout: 30_000 }`, because its `openssl`
   RSA key generation is the file's other CPU-bound step.
3. **`release-files.test.ts` "no credentials or old names" block.** Read the
   tracked files once per file instead of once per test. Compute the list of
   tracked paths and their texts in a `beforeAll(…, 60_000)` inside the
   `describe('no credentials or old names in tracked files')` block. Store it
   as `{ path, text }[]` for files that exist (keep the `existsSync` guard and
   the `.zip` exclusion as each test has them today). The three tests then
   filter that list in memory, with their filters, regexes, history
   exclusions and `expect(hits).toEqual([])` unchanged (the `.npmrc` test
   reads `.npmrc` texts from the same list). `trackedFiles()` stays as it is.

### Alternatives rejected
- **Raise `testTimeout` in `vitest.config.ts` for the whole server suite.**
  That hides real hangs in about 2,000 other tests, and it isn't
  root-caused per test.
- **Run `pnpm -r test` with `--workspace-concurrency=1` or fewer Vitest
  workers.** It makes every run slower and doesn't fix the tests: load from
  other worktrees or CI neighbours still triggers them.
- **Pass a stub `importClient` in `redis-startup.test.ts`.** It would no longer
  test the real client's refused/TLS handling.
- **Retries (`retry: n`).** They hide flakiness instead of fixing it, which the
  spec forbids in spirit.

## Files to modify
- `apps/sync-server/test/main.test.ts`: per-test `timeout: 60_000` on the
  process-entry test, plus a comment.
- `apps/sync-server/test/redis-startup.test.ts`: `beforeAll` warm-up of
  `@redis/client` (60 s hook timeout), and `{ timeout: 30_000 }` on the
  self-signed certificate test.
- `apps/sync-server/test/release-files.test.ts`: one shared tracked-file scan
  in a `beforeAll` (60 s) for the "no credentials or old names" block.

No product code, schema, contract, dependency or Docker changes.
Docker impact: none.

## Docs impact
Docs impact: none. Only test files change; no setup, config, protocol or
convention changes.

## Risks / edge cases
- **A warm-up import that fails** (module missing) now fails in `beforeAll`
  rather than in the first test. That is still a red suite with a clear error.
- **The shared scan in `release-files`**: tests must not change the shared
  array (filter only). If `beforeAll` throws (git missing), all three tests
  fail, the same as today.
- **Timeout values**: 60 s is a ceiling, not an expected duration, and it
  matches the existing pattern. A real hang still fails, after 60 s instead
  of 5 s.
- **Not every load is covered.** A machine overloaded to more than 10x can
  still slow other tests. The stress test plan below is the guard; any new
  flaky test found there is reported as a deviation, not silently
  timeout-bumped.

## Security
Security-sensitive: no
Test-only changes; no auth, input handling, user data, secrets, crypto or
dependency changes. The redaction assertions in `redis-startup.test.ts`
(`attempt()` checks that the logs never contain the user or password) are
untouched.

## Implementer model
Implementer model: sonnet
Three test files, small mechanical changes following an existing pattern
(`apps/sync-server/test/redis-lazy-load.test.ts:54-60` for per-test timeouts;
`beforeAll` with a hook timeout as in `apps/reader/test/build-output.node.test.ts`),
no open decisions, not security-sensitive.

## Test plan
| AC | How it is shown |
|---|---|
| Root `pnpm test` passes reliably | **5 consecutive** full root `pnpm test` runs, all exit 0, with no other test run started by this session in between. Then **2 stress rounds**: a full root `pnpm test` running at the same time as `cd apps/sync-server && npx vitest run` and `cd apps/reader && npx vitest run`. Every sync-server test must pass in both the root run and the concurrent sync-server run. Before the fix, one stress round already reproduced failure 2. Record the run times and results in `STATE.md`. |
| Each failure root-caused | This document, sections 1–4. |
| `release-files` fixed or ruled out with evidence | Section 3 + 4 (git grep per commit, no-writer audit, clean worktrees, passing runs), plus the shared scan as a guard. |
| No test skipped, deleted or weakened | `git diff origin/main -- apps/sync-server/test` shows only timeouts, the `beforeAll` warm-up and the moved scan. Every `expect(...)` line in the three files is unchanged: same count, same text. Negative checks, done locally and **not committed**: (a) temporarily add the string `docker.io/` + `mosherw` to a tracked file (e.g. a line in `README.md`) and check that the mirror test fails and names that file, then revert; (b) the same with the old `@sync` + `-system/` scope for the placeholder test, then revert. |

Also run each changed file alone 3 times (`npx vitest run test/main.test.ts
test/redis-startup.test.ts test/release-files.test.ts`), and `pnpm lint` and
`pnpm typecheck`.

## Implementation chunks
1. `test(server): give the process entry test its child's time budget`
   (`main.test.ts`)
2. `test(server): load the redis client before timing startup errors`
   (`redis-startup.test.ts`)
3. `test(server): scan tracked files once in the release-files name checks`
   (`release-files.test.ts`)
4. `docs(state): record reliability runs for #78` (`STATE.md`: the 5
   consecutive runs and the 2 stress rounds)

No docs chunk: `Docs impact: none`.

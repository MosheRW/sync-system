# State: #87 test(sync-server): main-redis AC4 and multi-process reconnect tests flaky under load
- Path: fast
- Phase: validation
- Branch: test/87-redis-load-stable-tests
- PR: #98
- Plan approved by user: yes
- Security-sensitive: no
- Review rounds: 1
- Last updated by: qa
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (default) → DONE
- engineer implement: sonnet (architect Implementer model) → DONE
- qa review: sonnet (NEXT_MODEL) → PASS
## Open questions
- release-files.test.ts L11 fails deterministically on main (8dd503c), unrelated to #87; see architecture.md Open questions.
- main.test.ts and restart-process.int.test.ts keep the 30 s spawn bound (not seen failing); out of scope.
- Out-of-scope load flakes seen in the background full suites (not fixed): multi-cluster AC6 (round 1), redis-timers backlog 129/64 and restart-timers door-code pause (round 2), multi-parking (round 3). Different test each round.
## Deviations from plan
- Added a fifth commit `style(server): format the AC4 test after the timeout change`: Prettier re-wrapped the `it(...)` call once the timeout became an expression, and `pnpm lint` checks formatting.
- The "quiet" runs were taken on a machine that was not idle (other node processes, CPU at 100%), so quiet durations were 7 to 18 s instead of about 4 s.

## Verification (#87)
Redis 7.2.17 (CI digest and password), `SYNC_TEST_REDIS_URL` set; Redis tests ran, not skipped. `CHILD_START_MS = 120_000`.
- Stress: 3 rounds. Each round: full sync-server and full reader `vitest run` in the background, the two target files 3 times in the foreground. All 9 foreground runs passed. Foreground durations (AC4 / multi-process, s): R1 48.6/51.6, 32.3/32.9, 27.1/28.9; R2 38.8/39.0, 32.9/35.9, 43.6/48.7; R3 23.5/24.9, 24.9/24.4, 37.4/39.7. The highest are 48.7 and 51.6 s, about 43 percent of 120 s. Inside the background full sync-server runs both tests passed every round (AC4 / multi-process): R1 52.6/51.3, R2 39.7/39.3, R3 23.6/23.7 s.
- Quiet: 3 runs of the two files, all pass (AC4 / multi-process): 15.0/14.9, 14.7/18.0, 7.4/7.6 s.
- Hung child (temporary `CHILD_START_MS = 1_000`, reverted, not committed): AC4 fails on `expected 'SIGTERM' to be null`, multi-process on `server did not start`.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: pass. `pnpm test`: 2120 of 2121 pass; the one failure is `release-files.test.ts` L11 (pre-existing on main, RELEASING.md contains `export IMG="$(mktemp -d)"`; not fixed, possibly #90).
- Redis container stopped.

# State: #86 fix(sync-server): stale pubsub probe result can replace a healthy link
- Path: fast
- Phase: validation
- Branch: fix/86-pubsub-probe-race
- PR: #94
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect: opus (default) → DONE
- security plan: opus (rule) → PASS (0 critical, 0 high, 0 medium, 3 low; required controls RC1-RC6 in security.md)
- engineer implement: opus (Implementer model line) → DONE
## Gate 2 decisions (user, 2026-11-26)
- Plan approved as proposed.
- L1 (guard relies on connect.ts bounds): accepted; RC4 covers it in this PR.
- L2 (debug event for discarded stale results): accepted, not implemented.
- L3: include one line in `docs/operator-guide.md` (`REDIS_COMMAND_TIMEOUT_MS`
  row): stall detection can take up to heartbeat + command timeout when the
  timeout exceeds the 5 s heartbeat. Own `docs(...)` commit.
## Open questions
- none
## Deviations from plan
- Extra docs commit (user decision L3 at Gate 2): one paragraph under the
  configuration table in `docs/operator-guide.md`, right after the
  `REDIS_COMMAND_TIMEOUT_MS` row (outside the table, so the table's column
  widths stay unchanged).
- Extra test (RC2): an old probe settling after a replace does not clear the
  newer probe's in-flight flag (test 7 in `test/pubsub-probe.test.ts`).
## Implementation notes
- Before-fix proof: the new tests were written first and run against the
  unchanged `pubsub.ts` (no stash needed; the fix was committed after).
  Result: 5 failed, 2 passed.
  - Test 1 (overlapping ticks): `expected 2 to be 1` at
    `expect(t.resyncs()).toBe(1)` (2 resyncs, the healthy link replaced).
  - Test 3 (stale result after a `regressed` replace): `expected 2 to be 1`
    at `expect(t.resyncs()).toBe(1)`.
  - Also failing pre-fix: test 2 (two PINGs in flight), test 5 (a rejected
    PING became an `unhandledRejection`), test 7 / RC2 (second tick probed
    sub1 again). Tests 4 and 6 pass pre-fix, as expected (they pin
    behaviour the fix must keep).
- After the fix: `pubsub-probe.test.ts` 7/7 and `pubsub-sequence.test.ts`
  5/5 pass.
- Regression (`apps/sync-server`, `npx vitest run` with
  `SYNC_TEST_REDIS_URL`, own Redis 7.2.17 container): 2120 passed, 8 failed
  in the full parallel run on a loaded machine:
  - #87's files, noted not fixed: `main-redis.redis.test.ts` (AC4, 30 s
    timeout), `multi-process.redis.test.ts` (30 s timeout).
  - Load timing, all pass when rerun with `--no-file-parallelism`:
    `redis-storage-contracts` (R13), `redis-timers` (2x #47 AC2),
    `restart-timers` (#10 AC29), `multi-cluster` (AC18; one other AC18 case
    flaked once in the rerun, then 3/3 runs of the file passed alone).
  - Pre-existing and unrelated: `release-files.test.ts` L11 (#81) fails on
    `RELEASING.md` content; neither file is touched by this branch.
  - `multi-delivery.redis.test.ts` (stalled-link end to end) passes.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: pass.

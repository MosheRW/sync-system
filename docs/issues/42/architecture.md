# Architecture: #42 treat a just-started instance as live when picking a successor

Issue: https://github.com/MosheRW/sync-system/issues/42 (follow-up to #35, PR #40)
Path: fast | Spec: [spec.md](spec.md) | Background: [#35 architecture 12.18](../35/architecture.md#1218-risks-and-edge-cases), [#35 security C12, F17](../35/security.md)

## Repo layout

- Layout: `monorepo` (pnpm workspace, no submodules; `git submodule status` is empty).
- Touched package: `apps/sync-server` only. Checks: `pnpm --filter @mosherw/sync-system-server lint|typecheck|test`
  (root `pnpm lint`, `pnpm typecheck`, `pnpm test`), and the Redis suites with `TEST_REDIS_URL`
  set (`*.redis.test.ts`, plus the whole suite with `SYNC_TEST_STORE=redis`).
- No other repo, no linked issue.

## Decisions

Decisions: none open. The fix approach was an open question in the spec; it is
decided here (below), not as an ADR: option 1 reuses a pattern the server already
has (`instanceLive` for remote approvals, `orphans()` for the sweep), and option 2
does not meet the `handoff` criterion, so there is no real trade-off for the user
to weigh.

## Root cause

`RemoteRecipient.isOpen()` returns `RedisInstance.looksLive(instance)`, a set
refreshed only by this instance's own heartbeat (every 5 s; the renewal reply
lists the live instances). An instance that registered after the last renewal
is missing from it, so for up to 5 s:

1. `LifecycleService.graceEnded` (`src/lifecycle/lifecycle-service.ts:319`)
   passes `pickSuccessor` an `isConnected` that is `false` for every participant
   attached on the new instance.
2. `LifecycleService.handoff` (`:358`) computes `oldAttached = false` for an old
   leader attached there, so the old leader is filtered out of `participantIds`
   and gets no `leader.lost` (S4). Its registry entry and its session on the new
   instance stay, holding a membership the record no longer lists.

## Approach (chosen: option 1, a Redis check on a cache miss)

A new helper gives `isOpen()` hints for a list of participants, confirming every
**cache miss** with one Redis read:

1. Resolve each pid to its `Recipient` (as today, from the registry the task read).
2. `open` = pids whose recipient `isOpen()` (local socket open, or remote instance in
   the live cache). No Redis read for these.
3. `missed` = pids whose recipient is a `RemoteRecipient` and not open, grouped by
   instance ID.
4. If `missed` is empty, or there is no cluster (memory mode): return `open`. No read.
5. Else one `liveOf([...distinct missed instance IDs])` (an existing method: one `MGET`
   of `P:inst:<id>`, IDs filtered by `INSTANCE_ID_PATTERN`), and add every pid
   whose instance has its liveness key.
6. If that read throws: log `liveness_hint_failed` (warn, `err: safeErr(err)` only)
   and return `open` (the miss stays "not live", exactly today's behaviour).

It is used in exactly two places:

- **Grace end.** `graceEnded` computes the successor candidates (vice and roster
  entries marked connected, minus the leader, the displaced leader and blocked
  pids, as `pickSuccessor` already filters) plus the old leader, calls the helper
  once, and passes `pid => open.has(pid)` to `pickSuccessor`. The same set is
  handed to `handoff`, so a grace end makes **at most one** Redis read.
- **Handoff.** `handoff` takes an optional `open?: ReadonlySet<string>`; without it
  (the take-back path from `LeaderControls`) it calls the helper for `[old]` only.
  `oldAttached = oldSession !== undefined && open.has(old)`. At most one read per
  take-back.

Bounds: one `MGET` per grace end or take-back, only when a relevant participant's
instance is missing from the cache; keys = distinct instance IDs (at most the
number of instances in the group's registry), never one per member, never per
tick. Grace ends and take-backs are rare events per group, not periodic.

Why it is only a hint (C12 kept): the read only changes which pid the existing
`pickSuccessor` rule chooses and whether the old leader is told. Membership,
leadership and approval are still decided by the stored record, under the group
lease and commit fence (C11, C14). The grant goes as a remote effect to the
registry's `attachId`; if that session is gone on the target instance, the
existing `disconnectStale` path applies, the same as when the cache said "live".
Removals (`orphans`, sweep, reconcile, `disconnectStale`) are untouched; they
already read Redis.

The live-instance cache itself is not changed or refreshed (spec: out of scope),
so no other `isOpen()` user changes behaviour.

### Alternatives rejected

- **Option 2: re-arm the grace once after a heartbeat.** Needs a persisted
  "re-armed" marker in the timer data or record (ADR 0013 timers survive
  restarts), adds 5 s or more to the pause, still reads the cache (a slow renewal
  repeats the problem), and does not fix `handoff` (S4). Rejected.
- **Treat an instance ID never seen in the cache as live.** No Redis truth: an
  instance that registered and died before any peer's heartbeat would be picked,
  breaking AC4 ("a truly dead or unregistered instance is still skipped"). Rejected.
- **Refresh the whole cache on a miss.** Changes the cache for every other
  `isOpen()` user and races the heartbeat's replacement of the set; out of scope.
  Rejected.
- **Make `Recipient.isOpen()` async.** Touches every caller (leader guard, joins,
  `anyoneAttached`), far beyond the two call sites. Rejected.

## Files to create / modify

| Path | Change |
|---|---|
| `apps/sync-server/src/groups/open-hints.ts` (new) | `openHints(entries, liveOf, onError)`: the helper above; pure, no logger import (the caller logs). |
| `apps/sync-server/src/lifecycle/succession.ts` | Export `successorCandidates(record)` (eligible pids ignoring connection: vice plus connected roster entries, same filters); `pickSuccessor` unchanged in behaviour. |
| `apps/sync-server/src/lifecycle/lifecycle-service.ts` | `LifecycleHost.openOf(record, pids): Promise<ReadonlySet<string>>`; `graceEnded` uses it once and passes the set to `handoff`; `handoff(app, record, successor, reason, open?)` uses it for `oldAttached`. |
| `apps/sync-server/src/groups/group-service.ts` | Wire `openOf` in the `LifecycleService` host: map pids via `recipientOf`, call `openHints` with `deps.cluster?.host.liveOf`, log `liveness_hint_failed`. Constructor block only (small hunk). |
| `apps/sync-server/test/open-hints.test.ts` (new) | Unit tests (below). |
| `apps/sync-server/test/succession.test.ts` | `successorCandidates` cases. |
| `apps/sync-server/test/multi-liveness.redis.test.ts` (new) | Several-instance tests (below). |
| `.changeset/<name>.md` (new) | Patch changeset for `@mosherw/sync-system-server` (fixed group bumps all four to 1.0.1). |
| `docs/issues/35/architecture.md` | C12 notes: 12.6 `isOpen()` line, 12.18 "A newly started instance" bullet, 12.13 log event list. |
| `docs/operator-guide.md` | "Known limits of 1.0.0": remove the #42 bullet (fixed). |

Not touched: `src/storage/**` (`RedisInstance.liveOf` and `looksLive` are reused as
they are), `src/lifecycle/leader-controls.ts` (its `takeBackFor` calls `handoff`
without `open`), `docs/roadmap.md`.

### Overlap with #47 (parallel session)

#47 changes `src/storage/redis/scripts.ts` / live-groups (`RESERVE_LIVE`,
`CLAIM_DUE`) and their tests. This plan touches no storage file. Possible textual
overlap only: `docs/operator-guide.md` (if #47 documents `lb` there) and a second
changeset file (separate file names, no conflict). Whichever merges second rebases
or merges `main` in; no logical dependency.

## Contracts

No wire, protocol, Redis key or message-schema change. Internal contracts:

```ts
// src/groups/open-hints.ts
export async function openHints(
  entries: ReadonlyArray<readonly [pid: string, recipient: Recipient | undefined]>,
  liveOf: ((ids: readonly string[]) => Promise<Set<string>>) | undefined,
  onError: (err: unknown) => void,
): Promise<Set<string>>;

// LifecycleHost (src/lifecycle/lifecycle-service.ts)
/** isOpen() hints for `pids`; a remote cache miss is confirmed in Redis once (#42, C12). */
openOf(record: GroupRecord, pids: readonly string[]): Promise<ReadonlySet<string>>;

// LifecycleService
handoff(app, record, successor, reason, open?: ReadonlySet<string>): Promise<{ record; granted }>;
```

New log event: `liveness_hint_failed {err}` (warn). No instance ID, pid or group
data in it (#35 AC25).

Failure mode (stated): a Redis error, timeout or missing key means "not live",
the same as a cache miss today. The task is not aborted by the hint read (a
following commit fails on its own if Redis is really down).

## Docker impact

Docker impact: none.

## Docs impact

- `docs/issues/35/architecture.md`: 12.6 (`isOpen()` remote: the live cache, with
  a cache miss confirmed in Redis at grace end and handoff, #42), 12.18 (the
  "newly started instance" bullet becomes: fixed by #42 for the successor pick and
  the old-leader check; other `isOpen()` hints still lag up to 5 s), 12.13 (log
  event `liveness_hint_failed`). This is the C12 note required by the spec.
- `docs/operator-guide.md`: remove the "A just-started instance is not yet a
  successor (issue #42)" known limit.
- `.changeset/`: one patch changeset (user-visible fix).
- `docs/protocol.md`, README, `docs/conventions.md`: none.
- `docs/roadmap.md`: not edited (orchestrator/pm).

## Risks / edge cases

- **Dead-but-key-alive instance** (killed, key not expired, up to 15 s): Redis says
  live, as the cache would. Unchanged 12.18 behaviour (sweep later puts that
  leader offline with a new grace).
- **Fenced instance whose key still exists** (up to 5 s): the grant effect is dropped
  there (its sessions are closed); the sweep handles it, as today.
- **Extra Redis round trip under the lease**: one `MGET` (command timeout applies,
  default 500 ms in tests); far inside the 10 s lease and 3 s renewal.
- **Memory mode**: no cluster, so no read; one extra `await` on an already-resolved
  set under the group lock. The existing order tests (`attach-reply-order`,
  `grace.int`, `handoff.int`, `take-back.int`) guard it.
- **Vice priority kept**: the read happens before `pickSuccessor`, so a vice on the
  new instance still beats an earlier member on a known instance (a lazy
  "read only if nobody was found" would break this; rejected).
- **Take-back vs grace race (AC18)**: both run under the lease; the hint read does
  not change who wins, only who is told.

## Security-sensitive areas

Security-sensitive: yes

- Control C12 (liveness feeding leadership hints): `lifecycle-service.ts`
  `graceEnded` / `handoff`, new `open-hints.ts`, the host wiring in
  `group-service.ts`. Guarantees to check: hint only (no grant, membership or
  approval from the read), removals still Redis-truth only, Redis error = not
  live, bounded reads (one `MGET` of distinct instance IDs per grace end or
  take-back), IDs validated by `INSTANCE_ID_PATTERN` before building keys, no
  instance ID in logs.
- No new endpoint, message, schema, dependency or secret.

## Implementer model

Implementer model: opus
Reason: security-sensitive (C12), touches the leadership path under the lease and
needs deterministic several-instance tests.

## Test plan (mapped to acceptance criteria)

Unit (`test/open-hints.test.ts`, fake recipients and a counting `liveOf`):
- cache hit (local open, remote looks live): no `liveOf` call (AC6);
- remote miss, key present: pid open (AC1);
- remote miss, key absent: pid not open (AC4);
- `liveOf` throws: pid not open, `onError` called once (AC6);
- 50 pids on 2 missed instances: exactly one `liveOf` call with 2 distinct IDs (AC6);
- no `liveOf` (memory mode): no read; a local closed session is not open;
- undefined recipient: not open.

Unit (`test/succession.test.ts`): `successorCandidates` matches `pickSuccessor`'s
filters (leader, displaced, blocked, non-participant, disconnected roster excluded).

Several instances (`test/multi-liveness.redis.test.ts`, `describeRedis`, real Redis).
Determinism: instance A gets slow timings through `perNode`
(`{...FAST_TIMINGS, heartbeatMs: 20_000, selfFenceMs: 40_000, livenessMs: 60_000, sweepMs: 60_000}`),
so A's live cache does not list a peer started after A for the whole test (the
start-up window, held open). Each node gets its own `ManualScheduler`; only A's is
advanced, and each test asserts the grace `timer_claimed` log is on A.

1. **Grace end on A, only eligible member on B** (AC1, AC2): leader on A, one member
   on B (B started after A), leader drops, A's scheduler advances past the grace:
   the member gets `leader.granted {reason: 'handoff_disconnect'}`, the stored
   `leaderId` is the member, `leaderOnline` true, within a few seconds (no
   heartbeat of A, no frozen bound). Reverting the lifecycle change fails it.
2. **Take-back on A, current leader on B** (AC3): leader D on A, member M on B; D
   drops, grace handed to M (claimed on A with the fix, or by B; either works for
   setup); D resumes on A and sends `leader.takeBack`: M gets `leader.lost` with a
   member token, stays in `participantIds`, its registry entry stays, and the
   take-back reply is `leader.granted {reason: 'take_back'}`.
3. **Unregistered instance still skipped** (AC4): A slow (sweep off for the test),
   member on C, C stopped cleanly (liveness key deleted, registry entry kept since
   A does not sweep yet), grace ends on A: no handoff, `grace_ended` logged, group
   stays paused.

Regression (AC4, AC8): all existing suites, memory and `SYNC_TEST_STORE=redis`,
in particular `grace.int`, `handoff.int`, `take-back.int`, `multi-cluster`
(take-back vs grace race, 20 rounds), `multi-sweep` (C12 sweep test),
`multi-timers`. Root `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

AC5 (hint only) is shown by the code path (the set feeds only `pickSuccessor` and
`oldAttached`) and by test 3; AC7 by the docs chunk plus the security plan review.

## Implementation chunks

1. `fix(server): confirm a missed peer in redis when a grace ends` — `open-hints.ts`,
   `successorCandidates`, `LifecycleHost.openOf` and its wiring, `graceEnded`, unit tests.
2. `fix(server): tell an old leader on a just-started instance it lost the lead` —
   `handoff(..., open?)`, grace end passes its set, take-back reads `[old]` (S4).
3. `test(server): cover grace end and take-back against a just-started instance` —
   `multi-liveness.redis.test.ts` (tests 1-3).
4. `chore(release): add a patch changeset for #42`
5. `docs(architecture): record the liveness hint on a cache miss (C12, #42)` —
   #35 architecture 12.6, 12.13, 12.18, and the operator-guide known limit.

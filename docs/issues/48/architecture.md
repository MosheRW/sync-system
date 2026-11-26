# Architecture: #48 test(server): forgetGroup slot retention and limits wording

Path: fast. Test-only change plus one doc parenthetical. No product code.

Repo layout: single repo, pnpm workspace (`apps/sync-server`, root scripts). No submodules.
Affected: `apps/sync-server` (tests only; checks: `pnpm --filter ./apps/sync-server typecheck|test`, root `pnpm lint`) and `docs/operator-guide.md`.
Decisions: none open. Docker impact: none.

## Findings (code as of main after #47)
- `liveGroups.release` has two call sites in `group-service.ts`: the create guard (~1185) and `endGroup` (~2811, explicit, before `forgetGroup`).
- Private `forgetGroup` (~2769) clears limiters, timers, refresher and join codes; it must NOT release the slot. It also has a sibling in the cluster path: `applyRemote` case `'forget'` (~705) clears limiters and refresher only, also must not release.
- `endGroup` sends `{op:'forget'}` to the other instances (~2852).
- Store contracts (`test/contracts/state.ts`, `liveGroupsContract`) test the store only; they cannot see service-level calls, so they are not the place.
- `instance.ts` `forget(id)` is the sweeper's dead-instance cleanup, unrelated to the slot; no test needed there.

## Approach
Service-level regression tests next to the existing create-limit tests, which already use `MemoryLiveGroups.count` and the Redis `lg` zset:

1. Memory, `apps/sync-server/test/group-create-limits.int.test.ts`: new `describe` "a group that is only forgotten keeps its slot (#48)".
   - Create a group over a client (slot count 1 via `liveCount`).
   - Pin `forgetGroup`: call the private method through a narrow test-only cast on the service (the file's `createSyncServer` options or helper lifecycle in `test/helpers/lifecycle.ts` show how tests reach the service; if the service is not reachable, spy on `storage.liveGroups.release` and assert the end path calls it exactly once, then use the cast approach below). Assert `liveCount` is still 1 and `release` was not called.
   - Then `group.end` from the leader: `liveCount` is 0 and `release` was called exactly once with `(namespace, groupId)`.
2. Cluster `forget`: pass a Redis storage built with `redisStorage(...)` (as `startTestServer({ redisPrefix })` does) and capture the receiver by spying on `storage.cluster.setReceiver`; call `receiver.receive([{ op: 'forget', ns: 'app-a', gid }])` on the instance, and assert the `lg` zset (`zCard`) is unchanged and `release` was not called; afterwards `group.end` drops it to 0. Put it in `apps/sync-server/test/group-create-limits.redis.test.ts` (runs via `describeRedis`, so skipped without Redis, as for the existing Redis tests there). Also add the `forgetGroup` case there on Redis (same private-method cast), covering "memory and, where the suite runs it, Redis".
3. If neither the service nor the receiver can be reached without a product change, the engineer stops and returns `BLOCKED` (no product code change is allowed by the spec); do not add test-only exports to `src/`.

Alternatives rejected: extending `liveGroupsContract` (store-level, cannot observe `forgetGroup`); a source-text grep test that counts `release(` call sites (brittle, not behavioural).

## Files
- Modify `apps/sync-server/test/group-create-limits.int.test.ts`: memory test for `forgetGroup` retention and `endGroup` release.
- Modify `apps/sync-server/test/group-create-limits.redis.test.ts`: Redis tests for `forgetGroup` and the cluster `forget` effect retaining the slot, `group.end` releasing it.
- Modify `docs/operator-guide.md` (~line 522, only the parenthetical): "(the four group creation variables: `MAX_GROUP_CREATE*` and `MAX_LIVE_GROUPS_PER_APP`)", reflowed to the file's line width; touch no other line.

Data model: none. Contracts: none changed.
Docs impact: `docs/operator-guide.md` (that parenthetical only). Do not edit `docs/roadmap.md`.

## Risks
- Private-method access in tests may be type-awkward; use a minimal `as unknown as { forgetGroup(...): Promise<void> }` cast in the test only.
- The doc edit sits near text other sessions change for #41: keep the diff to the one parenthetical to avoid merge conflicts.

Security-sensitive: no
Reason: tests and one wording fix; no input handling, schema, dependency or contract change.

Implementer model: sonnet
Reason: test-only, 2 test files plus 1 doc line, follows existing patterns (`group-create-limits.int.test.ts`, `.redis.test.ts`); no schema, API, dependency or ADR. The only judgment call (how to reach the private method/receiver) has a stated fallback (`BLOCKED`).

## Test plan (acceptance criteria)
- AC1 (forgetGroup and cluster forget keep slot; endGroup releases): tests 1 and 2 above.
- AC2 (memory and Redis): int test (memory) and redis test (skipped without Redis).
- AC3/AC4 (doc, only that parenthetical): `git diff docs/operator-guide.md` shows one hunk; read the sentence as four variables.
- AC5: `pnpm lint`, `pnpm typecheck`, `pnpm test`, build pass; no new dependencies.

## Implementation chunks
1. `test(server): pin that forgetGroup keeps the live-group slot (memory)` (`group-create-limits.int.test.ts`)
2. `test(server): pin slot retention on forgetGroup and cluster forget (redis)` (`group-create-limits.redis.test.ts`)
3. `docs(operator-guide): say four group creation variables in several instances`

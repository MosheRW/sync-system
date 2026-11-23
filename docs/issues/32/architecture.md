# Architecture: #32 offer take-back only after a handoff loss

Path: fast. Spec: [spec.md](spec.md). Background: #13 (take-back, AC24, AC25,
Q2.4), #25 security advisory M1 ([../25/security.md](../25/security.md)) and
Gate 2 Q-A2 ([../25/architecture.md](../25/architecture.md)).

## Repo layout
- Layout: `monorepo` (pnpm workspace, `apps/*` + `packages/*`, no submodules:
  `git submodule status` is empty, `pnpm-workspace.yaml` present).
- Affected packages:

| Package | Path | What changes | Checks |
|---|---|---|---|
| sync server | `apps/sync-server` | the fix, its tests | `pnpm --filter ./apps/sync-server typecheck`, `... test` (Redis tests need `REDIS_URL`, see `test/helpers/redis.ts`) |
| client | `packages/client` | one integration test assertion | `pnpm --filter ./packages/client test` |
| protocol | `packages/protocol` | JSDoc comments only (no type or schema change) | `pnpm --filter ./packages/protocol typecheck` |
| reader | `apps/reader` | one stale code comment only | `pnpm --filter ./apps/reader typecheck` |

- Root checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- No other repo needs changes.

## Decisions
Decisions: none open. The behaviour is set by the spec (decided at #37 Gate 1,
2026-11-22, following #25 M1). One point to confirm at Gate 2 is listed under
"Questions for Gate 2" below. It is a consequence of the fix, not a technical
choice, so it gets no ADR.

## Root cause
`LifecycleService.handoff()` (`apps/sync-server/src/lifecycle/lifecycle-service.ts`)
patches `displacedLeaderId: old` for every reason, `take_back` included.
`announce()` then computes `takeBackAvailable: record.displacedLeaderId === old`
on the updated record, so it is always `true`. Every check that guards the
take-back right already reads `displacedLeaderId`:
- `LeaderControls.takeBack()` (`lifecycle/leader-controls.ts`): `NOT_ALLOWED`
  unless the caller is `displacedLeaderId`.
- Resume as a member (`groups/group-service.ts`, around line 2407): sends
  `takeback.offered` only when `claims.pid === displacedLeaderId`.

So one stored value is wrong. Fix the value; every check follows.

## Approach
In `handoff()`, write the slot by reason:

```ts
displacedLeaderId: reason === 'take_back' ? undefined : old,
```

- `handoff_disconnect`, `handoff_inactivity`: unchanged (the old leader holds
  the slot).
- `take_back`: the slot is cleared. The interim leader becomes a plain member.
- `announce()` keeps deriving `takeBackAvailable` from the stored record
  (`record.displacedLeaderId === old`). That is now `false` for a take-back with
  no extra branch, and the message and the stored right cannot drift apart.
- The patch already goes through the unit of work (ADR 0011), so the in-memory
  store and the Redis store get the same result. `InMemoryGroupStore.patch`
  spreads the patch (an `undefined` value clears the field). The Redis document
  (`storage/redis/document.ts`) has `displacedLeaderId: id.optional()`, and an
  `undefined` value is left out of the stored JSON. The existing clear paths
  (leave, remove, block, recreate) already patch `displacedLeaderId: undefined`
  this way.
- Update the doc comments that describe the slot: the `handoff()` JSDoc,
  `GroupRecord.displacedLeaderId` in `groups/group-store.ts` ("set by a handoff
  only; a take-back leaves it empty"), and the `pickSuccessor` comment in
  `lifecycle/succession.ts`.

Rejected alternatives:
- Compute `takeBackAvailable: reason !== 'take_back'` in `announce()` but keep
  storing the slot. That only fixes the hint. A scripted client could still call
  `leader.takeBack` (M1).
- Add a separate `displacedBy` field next to the slot and check it in
  `takeBack()` and resume. That adds a schema field to the Redis document for
  no gain, because clearing the slot has the same effect.

### Reconnect / reload (AC4)
The right lives only in the stored record, never in a token or the client:
- A member token issued in `leader.lost` carries no take-back claim. A reload
  resumes as a member, and `takeback.offered` is sent only if
  `pid === displacedLeaderId`, which is now `undefined`.
- With Redis, the cleared slot is persisted in the group document. After a
  server restart the recovered record has no `displacedLeaderId`, so the result
  is the same.
- The reader's Q-A2 suppression (`lastLoss !== 'take_back'`) stays. It now
  matches the server, and only its comment goes stale (fixed in the docs chunk).

### Side effect: the interim leader can be picked again
`pickSuccessor` skips `displacedLeaderId`. Before the fix, after a take-back
the interim leader held the slot, so a later auto handoff (the original leader
drops again) skipped it. After the fix it is a plain member and is eligible
again by the normal rule (connected vice first, else earliest admitted). If it
is picked, the original leader holds the slot and is offered take-back as
before (AC6). This follows the existing successor rule, which the spec leaves
out of scope. See Q-1.

`protectedPids()` (roster eviction, #13 RC10) also lists `displacedLeaderId`.
After a take-back the interim leader is no longer protected from roster
eviction under join churn. It is an ordinary member, so this is correct.

## Spec change against #13
#13 AC25 says "After a take-back, the displaced-leader slot holds the leader
who was displaced by it". #32 replaces that first clause on purpose. The
second clause (inactivity timers restart for the leader who now leads) and
"the take-back offer expires if the group ends" are unchanged.

## Files to change
| File | Change |
|---|---|
| `apps/sync-server/src/lifecycle/lifecycle-service.ts` | `handoff()`: `displacedLeaderId` is `undefined` for `take_back`; JSDoc updated |
| `apps/sync-server/src/groups/group-store.ts` | `displacedLeaderId` doc comment: set by a handoff only |
| `apps/sync-server/src/lifecycle/succession.ts` | `pickSuccessor` comment: "the displaced leader (the take-back holder, set only by a handoff)" |
| `apps/sync-server/test/take-back.int.test.ts` | Fix the swap test (slot now empty, `takeBackAvailable: false`). Replace the int ping-pong rate-limit test with a ping-pong refusal test. New: reload refusal, fresh handoff after a take-back |
| `apps/sync-server/test/leader-controls.test.ts` | New unit test: the per-group take-back limiter (3 per minute, then `RATE_LIMITED`), kept now that the int test can't reach it |
| `apps/sync-server/test/handoff.int.test.ts` | New: after `handoff_inactivity` the attached old leader's `leader.takeBack` succeeds |
| `apps/sync-server/test/restart.redis.test.ts` | New: the empty slot survives a restart with Redis; the interim leader is still refused |
| `packages/client/test/integration/roles.int.test.ts` | Line 80: `takeBackAvailable: false` after a `take_back` loss |
| `packages/protocol/src/messages.ts` | JSDoc of `LeaderLostMessage` and `LeaderTakeBackMessage`: `false` after a `take_back` or `superseded` loss |
| `packages/protocol/src/errors.ts` | `NOT_ALLOWED` JSDoc: "anyone but the leader displaced by the last handoff" |
| `README.md` | "Take-back" bullet (around line 720) and the "Tokens are bearer credentials" bullet (around line 898) |
| `apps/reader/src/group/use-leadership-flow.ts` | Comment only (line 171-172): drop "until #32 is fixed" |

No change to `packages/client/test/client.lifecycle.test.ts`. It feeds a
fake `leader.lost` and tests that the client copies whatever
`takeBackAvailable` the server sends.

## Data model
No schema change and no migration. `displacedLeaderId` stays optional in
`GroupRecord` and in the Redis document schema. Stored documents written
before the upgrade that hold a take-back-made slot keep it until the next
leader change, leave, removal or the group's end. See Risks.

## Contracts
No message shape changes and no new error codes. Changed semantics only:

| Message | Before | After |
|---|---|---|
| `leader.lost` `reason: 'take_back'` | `takeBackAvailable: true` | `takeBackAvailable: false` |
| `leader.lost` `reason: 'handoff_disconnect' \| 'handoff_inactivity'` | `true` | `true` (unchanged) |
| `leader.lost` `reason: 'superseded'` | `false` | `false` (unchanged) |
| `takeback.offered` on resume | to the most recent displaced leader | to the leader displaced by the last handoff, if no take-back happened since |
| `leader.takeBack` from the interim leader after a take-back | `leader.granted` (rate-limited) | `error` `NOT_ALLOWED`, "Only the displaced leader can take back the lead", no budget spent |

The protocol version does not change: this narrows a right, so a client that
already treated `takeBackAvailable` as the authority keeps working.

Docker impact: none.

Docs impact: `README.md` (protocol summary and security notes), the
`packages/protocol` JSDoc above, and one reader comment. `packages/client/README.md`
and `packages/react/README.md` stay correct as written (they tie the offer to
`takeBackOffered` and `NOT_ALLOWED` and never claim a take-back can be taken
back). No `docs/conventions.md` change.

## Risks / edge cases
- **Upgrade with Redis.** A group document written by the old code right after
  a take-back still names the interim leader in the slot. That leader can take
  back once after the upgrade. The next leader change of any kind writes the
  slot correctly. This is bounded and not worth a migration; note it in the PR
  body and not in the README. The engineer should not add a startup scan.
- **Race with a grace handoff on another instance.** Covered by
  `multi-cluster.redis.test.ts` (take-back vs grace end). Either the take-back
  wins (slot empty) or the handoff wins (the take-back gets `NOT_ALLOWED`).
  The test asserts only who leads and the reply, so it passes unchanged. It
  must still pass.
- **Superseded path** (`group-service.ts` around line 2051) already clears the
  slot and sends `takeBackAvailable: false`. Unchanged.
- **Leave, remove, block** clear the slot as before (#13 L3, RC4). The tests
  already in `take-back.int.test.ts` keep covering this.
- **Rate limiter** (`TAKE_BACKS_PER_GROUP_PER_MINUTE = 3`) stays as a backstop,
  since grace can be set as low as 1 s. It is now covered by a unit test only.
- **Stale reader card.** The reader already hides the card after a `take_back`
  loss, so there is no UI change.

## Security-sensitive areas
Security-sensitive: yes
- Authorization of the `leader.takeBack` handler (who may seize the lead):
  `lifecycle/lifecycle-service.ts` `handoff()`, which feeds
  `lifecycle/leader-controls.ts` `takeBack()`.
- Group membership and role state persisted on user data (the Redis group
  document field `displacedLeaderId`, no schema change).
- The `takeback.offered` notice on resume (`groups/group-service.ts`).
- This closes #25 M1. It adds no endpoint, message, dependency or secret.

## Implementer model
Implementer model: opus
Reason: security-sensitive (authorization of a lead-seizing action). The code
change is one line, but the test rewrites have to keep the race and Redis
paths green and must not lose rate-limit coverage.

## Test plan (mapped to the acceptance criteria)
All server tests use `startTestServer` with `ManualScheduler`, as in
`take-back.int.test.ts`. "Ping-pong" uses that file's `handedOff()` helper.

| AC | Test | File |
|---|---|---|
| AC1 `handoff_disconnect` | The old leader is detached when a disconnect handoff fires, so it gets no `leader.lost`. Its right shows as `takeback.offered` on resume, then `leader.takeBack` gives `leader.granted reason take_back`. Existing tests stay ("rejoins as a member ... offered the take-back", "takes the lead back"). Add an assertion that the record had `displacedLeaderId === leaderId` before the take-back | `take-back.int.test.ts` |
| AC2 `handoff_inactivity` | Existing test asserts `leader.lost` `takeBackAvailable: true`. Extend it, or add one: the attached old leader sends `leader.takeBack` and gets `leader.granted reason take_back` | `handoff.int.test.ts` |
| AC3 | Updated "takes the lead back" test: the interim leader's `leader.lost` is `{ reason: 'take_back', takeBackAvailable: false }`; the store has `leaderId: original`, `displacedLeaderId: undefined` | `take-back.int.test.ts` |
| AC4 live | After the take-back, the interim leader (`next`) sends `leader.takeBack` and gets `NOT_ALLOWED` with the fixed message; the record is unchanged | `take-back.int.test.ts` |
| AC4 reload | The interim leader closes and resumes with the member token from `leader.lost`. It gets `group.joined role member`, no `takeback.offered` (check `received` after a round-trip), and `leader.takeBack` gets `NOT_ALLOWED` | `take-back.int.test.ts` |
| AC4 restart (Redis) | Handoff, take-back, clean stop, start on the same prefix. The stored document has no `displacedLeaderId`. The interim leader resumes as a member, gets no offer, and `leader.takeBack` gets `NOT_ALLOWED` | `restart.redis.test.ts` |
| AC5 ping-pong | Replaces "rate-limits a take-back ping-pong". Handoff, then the original takes back, then the interim leader's second `leader.takeBack` gets `NOT_ALLOWED` (not `RATE_LIMITED`). The original stays leader (store `leaderId`, and `position.update` from it is acked) | `take-back.int.test.ts` |
| AC5 limiter kept | Unit: with the stub host (slot fixed to `MEMBER`), 3 `takeBack` calls succeed and the 4th is `RATE_LIMITED`; another group is unaffected | `leader-controls.test.ts` |
| AC6 fresh handoff | After a take-back the original leader closes. After the grace, a handoff fires to the next eligible member, and `displacedLeaderId` is the original leader. The original resumes, is offered, and its take-back succeeds | `take-back.int.test.ts` |
| AC7 | Unchanged suites pass: `restart-handoff.int.test.ts` (superseded, row 9), `take-back.int.test.ts` (leaves L3, removal RC10/M3), `blocklist.int.test.ts`, `multi-cluster.redis.test.ts`, `multi-delivery.redis.test.ts`, `roles-privacy.int.test.ts`, `succession.test.ts` | as listed |
| AC8 | Docs chunk below; reviewer checks README, the protocol JSDoc and the reader comment | `README.md`, `packages/protocol/src/*.ts` |
| client | `roles.int.test.ts` "hands off ... takes back": `leadershipLost` has `takeBackAvailable: false` | `packages/client/test/integration/roles.int.test.ts` |

Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Run the Redis
suites with `REDIS_URL` set (local Docker Redis).

## Implementation chunks
1. `fix(server): keep the take-back slot empty after a take-back`:
   `lifecycle-service.ts`, the comments in `group-store.ts` and `succession.ts`,
   and the existing tests that encode the old behaviour (`take-back.int.test.ts`
   swap test and the ping-pong rate-limit test, `packages/client/test/integration/roles.int.test.ts`
   line 80) so the commit is green on its own.
2. `test(server): cover take-back refusal after a take-back and a reload`:
   AC4 live and reload, AC5 ping-pong, AC6 fresh handoff, AC2 inactivity
   take-back, and the limiter unit test in `leader-controls.test.ts`.
3. `test(server): keep the empty take-back slot across a redis restart`:
   `restart.redis.test.ts` (AC4 restart).
4. `docs: offer take-back only after a handoff`: `README.md` bullets, the
   `packages/protocol` JSDoc (`messages.ts`, `errors.ts`) and the reader comment
   in `use-leadership-flow.ts`.

## Questions for Gate 2
- **Q-1 Interim leader eligible again as successor.** After a take-back, a
  later auto handoff may pick the same interim leader again, because it is the
  vice or the earliest admitted member and no longer holds the slot. Before
  the fix it was skipped as a side effect of the bug. Recommended: accept,
  because it is the normal successor rule (the spec leaves that rule out of
  scope) and the original leader then gets take-back as usual (AC6).
  Alternative: keep skipping the last take-back loser on the next handoff.
  That needs a new stored field and changes the successor rule, so it would
  be its own issue.

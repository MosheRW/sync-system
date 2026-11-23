# Security review (plan): #32 offer take-back only after a handoff loss

Mode: plan. Reviewed: [spec.md](spec.md), [architecture.md](architecture.md)
(commit f41c4af), #25 advisory M1 ([../25/security.md](../25/security.md)) and
the current code on `fix/32-take-back-after-handoff-only`.

**Verdict: PASS** (critical 0, high 0, medium 0, low 4).

The plan fixes the one stored value every check reads. It closes #25 M1 at
the authorization layer, not only in the UI hint.

## Assets and trust boundaries
- **Asset:** the leader role of a group. The leader sees the join codes,
  approves joiners, removes and blocks members, and moves the shared page.
- **Asset:** the take-back right, stored only as `GroupRecord.displacedLeaderId`
  (in memory, or in the Redis group document).
- **Boundary:** WebSocket client to server. `leader.takeBack` is a member
  action, and any member can send it from a scripted client whatever the UI
  shows.
- **Boundary:** instance to instance (Redis document, group lease, remote
  effects) when several instances run.

## Threats (STRIDE, short)
| Threat | Who | What | Status after the plan |
|---|---|---|---|
| Elevation of privilege | hostile interim leader | re-seizes the lead after the original leader took it back (#25 M1) | closed: slot cleared on `take_back`; `takeBack()` refuses with `NOT_ALLOWED` before spending budget |
| Elevation via reload | same | resume with the member token from `leader.lost`, or its older leader token, to get `takeback.offered` and retry | closed: the right is never in a token; resume offers only when `pid === displacedLeaderId` |
| Elevation via restart (Redis) | same | rely on a restored document | closed for documents written by new code; see L1 for documents written by old code |
| Tampering via race | any member | race a take-back against a grace handoff, here or on another instance | unchanged and safe: both run under the group lock/lease and re-read the record; the grace timer is fenced by `term` (`onGraceEnd`), and a take-back bumps the term |
| DoS (lead ping-pong) | two members | swap the lead quickly | now needs a fresh handoff each cycle (grace, min 1 s); limiter of 3 per minute per group stays as a backstop |

## What I checked in the code
Every reader of `displacedLeaderId` in `apps/sync-server/src`:
- `lifecycle/leader-controls.ts:137-141` `takeBack()`: `NOT_ALLOWED` unless
  the caller is the slot holder, checked before the limiter. Runs under
  `asMember`, which takes the group lock and re-reads the record
  (`group-service.ts:1223-1240`).
- `groups/group-service.ts:2407` member resume: `takeback.offered` only for
  the slot holder.
- `lifecycle/lifecycle-service.ts:425` `announce()`: the hint is derived from
  the stored record, so the hint and the right cannot drift.
- `lifecycle/succession.ts:30` `pickSuccessor` and `group-service.ts:2280`
  `protectedPids`: eligibility and eviction (see Q-1).
- Clears: recreate (1124), block list (1596), leave (1677), recreate by a
  recovering leader (1915), supersede (2055). All patch `undefined`.
- Store semantics: `InMemoryGroupStore.patch` spreads the patch, so an
  `undefined` value clears the field. The Redis document drops undefined
  fields, and `displacedLeaderId` is `id.optional()`. The existing clear
  paths already depend on this.

Other ways the interim leader could still get the lead, all checked:
- **Its old leader token** (from `leader.granted` when it took over). On a
  live record `classifyToken` gives `live`, and `resumeLive` makes it a
  member resume: `canSupersede` needs `recoveredAt` (a recreated record),
  and every grant in this process has `term >= recoveredAt`. No path.
- **Restart with the in-memory store** (pre-existing, not changed by #32):
  see L2.
- **Cross-instance:** the take-back and the grace handoff share the group
  lease; `multi-cluster.redis.test.ts` (take-back racing a grace handoff on
  another instance) must stay green.
- **Normal succession after a later handoff:** see Q-1. This is the intended
  rule, not a bypass.

## Findings
| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | architecture.md "Risks: Upgrade with Redis" | A Redis document written by old code just after a take-back still names the interim leader. That member can take back once after the upgrade. With several instances, **old-code instances keep writing the bad slot during a rolling upgrade**, so the window lasts until the last instance runs the new code, not just until the deploy starts. The impact is bounded: one more seizure per affected group, only while it lives, and the next leader change clears the slot. | Accept without a migration, as planned. The PR body note must say "until every instance runs the new version" and suggest a non-rolling restart for operators who care. No startup scan. |
| L2 | Low | `groups/resume.ts` `classifyToken` / `canSupersede`; recreate path (pre-existing, out of scope) | With the **in-memory** store, if the server restarts shortly after a take-back, the interim leader's old leader token is still inside its `lat` window. It can recreate the group first and lead until the original leader resumes with its later token and supersedes it (RC6). This is the designed recovery rule and does not depend on `displacedLeaderId`, so #32 neither causes nor fixes it. | No change in #32. Mention it in the Gate 3 advisories so the user can decide whether a follow-up should revoke or ignore leader tokens with an older term than the latest take-back. |
| L3 | Low | architecture.md test plan, "AC5 limiter kept" | The integration test that reached the take-back limiter goes away. The unit test covers the order (refusal before budget) but not the wiring through `connection.ts` → `GroupService` → `LeaderControls`. The limiter can still be reached in production through handoff/take-back cycles (grace can be 1 s). | Keep the unit test as planned and also assert there that a `NOT_ALLOWED` refusal spends no budget (a refused call followed by 3 accepted calls). Optional: an integration test that reaches `RATE_LIMITED` through repeated disconnect handoff + take-back cycles with `ManualScheduler`. |
| L4 | Low | `lifecycle/leader-controls.ts:128-134` (JSDoc of `takeBack()`) | It says "the slot now holds the leader it replaced", which is the old, now wrong, rule. It is not in the plan's file list. A wrong security comment invites someone to "fix" the code back. | Add it to the docs/comments chunk: "the slot is cleared; only a later handoff fills it again". |

No critical, high or medium findings.

## Q-1: interim leader eligible again as successor
Accept, as the architect recommends. After the fix the interim leader is a
plain member. It can lead again only if the original leader stays away or
inactive for the whole grace period, under the normal successor rule (vice
first, else earliest admitted). The original leader then holds the slot and
can take back (AC6). This gives no lasting control and matches what any other
member could get. Being skipped before was a side effect of the bug. The same
goes for `protectedPids`: losing eviction protection is correct for a plain
member.

## Required controls (part of the plan)
1. **RC-1** `handoff()` writes `displacedLeaderId: undefined` when the reason
   is `take_back`, and `old` for both handoff reasons. Inside the same single
   patch, under the group lock (no second write).
2. **RC-2** `announce()` keeps deriving `takeBackAvailable` from the stored
   record. No separate `reason`-based branch that could disagree with the
   stored right.
3. **RC-3** `LeaderControls.takeBack()` keeps its order: authorization
   (`NOT_ALLOWED`) before the limiter. `TAKE_BACKS_PER_GROUP_PER_MINUTE`
   stays 3 and the limiter is not removed.
4. **RC-4** No take-back claim is added to any token or to client-supplied
   input. The right stays server-side only.
5. **RC-5** Tests prove the refusal **at the protocol level** (a raw
   `leader.takeBack` from the interim leader returns `NOT_ALLOWED` and the
   store's `leaderId` does not change): live, after reload with the
   `leader.lost` member token, and after a Redis restart. A test that only
   checks `takeBackAvailable` is not enough.
6. **RC-6** `multi-cluster.redis.test.ts` (take-back vs grace handoff across
   instances) and `restart-handoff.int.test.ts` (superseded) pass unchanged.
7. **RC-7** The limiter unit test also asserts that a refused (`NOT_ALLOWED`)
   call spends no budget (L3).
8. **RC-8** The stale `takeBack()` JSDoc is corrected (L4). The PR body states
   the upgrade window "until every instance runs the new version" (L1).

## What I will check in code mode
- The diff of `handoff()` is exactly RC-1, and nothing else writes the slot.
- No new reads of the slot that bypass the lock; no token or schema changes.
- The tests in RC-5 to RC-7 exist, send real `leader.takeBack` frames, and
  assert both the error and the unchanged store.
- No new logging of participant IDs or tokens (`displacedLeaderId` stays in the
  logger redaction list).
- Docs (README, protocol JSDoc, `leader-controls.ts` JSDoc, reader comment)
  match the new rule.
- gitleaks, semgrep and `npm audit` (no dependency change expected).

Issue: https://github.com/MosheRW/sync-system/issues/32

# fix: offer take-back only after a handoff loss (follow-up to #25)

Path: fast. Follow-up to #25 (PR #31), security plan review advisory M1
(`docs/issues/25/security.md`) and plan section 3 / Q-A2
(`docs/issues/25/architecture.md`). Behaviour comes from #13.

**Blocker for #37 (PRD item 9c, docs/changelog/release).** Decided at #37
Gate 1 on 2026-11-22 to fix this first as its own fast-path issue.

## Problem
In `apps/sync-server/src/lifecycle/lifecycle-service.ts` `handoff()`, every
leader change sets `record.displacedLeaderId` to the leader just replaced,
including a take-back.

## Current behaviour
`leader.lost` carries `takeBackAvailable: record.displacedLeaderId === old`,
which is always true. After the original leader takes the lead back, the
interim leader (vice, else earliest admitted connected member) is offered
take-back and can take the lead again. The two can pass the lead back and
forth, rate-limited per group. A hostile member can keep re-seizing the lead
(see codes, approve joiners, remove people). The reader hiding the card is UX
only; a scripted client can call `leader.takeBack` regardless.

## Expected behaviour
Take-back is offered only to a leader displaced by a handoff
(`handoff_disconnect`, `handoff_inactivity`), never to one displaced by
`take_back`:
- On a `take_back`, `displacedLeaderId` is left `undefined`.
- `leader.lost` for a `take_back` carries `takeBackAvailable: false`.
- `leader.takeBack` from the interim leader after a take-back returns
  `NOT_ALLOWED`.

## Acceptance criteria
- [ ] After `handoff_disconnect`, the displaced leader gets `leader.lost` with `takeBackAvailable: true` and `leader.takeBack` succeeds (unit test, unchanged behaviour).
- [ ] Same for `handoff_inactivity` (unit test).
- [ ] After the original leader takes the lead back, `displacedLeaderId` is `undefined` and the interim leader's `leader.lost` carries `takeBackAvailable: false` (unit test).
- [ ] `leader.takeBack` from the interim leader after a take-back is rejected with `NOT_ALLOWED` (unit/integration test), including after a reconnect or reload.
- [ ] Ping-pong scenario test: handoff, take-back, then a second `leader.takeBack` by the interim leader fails; the original leader stays leader.
- [ ] A leader displaced by a later handoff (after a take-back) is offered take-back as before (no regression on a fresh handoff).
- [ ] Existing leader-recovery (`superseded`) and holder-leaves/blocked slot clearing tests still pass.
- [ ] Protocol or docs that describe `takeBackAvailable` are updated if they say a take-back can be taken back.

## Out of scope
- Reader UI changes (it already hides the take-back card after a take-back loss, Gate 2 Q-A2 of #25).
- Changing the per-group rate limit or the auto handoff choice of interim leader.
- Authentication or key changes (#24).

## Open questions
None.

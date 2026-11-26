# Spec: fix(server): share join-attempt limits across instances through redis

Issue: #41 (follow-up to #35)

## Problem
With several server instances sharing Redis (PRD item 9a, #35), join-attempt limits stay per instance (Gate 2 decision Q-B6). With N instances the per-app join budget (600/min) becomes N x 600/min, and the code-guessing budget for alphanumeric and group codes multiplies by N. Door-code failures and pauses are already global.

References: `docs/issues/35/security.md` section 7 (P2-6, F22, medium advisory); `docs/issues/35/architecture.md` 12.11 and 12.22 (Q-B6).

## Acceptance criteria
- [ ] The per-app join budget is enforced across all instances sharing one Redis (total stays 600/min regardless of N).
- [ ] The code-guessing budget (group and alphanumeric codes, per code/IP bucket) is enforced globally with the same budgets as the per-instance limits today.
- [ ] A two-instance test shows the budget is shared: attempts split across instance A and B are rejected once the combined count exceeds the budget.
- [ ] Counters expire with the same windows as today (no unbounded Redis keys).
- [ ] Behaviour when Redis is unavailable (fail-closed or fail-open) is decided in the plan, documented, and covered by a test.
- [ ] Single-instance behaviour and existing limit tests are unchanged.
- [ ] The README note that join limits multiply per instance is removed or updated.

## Out of scope
- Door-code failure counters and pauses (already global).
- Changing budget values or window lengths.
- Other rate limits not related to joining.

## Open questions
- Fail-closed or fail-open when Redis is down? Security view required; to be decided at Gate 2 by the user.

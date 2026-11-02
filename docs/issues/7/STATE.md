# State: #7 Harden token recovery (follow-up to #5)
- Path: fast
- Phase: grooming
- Branch: fix/7-token-recovery-hardening
- PR: none
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: pm

## Notes
- Follow-up to #5 (PRD item 3), merged in PR #6 (a9cfa02). GitHub issue numbers are not PRD item numbers.
- Spec: docs/issues/7/spec.md (25 acceptance criteria covering L1-L5, A1, A3, A4).
- Out of scope: A2 (history only), A5 (safe, no fix needed).

## User decisions (Gate 1)
- D1 (L2): per-app tokens.check budget 600/min, fixed constant, on top of the per-connection limit; no global budget.
- D2 (L3): inbound queued-bytes cap, fixed constant 4 x maxPayload next to the 32-message cap; not configurable; MAX_BUFFERED_BYTES unchanged.
- D3 (L4): only "a resume timeout is not a stable connection"; no give-up-after-N, no stableAfterMs > requestTimeoutMs validation.
- D4 (A1): per-action error texts (not generic) for RATE_LIMITED (position update, tokens.check) and NOT_LEADER (position update, group.end, blocklist.set); codes unchanged.

## Open questions
- none

## Deviations from plan
- none

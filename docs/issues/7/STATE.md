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
- Spec: docs/issues/7/spec.md (24 acceptance criteria covering L1-L5, A1, A3, A4).
- Out of scope: A2 (history only), A5 (safe, no fix needed).

## Open questions
- Q1 (L2): default per-app tokens.check budget (proposed 600/min per app, constant); also a global budget?
- Q2 (L3): cap queued inbound bytes (spec's reading) vs outbound buffer; constant (4 x maxPayload) or configurable?
- Q3 (L4): besides "resume timeout is not stable", also give up after N consecutive resume timeouts, or validate stableAfterMs > requestTimeoutMs?
- Q4 (A1): proposed texts "Too many requests" / "Only the leader can do this" acceptable?

## Deviations from plan
- none

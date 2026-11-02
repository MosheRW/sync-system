# State: #7 Harden token recovery (follow-up to #5)
- Path: fast
- Phase: architecture
- Branch: fix/7-token-recovery-hardening
- PR: #8 (draft)
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security

## Notes
- Follow-up to #5 (PRD item 3), merged in PR #6 (a9cfa02). GitHub issue numbers are not PRD item numbers.
- Spec: docs/issues/7/spec.md (25 acceptance criteria covering L1-L5, A1, A3, A4).
- Out of scope: A2 (history only), A5 (safe, no fix needed).
- Plan: docs/issues/7/architecture.md (10 planned commits, no new dependencies, no protocol change). Security-sensitive: yes, so security plan review is due before Gate 2.
- Security plan review (round 1): PASS, see docs/issues/7/security.md. 0 critical, 0 high, 1 medium (M1, made required control R5: a storage read failure must not drop dirty marks), 5 low (L-1 drop while resume pending can still reset attempts; L-2 one client can use up the per-app tokens.check budget; L-3 validate `previous` secret too; L-4 residual cross-tab case accepted; L-5 aggregate inbound memory note). Required controls R1-R8.
- Advisory for Gate 2: client-side fallback texts in packages/client/src/errors.ts for RATE_LIMITED / NOT_LEADER are left unchanged (spec scopes A1 to the server).

## User decisions (Gate 1)
- D1 (L2): per-app tokens.check budget 600/min, fixed constant, on top of the per-connection limit; no global budget.
- D2 (L3): inbound queued-bytes cap, fixed constant 4 x maxPayload next to the 32-message cap; not configurable; MAX_BUFFERED_BYTES unchanged.
- D3 (L4): only "a resume timeout is not a stable connection"; no give-up-after-N, no stableAfterMs > requestTimeoutMs validation.
- D4 (A1): per-action error texts (not generic) for RATE_LIMITED (position update, tokens.check) and NOT_LEADER (position update, group.end, blocklist.set); codes unchanged.

## Open questions
- none

## Deviations from plan
- none

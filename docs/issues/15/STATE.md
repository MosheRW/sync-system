# State: #15 feat: React/Next package (PRD item 6)
- Path: full
- Phase: implementation
- Branch: feat/15-react-package
- PR: #16 (draft)
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan (round 1): opus (rule) → PASS
- engineer implement: opus (architect `Implementer model: opus`) → in progress
## Gate 2 decisions (user, 2026-11-05)
- Plan approved as written.
- Q-A accepted: `setJoiningEnabled` = lock/unlock of all joining; "expiry" =
  QR ticket `expiresAt` and code generation; README states codes still work
  after unlock, so a leaked code needs rotation.
- Q-B accepted: approval `paused` = `JOIN_PAUSED`.
- Q-C accepted: member vice flag tracked from provider mount, event-only,
  reset on group change or end.
- Q-D accepted: `useStoredGroups` auto-check opt-in `checkOnConnect`, default off.
- Every security control R1-R14 (security.md, incl. M1-M4 and L1-L7) is required.
## Security controls → commits
- (filled in as the chunks land)
## Open questions
- none
## Deviations from plan
- none

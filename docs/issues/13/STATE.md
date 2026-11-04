# State: #13 feat: roles, timers and group lifecycle (PRD item 5)
- Path: full
- Phase: architecture
- Branch: feat/13-roles-lifecycle
- PR: #14 (draft)
- Plan approved by user: no
- QA loops: 0
- Last updated by: security
## Gate 1 decisions
- User accepted every recommended default Q1.1-Q7 as written in `spec.md`,
  with one change: Q5.5 display names use the existing strict #10 rule
  (`normalizeDisplayName`), not a new looser rule. Recorded in `spec.md`
  ("Gate 1 decisions").
## Open questions
- Gate 2 questions Q-A to Q-E in `docs/issues/13/architecture.md` section 14.3 (each with a recommendation).
- Security plan review (`docs/issues/13/security.md`): FAIL on H1 (stale
  displaced leader out-terms the real leader after a restart via an
  in-process handoff); architect to revise section 6.6 before Gate 2.
  Required controls RC1-RC14 become part of the plan.
## Deviations from plan
- Board: `.claude/github-project.env` had an empty `GH_PROJECT_NUMBER`; the card was added to project 8 ("sync system") with a temporary config copy. Restored to 8 on this branch in 8880f2d.
## Model log
- architect planning: opus (default for architect; pm NEXT_MODEL opus) → DONE; recommends opus for engineer (Implementer model: opus)
- security plan review: opus (rule: security always opus) → FAIL (H1); recommends opus for architect revision

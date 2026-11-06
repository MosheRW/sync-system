# State: #24 feat: reading app sync UX: join and follow (PRD item 8a)
- Path: full
- Phase: grooming
- Spec approved at Gate 1: yes (2026-11-06, "Accept all")
- Split: AC38-AC49 moved to #25 (8b, depends on this issue; no branch yet)
- Branch: feat/24-reading-app-sync-ux
- PR: none
- Plan approved by user: no
- Security-sensitive: yes (expected: new QR dependency, CSP and Permissions-Policy changes, user input in code and name entry; the architect confirms)
- Review rounds: 0
- Last updated by: pm
## Model log
- pm groom: opus (orchestrator: broad scope) → DONE
- pm update-spec: sonnet (default) → DONE
## Open questions
- None for the user; Q1-Q11 accepted at Gate 1 (see spec.md "Decisions").
- For the architect: QR library choice, browser test tool, position payload format, config names.
- For the security plan review: public API key in the bundle (Q9), new QR dependency (Q2).
## Deviations from plan
- None yet.

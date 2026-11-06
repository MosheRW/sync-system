# State: #24 feat: reading app sync UX: join and follow (PRD item 8a)
- Path: full
- Phase: architecture
- Spec approved at Gate 1: yes (2026-11-06, "Accept all")
- Split: AC38-AC49 moved to #25 (8b, depends on this issue; no branch yet)
- Branch: feat/24-reading-app-sync-ux
- PR: #26
- Plan approved by user: no
- Security-sensitive: yes (security plan review PASS, docs/issues/24/security.md: 0 critical, 0 high, 1 medium, 10 low; required controls R1-R14)
- Review rounds: 0
- Design decisions: U1-U4 accepted (2026-11-06, "Accept all"), recorded in spec.md
- Last updated by: security
## Model log
- pm groom: opus (orchestrator: broad scope) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (orchestrator: new flows) → DONE
- architect plan: opus (default) → DONE
- security plan: opus (rule) → PASS
## Open questions
- For the user at Gate 2 (architecture.md section 18): Q-A1 dev registration (reuse dev-app, no server change), Q-A2 / ADR 0009 storage (sessionStorage), Q-A3 phone-lock test length (25 s vs 30 s grace), ADR 0007 QR library (lean-qr), ADR 0008 e2e tool (Playwright).
- Security plan review done (PASS): Q9 public key accepted (M1 needs deployment controls); recommends ADR 0007 lean-qr, 0008 Playwright, 0009 sessionStorage, Q-A1 option 1 (option 2 without the server change would be High).
## Deviations from plan
- None yet.

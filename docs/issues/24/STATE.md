# State: #24 feat: reading app sync UX: join and follow (PRD item 8a)
- Path: full
- Phase: architecture
- Spec approved at Gate 1: yes (2026-11-06, "Accept all")
- Split: AC38-AC49 moved to #25 (8b, depends on this issue; no branch yet)
- Branch: feat/24-reading-app-sync-ux
- PR: #26
- Plan approved by user: no
- Security-sensitive: yes (architecture.md section 16: new deps lean-qr and @playwright/test, CSP connect-src, public API key in config, codes/names/tickets input, tokens in sessionStorage)
- Review rounds: 0
- Design decisions: U1-U4 accepted (2026-11-06, "Accept all"), recorded in spec.md
- Last updated by: architect
## Model log
- pm groom: opus (orchestrator: broad scope) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (orchestrator: new flows) → DONE
- architect plan: opus (default) → DONE
## Open questions
- For the user at Gate 2 (architecture.md section 18): Q-A1 dev registration (reuse dev-app, no server change), Q-A2 / ADR 0009 storage (sessionStorage), Q-A3 phone-lock test length (25 s vs 30 s grace), ADR 0007 QR library (lean-qr), ADR 0008 e2e tool (Playwright).
- For the security plan review: public API key in the bundle (Q9), lean-qr (ADR 0007), Playwright browser download in CI (ADR 0008), CSP connect-src change.
## Deviations from plan
- None yet.

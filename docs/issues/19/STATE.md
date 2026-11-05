# State: #19 feat: reading app content, text direction (RTL) and content fingerprint (PRD item 7)
- Path: full
- Phase: implementation
- Branch: feat/19-reading-app-content
- PR: #20
- Plan approved by user: yes (Gate 2, 2026-11-05)
- Security-sensitive: yes
- Review rounds: 0
- Spec approved at Gate 1: yes
- Last updated by: engineer
## Model log
- pm groom: sonnet (default) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (NEXT_MODEL from pm; new app, no existing screen pattern) → DONE
- pm update-spec-2: sonnet (default) → DONE
- designer update: sonnet (clear pattern from first design pass) → DONE
- pm update-spec-3: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
## Gate 2 decisions (2026-11-05)
- ADRs 0001-0006: recommended option accepted for each (0005 E1 escaping wording fixed per security.md F5).
- Q2: AC32-AC35 kept. Q3: `different-content` -> block. Q4: malformed leader metadata -> `unsupported-schema` / block.
- Q5: status-screen copy in architecture.md 6.4 accepted. Q6: sample texts as proposed.
## Open questions
- Q1-Q9 resolved at Gate 1 (see "Decisions (Gate 1)" in spec.md). Architect to confirm Q4 details (display hints, Unicode normalisation) and may tighten the AC23 ID pattern.
- Design decisions for architect: D1-D6 and open questions 1-6 in design.md (library, not-found, single-book mode added).
- Post-design decisions (AC24-AC41) added to spec.md. AC32-AC35 are orchestrator recommendations the user may override at Gate 2.
- Architect/security: is `?src=<url>` restricted (allow-list of origins via config)? Env variable names and config validation (AC30).
- Gate 2: ADRs 0001-0006 (each needs a decision) and architecture.md section 12 Q1-Q6 (AC32-AC35 overrides, different-content outcome, malformed leader metadata, new status-screen copy, sample texts).
- Security plan review: PASS (0 critical, 0 high, 6 medium, 6 low); required controls C1-C11 in security.md are part of the plan.
## Deviations from plan
- none

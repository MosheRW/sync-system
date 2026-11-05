# State: #19 feat: reading app content, text direction (RTL) and content fingerprint (PRD item 7)
- Path: full
- Phase: design
- Branch: feat/19-reading-app-content
- PR: none
- Plan approved by user: no
- Security-sensitive: no
- Review rounds: 0
- Spec approved at Gate 1: yes
- Last updated by: pm
## Model log
- pm groom: sonnet (default) → DONE
- pm update-spec: sonnet (default) → DONE
- designer design: opus (NEXT_MODEL from pm; new app, no existing screen pattern) → DONE
- pm update-spec-2: sonnet (default) → DONE
- designer update: sonnet (clear pattern from first design pass) → DONE
- pm update-spec-3: sonnet (default) → DONE
## Open questions
- Q1-Q9 resolved at Gate 1 (see "Decisions (Gate 1)" in spec.md). Architect to confirm Q4 details (display hints, Unicode normalisation) and may tighten the AC23 ID pattern.
- Design decisions for architect: D1-D6 and open questions 1-6 in design.md (library, not-found, single-book mode added).
- Post-design decisions (AC24-AC41) added to spec.md. AC32-AC35 are orchestrator recommendations the user may override at Gate 2.
- Architect/security: is `?src=<url>` restricted (allow-list of origins via config)? Env variable names and config validation (AC30).
## Deviations from plan
- none

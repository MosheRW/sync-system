# State: #58 feat(server): read secrets from files via _FILE variables (follow-up to #51)
- Path: full
- Phase: architecture
- Branch: feat/58-secret-files
- PR: #76
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
## Open questions
- Q1-Q7 answered at Gate 1 (see architecture.md header)
- Gate 2: ADR 0023 route (option 1 recommended); confirm path shown only for existing entries (architecture 9.2)
- Gate 2: security plan review PASS (docs/issues/58/security.md): show required controls C1-C11 and advisories F1-F5; security recommends accepting the Q6 narrowing
## Deviations from plan
- none

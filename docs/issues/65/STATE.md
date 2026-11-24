# State: #65 fix: correct Docker Hub namespace, npm identity wording, gitleaks false positives
- Path: fast
- Phase: architecture
- Branch: fix/65-release-namespace-gitleaks
- PR: #66
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: one tier up, secret-scan scope) → DONE (ADR 0022 Proposed; NEXT_MODEL opus for engineer)
- security plan: opus (rule: security always opus) → PASS (0 critical, 0 high, 1 medium, 4 low; see security.md)
## Open questions
- ADR 0022 (secret-scan suppressions): decide at Gate 2, recommended option 1
- Confirm `moshewin` is the Docker Hub user (login name), not an org
## Deviations from plan
- Plan adds a fix not in the spec: the step 4 `npm whoami` check compared against `mosherw` and would always fail; it becomes `moshe-winberg`

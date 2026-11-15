# State: #36 feat: 9b health, readiness and config errors
- Path: full
- Phase: architecture
- Branch: feat/36-health-readiness-config-errors
- PR: none
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: pm
## Model log
- pm grooming: sonnet (default) → DONE
- pm gate-1 update: sonnet (default) → DONE
## Gate 1 decisions (2026-11-15)
- Q20: check and fail (overrides the warn recommendation); new AC37a; naming rule proposed by architect.
- Q21: read version from package.json at runtime; package.json must be in the built image.
- Q22: yes, /ready 503 from the start of close().
- Q23: yes, if fenced / pub-sub state is already observable; else raise at Gate 2.
- Q24: keep truncated echo for non-secret values; document the rule.
- Q25: no /ready for the reader.
- Q26: /health additive only (version, storage).
- AC41 narrowed; no escape-hatch switch.
## Open questions
- None from Gate 1. For the architect at Gate 2: AC37a naming rule, `package.json` in the built image, observability of fenced / pub-sub state.
## Deviations from plan
- None.

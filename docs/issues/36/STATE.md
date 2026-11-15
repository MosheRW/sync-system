# State: #36 feat: 9b health, readiness and config errors
- Path: full
- Phase: architecture
- Branch: feat/36-health-readiness-config-errors
- PR: #43
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: security
## Model log
- pm grooming: sonnet (default) → DONE
- pm gate-1 update: sonnet (default) → DONE
- architect plan: opus (default + pm NEXT_MODEL) → DONE
## Gate 1 decisions (2026-11-15)
- Q20: check and fail (overrides the warn recommendation); new AC37a; naming rule proposed by architect.
- Q21: read version from package.json at runtime; package.json must be in the built image.
- Q22: yes, /ready 503 from the start of close().
- Q23: yes, if fenced / pub-sub state is already observable; else raise at Gate 2.
- Q24: keep truncated echo for non-secret values; document the rule.
- Q25: no /ready for the reader.
- Q26: /health additive only (version, storage).
- AC41 narrowed; no escape-hatch switch.
## Security plan review (round 1)
- PASS: critical 0, high 0, medium 1 (M1 fail-open risk of collect-mode refactor), low 6. Required controls C1-C10 in docs/issues/36/security.md are part of the plan.
## Open questions
- Gate 2 (architecture.md section 13): Q-1 ADR 0015 naming rule; Q-2 reader gets the same check; Q-3 echo of validated numbers; Q-4 apps checks skipped against an invalid ceiling; Q-5 "did you mean"; Q-6 shutdown drain (informational).
- Resolved by the plan: `package.json` is already in the image (pnpm deploy output, runtime copies /out whole); fenced and pub/sub-unhealthy are already observable via `storage.status()` (Q23 met without new machinery).
## Deviations from plan
- None.

# State: #36 feat: 9b health, readiness and config errors
- Path: full
- Phase: implementation
- Branch: feat/36-health-readiness-config-errors
- PR: #43
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
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
## Gate 2 decisions (2026-11-15, "Approve all")
- Plan approved: yes.
- Q-1: ADR 0015 option 1 (ten prefixes plus `_CEILING`; `SYNC_TEST_*` and Kubernetes / Docker link names excluded). ADR set to Accepted.
- Q-2: yes, the reader gets the same check (`READER_` family); chunk 10 is in.
- Q-3: yes, keep validated integers (parsed, not raw) and valid namespaces in messages.
- Q-4: yes, skip only the comparisons that need an invalid ceiling (the run still exits 1).
- Q-5: yes, "did you mean" from the known-name list only (within 2 edits).
- Q-6: accept no drain window; no follow-up issue.
- Security controls C1-C10 are mandatory; low advisories L1-L7 applied as the plan absorbs them (L4: flagged names cut at 48 characters).
## Security plan review (round 1)
- PASS: critical 0, high 0, medium 1 (M1 fail-open risk of collect-mode refactor), low 6. Required controls C1-C10 in docs/issues/36/security.md are part of the plan.
## Open questions
- None (Gate 2 answered every question).
- Resolved by the plan: `package.json` is already in the image (pnpm deploy output, runtime copies /out whole); fenced and pub/sub-unhealthy are already observable via `storage.status()` (Q23 met without new machinery).
## Deviations from plan
- None.

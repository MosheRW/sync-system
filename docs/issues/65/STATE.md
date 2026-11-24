# State: #65 fix: correct Docker Hub namespace, npm identity wording, gitleaks false positives
- Path: fast
- Phase: validation
- Branch: fix/65-release-namespace-gitleaks
- PR: #66
- Plan approved by user: yes (Gate 2, 2026-11-24)
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: qa
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: one tier up, secret-scan scope) → DONE (ADR 0022 Proposed; NEXT_MODEL opus for engineer)
- security plan: opus (rule: security always opus) → PASS (0 critical, 0 high, 1 medium, 4 low; see security.md)
- engineer implement: opus (rule: security-sensitive plan, Implementer model: opus) → DONE
- qa review r1: sonnet (NEXT_MODEL) → PASS (lint, typecheck, server suite, release-files, pinned gitleaks scan clean; 8/8 criteria met; QA verdict: PASS)
## Gate 2 decisions (2026-11-24)
- ADR 0022: option 1 (one fingerprint per finding in `.gitleaksignore`) → Accepted
- Security advisories folded in: M1 (scope test also requires rule `generic-api-key`), L1 (gitleaks container runs with `--network none`, tested), L3 (step 0 checks the Docker Hub username is `moshewin`), L4 (`npm logout` after the step 0 npm checks; no claim that Docker Hub personal tokens can be scoped to one repository)
- Docker Hub: `moshewin` is the user's Docker Hub username (not an org); push target `docker.io/moshewin/sync-system-server`, login `-u moshewin`
- L2 resolved outside the repo: the user holds the Docker Hub namespace `mosherw` with an empty `sync-system-server` placeholder repo (anti-squatting); never a push target
## Open questions
- none
## Deviations from plan
- Plan adds a fix not in the spec: the step 4 `npm whoami` check compared against `mosherw` and would always fail; it becomes `moshe-winberg`
- ADR 0017 amendment also drops the "limited to the one repository" Docker Hub token wording from option D1 (security L4), and its amendment section names `ghcr.io/mosherw/sync-system-server` once more (GHCR count outside `docs/issues/` 20 → 21; no GHCR name changed)
- Step 0 npm item says "signed in on the host for these checks only" instead of naming the login command: `RELEASING.md` must not contain the string `npm login` (existing test)
- The step 0 scan block also checks that `GITLEAKS_IMAGE` is set and pinned by digest before running
- The `.gitleaksignore` scope test also checks negative examples (rule, path, format, wrong `jwt.ts` line) against the same check function

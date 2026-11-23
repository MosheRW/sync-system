# State: #37 feat: public docs, changelog and first semver release (PRD item 9c)

- Path: full
- Phase: architecture (plan revised after security plan review round 1, 2026-11-23; security plan review round 2 next, then Gate 2)
- Branch: feat/37-docs-changelog-release
- PR: #50
- Plan approved by user: no
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: architect

## Model log

- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → FAIL (H1: shared check/publish container; architect revises ADR 0016 E and RELEASING procedure)
- architect revise r1: opus (rule) → DONE

## Open questions

- Gate 2: ADR 0016 (versioning and npm release) and ADR 0017 (server image build, tags, push), both Proposed.
- Gate 2: Q-E (metadata URLs, npm 2FA), Q-H (no new env maxima before 1.0.0), Q-I (`SECURITY.md`): see `architecture.md` section 2.
- Gate 2: security advisories L1, L2, L4 (= Q-I), L5, L6 (architect recommends adopting all): see `architecture.md` section 9a.
- Gate 2: Q-L3 (author email in public history, `.claude.zip`): user decision, no architect recommendation; see `architecture.md` section 2.

## Gate 1 decisions (2026-11-22)

- Paused: 9c architecture does not start until #32, #12 and #21 are all merged.
- Q-A, Q17, Q18, Q-C, Q-D, Q-F, Q-G decided: see `docs/issues/37/spec.md`.

## Deviations from plan

- None yet.

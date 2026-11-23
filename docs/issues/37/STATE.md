# State: #37 feat: public docs, changelog and first semver release (PRD item 9c)

- Path: full
- Phase: architecture (Gate 2 decisions recorded 2026-11-23; security plan re-check of E2 pending)
- Branch: feat/37-docs-changelog-release
- PR: #50
- Plan approved by user: pending (approved at Gate 2 with E2, subject to a security plan re-check of the E2 token handling)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: architect

## Model log

- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → FAIL (H1: shared check/publish container; architect revises ADR 0016 E and RELEASING procedure)
- architect revise r1: opus (rule) → DONE
- security plan r2: opus (rule) → PASS
- architect gate2-update: opus (rule) → DONE

## Open questions

- Security plan re-check (round 3) of ADR 0016 E2 and the amended C1 (`architecture.md` sections 7 steps 3-5, 9a H1 row, 9b). `security.md` C1 still carries the E1 wording (`npm login`, `--otp`) until then.

## Gate 1 decisions (2026-11-22)

- Paused: 9c architecture does not start until #32, #12 and #21 are all merged.
- Q-A, Q17, Q18, Q-C, Q-D, Q-F, Q-G decided: see `docs/issues/37/spec.md`.

## Gate 2 decisions (2026-11-23)

- ADR 0016: A1, B1, C1, D1, F1 as recommended; **E2 instead of E1**: npm auth with a granular access token (read and write, `@mosherw` packages only, 7-day expiry, IP allowlist, bypass 2FA), created right before the publish, read on the host with `read -rs`, piped over `docker exec -i` stdin into a mode-600 `/root/.npmrc` of the publish container only, container removed by a host `trap`, token revoked right after the publish. Two-container split (H1/C1) kept. E1 (interactive `npm login` + OTP) recorded as considered, not chosen (user: less typing, no OTP per package). Package Publishing access: "Require two-factor authentication or a granular access token with bypass 2FA enabled"; account 2FA "Authorization and writes". ADR set to Accepted.
- ADR 0017: A1, B1, C1, D1 as recommended. ADR set to Accepted.
- Q-E: URLs as proposed. Q-H: no new maxima, reference shows `none`. Q-I/L4: add `SECURITY.md`.
- Q-L3: keep the personal email in existing history (no rewrite); new commits use the GitHub noreply address (repo-local git config). Untrack `.claude.zip` (chunk 15a; stays in history).
- Advisories adopted: L1, L2, L4, L5, L6, L8, L9, L10, L11. Not adopted: L7.
- Doc nits from security round 2 fixed (Phase A stated once in section 7; ADR list continuation lines: inline code spans no longer broken across lines).

## Deviations from plan

- None yet.

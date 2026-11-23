# State: #37 feat: public docs, changelog and first semver release (PRD item 9c)

- Path: full
- Phase: validation
- Branch: feat/37-docs-changelog-release
- PR: #50
- Plan approved by user: yes (Gate 2, 2026-11-23; security round 3 PASS; L12 and L13 also adopted)
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: qa

## Model log

- pm grooming: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → FAIL (H1: shared check/publish container; architect revises ADR 0016 E and RELEASING procedure)
- architect revise r1: opus (rule) → DONE
- security plan r2: opus (rule) → PASS
- architect gate2-update: opus (rule) → DONE
- security plan r3: opus (rule) → PASS
- engineer implement: opus (rule) → DONE
- qa review r1: opus (NEXT_MODEL) → FAIL

## Open questions

- Security plan re-check (round 3) of ADR 0016 E2: done, PASS. `security.md` C1 amended for E2; M6 (failure-tolerant trap commands) folded into C1/C3 for the engineer; L12, L13 advisory (`security.md` section 7).

## QA verdict

- Round 1 (commit 32ccee5): **FAIL**, 1 finding. `RELEASING.md` dry run step 3 (`SRC_URL="file://$(pwd)"`, line 435) fails on Git Bash because the step 6 block sets `MSYS_NO_PATHCONV=1`; it needs `cygpath -m`. All checks are otherwise green in local Docker CI (only the known repo-hygiene failure), e2e 9/9, dry-run steps 2, 4 and 6 pass with that fix, and AC55 is confirmed (nothing published). Advisories A1-A4 (stale PR body, step 4 trailing `docker ps` line, react tarball not reproducible across node images, roadmap blank line) are non-blocking. Review comment on PR #50.

## Gate 1 decisions (2026-11-22)

- Paused: 9c architecture does not start until #32, #12 and #21 are all merged.
- Q-A, Q17, Q18, Q-C, Q-D, Q-F, Q-G decided: see `docs/issues/37/spec.md`.

## Gate 2 decisions (2026-11-23)

- ADR 0016: A1, B1, C1, D1, F1 as recommended; **E2 instead of E1**: npm auth with a granular access token (read and write, `@mosherw` packages only, 7-day expiry, IP allowlist, bypass 2FA), created right before the publish, read on the host with `read -rs`, piped over `docker exec -i` stdin into a mode-600 `/root/.npmrc` of the publish container only, container removed by a host `trap`, token revoked right after the publish. Two-container split (H1/C1) kept. E1 (interactive `npm login` + OTP) recorded as considered, not chosen (user: less typing, no OTP per package). Package Publishing access: "Require two-factor authentication or a granular access token with bypass 2FA enabled"; account 2FA "Authorization and writes". ADR set to Accepted.
- ADR 0017: A1, B1, C1, D1 as recommended. ADR set to Accepted.
- Q-E: URLs as proposed. Q-H: no new maxima, reference shows `none`. Q-I/L4: add `SECURITY.md`.
- Q-L3: keep the personal email in existing history (no rewrite); new commits use the GitHub noreply address (repo-local git config). Untrack `.claude.zip` (chunk 15a; stays in history).
- Advisories adopted: L1, L2, L4, L5, L6, L8, L9, L10, L11, and (after security round 3) L12, L13. Not adopted: L7.
- Doc nits from security round 2 fixed (Phase A stated once in section 7; ADR list continuation lines: inline code spans no longer broken across lines).

## Deviations from plan

- Smoke install uses `--prefer-offline` instead of `--offline` (the plan's stated fallback): in a fresh CI container the pnpm store has the packages but not the registry metadata `--offline` needs (`ERR_PNPM_NO_OFFLINE_META`). Exact lockfile versions and `--ignore-scripts` are unchanged (commit 8348492).
- Root `devDependencies` gains `@types/node` (same `^24.19.2` range and resolved version already in the lockfile, no new package in the tree) so `scripts/tsconfig.json` can type-check the release scripts with Node types.
- `pack:check` looks for the `@mosherw/sync-system-source` condition in every packed manifest field except `scripts`: pnpm packs the packages' `typecheck` script, which names the condition as a `tsc` flag (never run by consumers). Packed scripts are checked against the full lifecycle deny-list (L10); `build`, `test`, `typecheck` remain.
- The SSR smoke check does not require `navigator` to be absent (Node 24 defines it); `window`, `document`, `localStorage`, `sessionStorage` must be absent and `WebSocket` is replaced by a counter that must stay at 0.
- The GitHub slugger lives in `scripts/release/check-links.ts`, not `lib.ts`.
- Changesets accepted the private server in the fixed group: no fallback needed.
- Reader env table: checked by name only (comment in `apps/reader/test/readme.node.test.ts`), as the plan allowed.
- Operator guide also holds the moved "Joining", "Roles and group lifecycle" and "Recovery and tokens" sections (verbatim, the drift tests read them there); `docs/protocol.md` is a new self-contained wire reference.

## Known pre-existing failure

- `repo-hygiene.test.ts` "CI workflow ... runs on push and pull_request" fails on `main` too (push/pull_request triggers are commented out while Actions is billing-blocked). It also stops the `RELEASING.md` step 2 block at `pnpm test` in a dry run; everything before and after it was verified separately.

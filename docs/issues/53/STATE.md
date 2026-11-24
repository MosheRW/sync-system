# State: #53 chore(release): investigate react tarball hash differences across node:24 images
- Path: fast
- Phase: ready-to-merge
- Branch: chore/53-react-tarball-hash
- PR: #62
- Plan approved by user: yes (revised Gate 2, 2026-11-24: ADR 0020 option D1 with controls R1–R7, L1–L4)
- Security-sensitive: yes (revised plan: release tooling pack:check, lockfile, published react manifest, pin-bump procedure)
- Review rounds: 2
- Last updated by: orchestrator
## Model log
- pm groom: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- engineer implement: opus (rule: Implementer model) → DONE
- qa review r1: sonnet (NEXT_MODEL) → FAIL (react tarball integrity flips between two values on repeated packs in the pinned image; pnpm pack key order of two workspace devDependencies; ADR 0019 premise false)
- architect revise: opus (rule: failed once) → DONE
- security plan r1 (revised plan): opus (rule) → PASS
- engineer fix r1: opus (rule: fix round) → DONE
- qa review r2: opus (rule: round 2) → PASS (40/40 identical pack:check values per package in the pinned image; negative checks fail closed; lockfile diff is the 3-line removal; 3/3 AC met; https://github.com/MosheRW/sync-system/pull/62#issuecomment-7125610848)
- security code r2: opus (rule) → PASS (low A1: pnpmfile guard misses .npmrc / pnpm-workspace.yaml settings, configDependencies plugins, dashed env name)
- Gate 3: 2026-11-24, PR #62 ready to merge; A1 awaiting user decision

## Open questions
- none (security advisory A1 → follow-up #63, fixed in its own run)
## Deviations from plan
- Plan premise disproved in QA r1: the round 1 plan (ADR 0019, option A, implemented in c4c5fbc and 0f4a1e5) assumed react packs byte-identically in the pinned image. It does not: pnpm 10 inserts the two workspace: devDependencies of react in I/O completion order (p-map-values), so repeated pack:check runs give two values. Plan revised to ADR 0020 (supersedes 0019); fix lands as new commits on top, no rewrite.
- docs/roadmap.md not updated on this branch: the #52 branch already changes it and parallel edits would conflict. Roadmap update for #53 deferred to the next branch after #52 merges.
- docs/conventions.md: the new 0019 row widened the ADR column, so prettier reflowed the whole "Packages, license and release (#37)" table (whitespace only).
- Fix r1 (ADR 0020, D1): docs/conventions.md table reflowed by prettier again (whitespace only) for the new "Tarball reproducibility" row.
- Fix r1: ADR 0020's Decision section now spells out the approved security controls (R1–R7, L1–L4 as R4/R5 wording) instead of the architect's weaker L1/L2 draft, recorded at acceptance.
- Fix r1: besides the planned checks, checkWorkspaceRanges also reports a published dir whose manifest has another name (fail closed); checkNoPnpmfile matches the two env names case-insensitively (NPM_CONFIG_* too) and treats an empty value as set.
- Fix r1: L4 covers the root .pnpmfile.cjs and the two env variables only, as approved. A `pnpmfile` setting in .npmrc or pnpm-workspace.yaml is not checked (neither file sets one today).
- Fix r1: security's informational note (only apps/reader/Dockerfile copies packages/react/package.json) checked: the Dockerfiles are untouched (R6); the reader image installs with --frozen-lockfile from the updated lockfile and package.json, which stay consistent (verified by the frozen install in the pinned image).
- Fix r1 verification (local Docker, pinned node:24 digest + redis sidecar): full check suite green; 32/32 identical pack:check values for all three packages (react sha512-miMW9yo6…); negative checks fail closed; lockfile diff is the 3-line removal; RELEASING.md step 2 dry run twice, diff of the two INTEGRITY.txt empty. Details in the PR #62 comment.

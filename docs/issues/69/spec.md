# Spec: #69 fix(release): check the pnpm version before packing

Issue: https://github.com/MosheRW/sync-system/issues/69 (follow-up to #67, advisory L1 in `docs/issues/67/security.md`)

## Problem
Production packing in `scripts/release/lib.ts` (`pnpmCommand` / `packOne` / `packAll`) trusts that the resolved pnpm is the pinned one. A release run on Linux with a non-corepack global pnpm of another major on PATH, outside `pnpm run`, would pack with a pnpm whose handling of `--config.ignore-pnpmfile` is untested (ADR 0021, option A cons).

## Acceptance criteria
- [ ] `packAll` runs `pnpm --version` once (not per package) and fails closed, with a clear message, unless it equals the root `package.json` `packageManager` version.
- [ ] A test covers the mismatch case (packAll fails, message names expected and actual versions, nothing is packed) and the match case (packAll proceeds).
- [ ] The pnpmfile guard behaviour from ADR 0021 is not weakened (existing guard tests still pass, unchanged).

## Out of scope
- Changing the ADR 0021 decision.

# Spec: #63 close remaining pnpmfile routes in pack:check guard

Issue: https://github.com/MosheRW/sync-system/issues/63
Path: fast | Type: chore

## Problem
`pack:check` (`scripts/release/pack-check.ts` -> `packAndCheck` in
`scripts/release/lib.ts`) runs `checkNoPnpmfile` before `packAll` so an install
hook cannot rewrite the packed `package.json`. Follow-up to #53 (PR #62),
low advisory A1 from the round-2 security code review. The guard misses three
routes by which pnpm can load a hook:

1. a `pnpmfile` / `global-pnpmfile` setting in `.npmrc` or `pnpm-workspace.yaml`;
2. `configDependencies` entries that are pnpm plugins (`pnpm-plugin-*`), which can ship a pnpmfile;
3. the dashed environment variable `npm_config_global-pnpmfile` (the guard only checks the underscore form).

None is used in the repo today; each needs a reviewed repo change or control of
the build environment. This is a gap in a warning check, not a bypass of
publish integrity.

## Acceptance criteria
- [ ] `pack:check` cannot be affected by a pnpmfile loaded through any of the three routes above (shown by tests or a documented reproduction for each).
- [ ] The existing guards and the 40/40 identical-pack result from #53 still hold.
- [ ] `RELEASING.md` is updated if the guard's documented scope changes.
- [ ] Lint (incl. link check), typecheck and `pnpm test` pass in the local Docker CI.

## Out of scope
- Changing the publish flow itself or anything beyond `pack:check`.
- Other install-hook classes (lifecycle scripts, `.pnpmfile.cjs` handling already covered by #53).

## Open questions
- Fix approach (architect decides): pass `--ignore-pnpmfile` to `pnpm pack` (removes the whole class; support in pnpm 10.28.0 must be verified, not assumed) or extend `checkNoPnpmfile`. The plan must pick one and say why.

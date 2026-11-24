# 0021. Pack with pnpmfiles ignored

- Status: Accepted (Gate 2, 2026-11-24: user chose the recommended C, with
  security controls R1–R7 and advisories L1–L4 of
  [`docs/issues/63/security.md`](../issues/63/security.md))
- Date: 2026-11-24
- Issue: #63
- Amends: [0020](0020-deterministic-packed-manifests.md) (its "No pnpmfile"
  control)

## Context

`pack:check` (and `smoke`, which packs through the same `packAll`) runs
`pnpm pack` on the three published packages. A pnpmfile's `beforePacking`
hook can rewrite the packed `package.json` after every source-level check,
so ADR 0020 (R7, L4) added `checkNoPnpmfile`: it fails if a root
`.pnpmfile.cjs` exists or `npm_config_pnpmfile` /
`npm_config_global_pnpmfile` is set.

The round 2 security review of #53 (advisory A1) found routes the guard
misses. We reproduced each against pnpm 10.28.0 (the pinned
`packageManager`), in a throwaway workspace outside the repo, with a
`beforePacking` hook that adds a marker field to the packed manifest
(evidence in [`docs/issues/63/architecture.md`](../issues/63/architecture.md#evidence)).
Every one of these loads the hook today:

- `pnpmfile=` and `global-pnpmfile=` in `.npmrc`;
- `pnpmfile:` and `globalPnpmfile:` in `pnpm-workspace.yaml`;
- a `configDependencies` entry named `pnpm-plugin-*`, `@pnpm/plugin-*` or
  `@scope/pnpm-plugin-*` (in `pnpm-workspace.yaml` or `package.json`
  `pnpm.configDependencies`), whose `pnpmfile.cjs` pnpm loads
  automatically;
- the dashed env var `npm_config_global-pnpmfile`;
- `npm_config_userconfig` pointing at an rc file that sets `pnpmfile` (not
  in the advisory; found while testing). The user-level `~/.npmrc` and
  pnpm's global `rc` file are the same class.

pnpm 10.28.0 has one switch that turns the whole class off:
`ignorePnpmfile`. In `getConfig` (`cli/cli-utils`), all pnpmfile loading
(default `.pnpmfile.cjs`, `pnpmfile`, `globalPnpmfile`, config-dependency
plugins, and their `updateConfig` hooks) sits inside
`if (!config.ignorePnpmfile)`. `pnpm pack --ignore-pnpmfile` is rejected
(`Unknown option: 'ignore-pnpmfile'`: `pack` does not list it), but the
generic form `--config.ignore-pnpmfile=true` is accepted and works.

## Options

1. **A. Pack with `--config.ignore-pnpmfile=true`.** Pros: closes every
   route above, and any other way of naming a pnpmfile, in one place,
   because it switches off the loader rather than enumerating its inputs;
   a CLI setting beats `.npmrc`, `pnpm-workspace.yaml` and env
   (`ignore-pnpmfile=false` in each was tried and lost); the tarball bytes
   are unchanged (same sha512 with and without the flag for all three real
   packages). Cons: the `--config.` form is not validated, so a future pnpm
   that renames the setting would ignore it silently (covered by an
   integration test, see Consequences); it does not stop the outer
   `pnpm pack:check` process from loading a pnpmfile.
2. **B. Extend `checkNoPnpmfile`.** Parse root `.npmrc` and
   `pnpm-workspace.yaml` for `pnpmfile`, `global-pnpmfile`/`globalPnpmfile`
   and `configDependencies`, read `pnpm.configDependencies`, normalise env
   names (`-` to `_`). Pros: fails loudly and names the setting. Cons: an
   enumeration, so it is incomplete by design (user `~/.npmrc`,
   `npm_config_userconfig`, pnpm's global rc, `XDG_CONFIG_HOME`, any route a
   later pnpm adds); YAML parsing without a dependency (the release scripts
   use Node built-ins only) means a regex that can be dodged with YAML
   syntax.
3. **C. A plus a small guard fix (recommended).** Pack with the flag, keep
   `checkNoPnpmfile` as an early, loud signal, and make its env match
   treat `-` and `_` alike so the documented env check is not trivially
   bypassed. No config-file parsing.

## Decision

C, because the flag removes the class at the point that matters (the
`pnpm pack` child that writes the tarball) and holds against routes nobody
has listed, while the existing guard keeps its value as a fast, explicit
failure for the common cases. Extending the guard into a config parser (B)
adds code that can never be complete.

## Consequences

- `packAll` (used by `pack:check`, `release:dry-run` and `smoke`) passes
  `--config.ignore-pnpmfile=true` to every `pnpm pack`.
- An integration test packs a throwaway workspace with each route active,
  once without the flag (the hook must apply: proves the fixture is live)
  and once through the release scripts' pack call (the hook must not
  apply). A pnpm upgrade that drops or renames the setting fails this test.
- The outer `pnpm pack:check` / `pnpm smoke` invocation still loads a
  configured pnpmfile and so runs its code. That needs a reviewed repo
  change or control of the build environment, which is the trust boundary
  for the whole release; `RELEASING.md` says so.
- `configDependencies` are still fetched into `node_modules/.pnpm-config`
  by any pnpm command (fetch only, no scripts run); only loading their
  pnpmfile is suppressed.

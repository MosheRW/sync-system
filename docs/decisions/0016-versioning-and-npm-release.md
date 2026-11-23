# 0016. Versioning and npm release process

- Status: Proposed
- Date: 2026-11-23
- Issue: #37

## Context

9c (#37) makes the first public release. Already decided (Gate 1 of #35 and
#37, not reopened here):

- Changesets makes the changelog, with one fixed version group (Q6).
- The server and the three published packages share one version (Q-F); the
  first release is 1.0.0, protocol version 1, minimum 1 (Q7, AC48).
- Packages: `@mosherw/sync-system-protocol`, `-client`, `-react` (Q16). The
  server and reader stay private on npm, renamed `@mosherw/sync-system-server`
  and `@mosherw/sync-system-reader` (Q-C). The reader is outside the version
  group (AC48).
- Everything is released by hand from a `node:24` Docker container, tokens
  passed at run time only, published with `--access public` without
  provenance (Q-D; Gate 1 named `pnpm publish`, refined by option E1 below
  to `npm publish` of the `pnpm pack` output). Agents never publish (AC55).

Still open, and decided by this ADR: how Changesets is configured, when the
version bump happens, how internal dependencies are pinned in the published
manifests, what is tagged in git, and how the maintainer authenticates to npm
(Q-E: metadata URLs and 2FA).

Constraints: GitHub Actions is billing-blocked, so nothing may depend on a
workflow; credentials are never written to the repo, the image or a file that
outlives the release container; the publish step must be repeatable from a
clean clone of a tag.

## Options

### A. Changesets configuration

1. **Fixed group of four (`protocol`, `client`, `react`, `server`),
   `privatePackages: { version: true, tag: false }`, reader in `ignore`,
   built-in changelog generator (`@changesets/cli/changelog`).**
   Pros: one number everywhere, the server's `package.json` (read by
   `/health`) bumps with the packages; the default generator needs no GitHub
   token. Cons: the private server gets a `CHANGELOG.md` too (wanted: the
   image has a changelog).
2. Fixed group of the three published packages, server bumped by hand.
   Cons: two sources of the version; `/health` drift is likely.
3. `@changesets/changelog-github` generator. Cons: needs a GitHub token at
   `version` time and network access to the API; adds a dependency.

### B. When the version bump happens

1. **In a reviewed PR ("release PR"):** `pnpm changeset version` runs on a
   branch, the bumped `package.json` files and `CHANGELOG.md` files are
   committed and reviewed, then merged. The publish step only tags and
   publishes what `main` already says.
   Pros: what is published is exactly what was reviewed; QA can check the
   changelog text (AC48, AC49) before release; the publish container never
   writes to git history except the tag. Cons: one extra PR per release.
2. In the release container at publish time, then pushed to `main`.
   Cons: the container needs git write access; the changelog is never
   reviewed; a failed publish leaves a half-pushed state.

For 1.0.0 the release PR is this issue's PR (#37).

### C. Internal dependency ranges in published manifests

1. **`workspace:*` (published as the exact version, e.g. `1.0.0`).**
   Pros: an app always gets the combination that was tested together; one
   copy of the protocol schemas. Cons: an app that also lists the protocol
   package directly must keep it on the same version.
2. `workspace:^` (published as `^1.0.0`). Cons: allows untested mixes
   (client 1.0.0 with protocol 1.3.0) inside one fixed group, for no gain.

### D. Git tags

1. **One annotated tag `vX.Y.Z` per release** (all packages share the
   version), created **on the maintainer's host** with their normal git
   credentials, on the release PR's merge commit after checking it is on
   `origin/main` and carries version `X.Y.Z`. Containers receive a `git
bundle` of the tag and assert `HEAD` equals that commit and a clean
   tree; no git credential ever enters a container (security plan review
   M1). Pros: one tag for the image, the GitHub release and every
   package. Cons: none for a fixed group.
2. Changesets' per-package tags (`@mosherw/sync-system-client@1.0.0`, ...)
   via `changeset publish`. Cons: four tags for one release; `changeset
publish` uses `npm publish` and would not rewrite `workspace:` ranges the
   way `pnpm publish` does.

### E. npm authentication and 2FA (Q-E)

1. **Two containers. A build container that never receives a credential
   runs install, checks, build, smoke and `pnpm pack:check --out`, which
   keeps the three checked tarballs and their `sha512` integrity. A fresh
   publish container (`node:24` pinned by digest; no clone, no `pnpm
install`, no project code) receives only those three `.tgz` files,
   recomputes and compares their integrity, then runs an interactive `npm
login` (account 2FA "authorization and writes") and `npm publish
<tarball> --access public --ignore-scripts --otp <code>` for protocol,
   client, react in that order, compares `npm view <pkg>@X.Y.Z
dist.integrity` with the printed value, and runs `npm logout` from a
   `trap ... EXIT` set before the login. After the first publish each
   package is set to "require two-factor authentication and disallow
   tokens".** Pros: no long-lived token exists at all; the session token
   and the OTP never share a container with the dev-dependency tree, so a
   compromised dependency cannot steal them or trojan the publishing tool
   (security plan review H1); the published bytes are exactly the checked
   tarballs. Cons: the maintainer types an OTP per package (an expired OTP
   is retried with a new one; a package already published is skipped after
   `npm view` confirms it) and copies three files between containers.
   pnpm rewrites `workspace:*` ranges and applies `publishConfig` at pack
   time, so `npm publish` of the tarball is correct.
   Residual: a compromised dev dependency in the build container could
   still alter `dist/` before packing; this rests on the frozen, audited
   lockfile, as in CI.
2. A granular access token (publish, `@mosherw/*` only, 7-day expiry)
   passed as `NPM_TOKEN` at `docker run -e`. Pros: no typing. Cons: a token
   with publish rights exists outside the container (shell history, password
   manager); it must be allowed to bypass 2FA, which weakens option 1's
   "disallow tokens" setting.
3. One container for checks and publish (`npm login` after the checks,
   `pnpm -r publish --otp`). Rejected (security plan review H1): the dev
   dependency tree runs as root in the same container before the login and
   can capture the session and OTP or alter `dist/`; `pnpm -r` also
   publishes any package that loses `private: true` by mistake.

### F. Package metadata (Q-E)

1. **`repository: { type: "git", url: "git+https://github.com/MosheRW/sync-system.git",
directory: "<package path>" }`, `homepage:
"https://github.com/MosheRW/sync-system/tree/main/<package path>#readme"`,
   `bugs: "https://github.com/MosheRW/sync-system/issues"`** (Q18: the repo
   stays `MosheRW/sync-system`). Pros: npm shows the right source folder.
2. Repository URL without `directory`. Cons: npm links the monorepo root.

## Decision

A1, B1, C1, D1, E1 and F1.

- `.changeset/config.json`: `fixed` = the four packages above,
  `ignore` = `["@mosherw/sync-system-reader"]`, `privatePackages:
{ "version": true, "tag": false }`, `access: "public"`, `baseBranch:
"main"`, `commit: false`, `changelog: "@changesets/cli/changelog"`,
  `updateInternalDependencies: "patch"`.
- `@changesets/cli` is a root dev dependency, pinned to one exact version,
  never allowed to run build scripts; `@changesets/changelog-github` is not
  used.
- Publishing is `npm publish <tarball> --access public --ignore-scripts
--otp <code>` for each of the three tarballs that `pnpm pack:check --out`
  verified in the credential-free build container (built from a bundle of
  the host-created tag), run in a separate fresh publish container
  (`node:24@sha256:<digest>`) with a `sha512` comparison before and a
  `dist.integrity` comparison after, and `npm logout` on every exit path.
  Never `pnpm -r publish`, never `changeset publish`.
- The set of non-private workspace packages is exactly the three published
  names; a test and `pack:check` enforce it.
- Published manifests carry a `publishConfig.exports` without the repo's
  `@mosherw/sync-system-source` condition (it points at `src/`, which is not
  shipped).

## Consequences

- Every user-visible change adds a `.changeset/*.md` file in its PR; a
  release starts with a release PR that runs `pnpm changeset version`.
- `/health` reports the shared version because the server is in the group.
- No npm token exists between releases. Losing the 2FA device blocks
  releases until recovery codes are used; the maintainer keeps them.
- No provenance (Q-D): `npm audit signatures` shows the packages as
  unsigned. Adopting an Actions workflow later (OIDC trusted publishing)
  replaces option E1 for CI, documented in `RELEASING.md`.
- A new root dev dependency (`@changesets/cli` and its tree) must pass
  `pnpm audit --audit-level=high`.

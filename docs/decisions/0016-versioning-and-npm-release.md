# 0016. Versioning and npm release process

- Status: Accepted (Gate 2, 2026-11-23: user chose A1, B1, C1, D1, F1 as
  recommended and E2 instead of the recommended E1)
- Date: 2026-11-23
- Issue: #37
- Amended by: #65 (the npm user in the `npm whoami` check, 2026-11-24)

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
  provenance (Q-D; Gate 1 named `pnpm publish`, refined by option E below
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
   `origin/main` and carries version `X.Y.Z`. Containers receive a
   `git bundle` of the tag and assert `HEAD` equals that commit and a clean
   tree; no git credential ever enters a container (security plan review
   M1). Pros: one tag for the image, the GitHub release and every
   package. Cons: none for a fixed group.
2. Changesets' per-package tags (`@mosherw/sync-system-client@1.0.0`, ...)
   via `changeset publish`. Cons: four tags for one release;
   `changeset publish` uses `npm publish` and would not rewrite `workspace:` ranges the
   way `pnpm publish` does.

### E. npm authentication and 2FA (Q-E)

All options except E3 share the **two-container split** (security plan
review H1): a build container that never receives a credential runs
install, checks, build, smoke and `pnpm pack:check --out`, which keeps the
three checked tarballs and their `sha512` integrity. A fresh publish
container (`node:24` pinned by digest; no clone, no `pnpm install`, no
project code) receives only those three `.tgz` files and `INTEGRITY.txt`,
checks the literal file names, that they are regular files, the packed
`name`/`version`, and recomputes and compares the integrity, all before any
credential exists; publishes `npm publish <literal tarball path> --access
public --ignore-scripts` for protocol, client, react in that order; and
compares `npm view <pkg>@X.Y.Z dist.integrity` with the printed value.
pnpm rewrites `workspace:*` ranges and applies `publishConfig` at pack
time, so `npm publish` of the tarball is correct. Residual for all
options: a compromised dev dependency in the build container could still
alter `dist/` before packing; this rests on the frozen, audited lockfile,
as in CI. The options differ in how npm authenticates.

1. Interactive `npm login` inside the publish container (account 2FA
   "authorization and writes"), `npm publish ... --otp <code>` per
   package, `npm logout` from a `trap ... EXIT` set before the login;
   after the first publish each package is set to "Require two-factor
   authentication and disallow tokens". Pros: no token exists at all;
   every publish needs a fresh OTP. Cons: the maintainer types an OTP per
   package (an expired OTP is retried with a new one) and logs in
   interactively in the container. **Considered, not chosen** (Gate 2,
   user's reason: less typing, no OTP per package).
2. **A short-lived granular access token, handed only to the publish
   container.**
   - Token: npmjs.com granular access token, **Read and write**, limited
     to the three packages (from the second release; for the first, the
     `@mosherw` scope, or "All packages" if the form cannot limit
     not-yet-published names, on an account that owns no other packages),
     Organizations no access, **7-day expiry**, allowed IP range = the
     maintainer's public IP, **"Bypass two-factor authentication" on**
     (a token publishes without an OTP; this is the trade-off accepted).
     Created right before the publish step; creating it requires the
     account's 2FA.
   - Hand-off, all from one host subshell (`( set -euo pipefail; ... )`,
     so its `trap` fires when the block ends): a `trap ... EXIT` set
     **before** the token is read runs `docker exec "$C" npm logout` (best
     effort) and `docker rm -f "$C"`, and `unset NPM_TOKEN`; the publish
     container `C` runs detached (`docker run -d --rm ... sleep infinity`, no
     `-e`, no `--env-file`, no bind mount); after the file checks pass,
     the token is read with `read -rs NPM_TOKEN` (no echo, not in
     history), then piped in and `unset` immediately:

     ```sh
     printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" |
       docker exec -i "$C" sh -c 'umask 077 && cat > /root/.npmrc'
     unset NPM_TOKEN
     ```

     `printf` is a shell builtin, so the token is in no process's
     argument list. The token is never a command-line argument, never an
     environment variable of a container (so
     never in `docker inspect`), never a file on the host, never in shell
     history and never in the build container. `npm whoami` must print
     the maintainer's npm user `moshe-winberg` (an owner of the npm org
     `mosherw`) before the first publish.

   - After the publish: `npm logout` and `rm -f /root/.npmrc` in the
     container, the container is removed, and the maintainer **revokes
     the token** on the Access Tokens page right away (before the image
     push), then checks that the page lists no token.
   - Settings: account 2FA stays on "Authorization and writes" (a security
     key if available), recovery codes kept offline, no standing tokens
     between releases. Each package's Publishing access is "**Require
     two-factor authentication or a granular access token with bypass 2FA
     enabled**": interactive publishes still need an OTP, and only a
     granular token with bypass 2FA can publish without one. "Require
     two-factor authentication and disallow tokens" is not used (it would
     reject this token); "Don't require two-factor authentication" is
     never used.

   Pros: no OTP per package, a scriptable publish block; the token never
   shares a container with the dev-dependency tree (H1 still holds); its
   life is minutes, bounded by scope, IP range and expiry. Cons: a bearer
   credential that publishes without an OTP exists for those minutes (on
   the npm page, the clipboard, one host shell variable and the publish
   container); the clipboard (and Windows clipboard history) must be
   cleared after the paste; the package setting must allow bypass tokens
   permanently.

3. One container for checks and publish (`npm login` after the checks,
   `pnpm -r publish --otp`). Rejected (security plan review H1): the dev
   dependency tree runs as root in the same container before the login and
   can capture the session and OTP or alter `dist/`; `pnpm -r` also
   publishes any package that loses `private: true` by mistake.
4. A long-lived token passed as `NPM_TOKEN` with `docker run -e`. Rejected:
   the token lands in `docker inspect`, the process environment and
   usually shell history, and outlives the release.

### F. Package metadata (Q-E)

1. **`repository`: type `git`, url
   `git+https://github.com/MosheRW/sync-system.git`, `directory` = the
   package path; `homepage` =
   `https://github.com/MosheRW/sync-system/tree/main/<package path>#readme`;
   `bugs` = `https://github.com/MosheRW/sync-system/issues`** (Q18: the repo
   stays `MosheRW/sync-system`). Pros: npm shows the right source folder.
2. Repository URL without `directory`. Cons: npm links the monorepo root.

## Decision

A1, B1, C1, D1, E2 and F1 (accepted at Gate 2, 2026-11-23; E2 is the
user's choice over the recommended E1).

- `.changeset/config.json`: `fixed` = the four packages above,
  `ignore` = `["@mosherw/sync-system-reader"]`,
  `privatePackages: { "version": true, "tag": false }`,
  `access: "public"`, `baseBranch: "main"`, `commit: false`, `changelog: "@changesets/cli/changelog"`,
  `updateInternalDependencies: "patch"`.
- `@changesets/cli` is a root dev dependency, pinned to one exact version,
  never allowed to run build scripts; `@changesets/changelog-github` is not
  used.
- Publishing is `npm publish <tarball> --access public --ignore-scripts`
  (no `--otp`) for each of the three tarballs that `pnpm pack:check --out`
  verified in the credential-free build container (built from a bundle of
  the host-created tag), run in a separate fresh publish container
  (`node:24@sha256:<digest>`) with literal file names, a file-type and
  manifest check and a `sha512` comparison before the token is handed in,
  and a `dist.integrity` comparison after. Never `pnpm -r publish`, never
  `changeset publish`, never `npm login`.
- npm authentication is the E2 granular token: created per release with
  the limits above, handed in only over `docker exec -i` stdin to a
  mode-600 `/root/.npmrc` of the publish container, removed with the
  container by a host `trap`, and revoked right after the publish.
- The set of non-private workspace packages is exactly the three published
  names; a test and `pack:check` enforce it.
- Published manifests carry a `publishConfig.exports` without the repo's
  `@mosherw/sync-system-source` condition (it points at `src/`, which is not
  shipped).

## Consequences

- Every user-visible change adds a `.changeset/*.md` file in its PR; a
  release starts with a release PR that runs `pnpm changeset version`.
- `/health` reports the shared version because the server is in the group.
- No npm token exists between releases: each release creates one and
  revokes it within minutes, and it expires after 7 days at the latest.
  Losing the 2FA device blocks token creation (and so releases) until
  recovery codes are used; the maintainer keeps them.
- Because each package allows bypass-2FA granular tokens, a token leaked
  during its short life could publish without an OTP; the scope, IP range,
  expiry and immediate revocation bound this, and `RELEASING.md` states it
  as a residual risk.
- No provenance (Q-D): `npm audit signatures` shows the packages as
  unsigned. Adopting an Actions workflow later (OIDC trusted publishing)
  replaces the E2 token, documented in `RELEASING.md`.
- A new root dev dependency (`@changesets/cli` and its tree) must pass
  `pnpm audit --audit-level=high`.

## Amendment (#65, 2026-11-24)

E2 said `npm whoami` must print `mosherw`. `mosherw` is the npm
organization that owns the `@mosherw` scope; a granular token belongs to a
user, so `npm whoami` prints the maintainer's user `moshe-winberg`, an
owner of that org. The check in `RELEASING.md` step 4 now compares against
`moshe-winberg`, which still refuses a token from any other account.
Step 4 does not call `npm org ls` (the token keeps "Organizations: no
access"); org ownership is checked once in step 0 with
`npm org ls mosherw`. The decision (A1, B1, C1, D1, E2, F1) is unchanged.

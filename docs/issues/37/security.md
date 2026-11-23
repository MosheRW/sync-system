# Security review (plan): #37 public docs, changelog, first semver release (9c)

Mode: plan. Reviewed: [`architecture.md`](architecture.md), [`spec.md`](spec.md),
[ADR 0016](../../decisions/0016-versioning-and-npm-release.md),
[ADR 0017](../../decisions/0017-server-image-publishing.md), and the current
`apps/sync-server/src/version.ts`, `apps/sync-server/Dockerfile`,
`.dockerignore`, `.gitignore`, `package.json` files, `ci.yml`, and the full git
history (626 commits, all refs).

**Result: FAIL**: one high finding (H1). The architect revises the release
procedure (ADR 0016 E/D wording, `RELEASING.md` section 7) before Gate 2.
Everything else is medium/low, and the required controls below go into the plan.

## 1. Assets and trust boundaries

| Asset | Why it matters |
| --- | --- |
| npm publish rights for `@mosherw/*` (session token + 2FA OTP) | Whoever holds them ships code into every app that bundles the client/React packages, browser bundles included |
| GHCR (`write:packages`) and Docker Hub (Read & Write) tokens | Whoever holds them can replace `X.Y.Z`/`latest` images that operators run with `TOKEN_SECRET` and app API keys |
| The published bytes (3 tarballs, 1 multi-arch image) | They must be exactly what was reviewed and checked |
| Git history and repo contents | They go public at the first release (Q18) |
| Names: npm user/scope `mosherw`, Docker Hub namespace `mosherw`, GHCR `mosherw` | The docs tell users to install these names |

Trust boundaries:
1. Maintainer's host, then the release container (credentials typed here).
2. Third-party code that runs in the release container: the whole dev-dependency
   tree (`pnpm install`, lint, typecheck, tests, the new `@changesets/cli` tree),
   plus the `react*` packages the smoke test resolves.
3. Release environment, then the registries (npm, ghcr.io, docker.io).
4. Repo, then the public (history, `.claude/`, `docs/issues/**`, author metadata).

## 2. Threats (STRIDE, brief)

- **Spoofing / tampering of releases:** a compromised dev dependency, or
  malicious code anywhere in the release container, steals the npm session or
  OTP, or alters `dist/` after `pack:check`, and publishes trojaned versions.
  This is the 2025 npm-worm pattern (token harvesting from `~/.npmrc` and
  self-republishing).
- **Tampering:** what gets published differs from the reviewed commit (tag on
  the wrong SHA, rebuilt tarball, dirty tree, stale `dist`).
- **Information disclosure:** a secret in git history, in a tarball, or in the
  image, exposed by the repo going public or by publishing; registry tokens left
  in the OS keychain or shell history.
- **Spoofing (name squatting):** someone else registers the npm user or Docker
  Hub namespace that the public docs point at.
- **Elevation:** a private package (`server`, `reader`, root) published by
  mistake (`pnpm -r publish` publishes every non-private workspace package).
- **Repudiation:** no provenance or signatures (accepted known limit, Q-D).

## 3. Findings

| # | Severity | Location | Issue (attack scenario) | Fix |
| --- | --- | --- | --- | --- |
| H1 | **High** | arch. section 7 Phase B steps 1-4; ADR 0016 E1 ("session token lives in the container's `~/.npmrc`") | Checks and publish happen in **one** container. Step 2 runs `pnpm install`, lint, typecheck, tests, build and smoke as root, which executes the whole dev-dependency tree (hundreds of packages, plus the new Changesets tree and the smoke test's freshly resolved `react*`). Step 4 then runs `npm login` + OTP in the same container. A compromised dev dependency can leave a background process, trojan the corepack-cached `pnpm`/`npm` binary, or rewrite `dist/` after `pack:check`. It then captures the session token and the OTP (or reuses the OTP inside its window) and publishes malicious `@mosherw/sync-system-*` versions. 2FA does not help when the publishing tool itself is trojaned. `--rm` and `npm logout` come too late. | Split Phase B into **two containers**. (a) *Build container*, never given any credential: clone, install, checks, build, `pack:check`, smoke, then `pnpm pack` the three packages to an output dir and print each tarball's `sha512`. (b) *Publish container*: a fresh `node:24` **pinned by digest**, no clone, no `pnpm install`, no project code run. It receives only the three `.tgz` files (`docker cp`), the maintainer checks the hashes against (a)'s output, then runs `npm login` (2FA), `npm publish <file>.tgz --access public --otp <code>` in order protocol, client, react, then `npm logout`. (pnpm has already rewritten `workspace:` ranges at pack time, so `npm publish <tarball>` is correct. ADR 0016's "never `changeset publish`" still holds.) After publish: `npm view <pkg>@X.Y.Z dist.integrity` equals the printed `sha512`. Update ADR 0016 (E1 and the Decision bullet `pnpm -r publish`), `RELEASING.md` and `release:dry-run` accordingly. |
| M1 | Medium | arch. section 7 steps 1 and 3; ADR 0016 vs section 7 (ADR: "clean clone of the tag"; section 7: "clone at `main`" then tag inside the container) | The tag is created and pushed from inside the release container, which needs a GitHub write credential there. The plan never says how it gets in (the likely shortcut is a PAT in the clone URL, which lands in `.git/config` and history). The tagged SHA is also not tied to the commit QA reviewed. | Tag on the **host** with the maintainer's normal git credentials: `git tag -a vX.Y.Z <merge-sha>` after checking `<merge-sha>` is the PR's merge commit on `origin/main` and the version in `package.json` is `X.Y.Z`, then push the tag. The build container clones the public repo **read-only at the tag** (`--branch vX.Y.Z --depth 1`) and asserts `git rev-parse HEAD` equals the tag's commit and `git status --porcelain` is empty. No git credential ever enters a container. |
| M2 | Medium | ADR 0017 D1 | On Docker Desktop (Windows/macOS) an empty `DOCKER_CONFIG` still picks the platform credential helper (`desktop`/`wincred`/`osxkeychain`), so `docker login` writes the tokens to the OS keychain, not the temp dir. `rm -rf "$DOCKER_CONFIG"` does not remove them; only `docker logout` does. If the push fails and the script stops, both tokens stay on the host. | Put `docker logout ghcr.io; docker logout docker.io; rm -rf "$DOCKER_CONFIG"` in a `trap ... EXIT` set **before** the first login. Read each token with `read -rs` into a variable that is `unset` after `printf '%s' "$T" \| docker login -u mosherw --password-stdin <registry>`; never `echo` it. Create both tokens with the shortest expiry (GHCR: classic PAT with only `write:packages`; Docker Hub: PAT limited to the one repo if available), and **revoke them after the release** (written in `RELEASING.md`). |
| M3 | Medium | arch. section 3 (`pack:check`), section 8 | `pnpm -r publish` (and the dry run) publishes **every** workspace package without `private: true`. If a later edit drops `private` from the server, the reader or the root, `pnpm -r publish` puts the server source or reader build on npm. Nothing in the plan checks the set of publishable packages. | `release-files.test.ts` (or `pack:check`) asserts that the set of non-private workspace packages is **exactly** the three published names, and that root, `@mosherw/sync-system-server` and `@mosherw/sync-system-reader` have `private: true`. With H1's fix, publish takes explicit tarball paths, never `-r`. |
| M4 | Medium | arch. section 8 "Human prerequisites", section 7 "First release only" | The repo goes public, and the docs name `@mosherw/*`, `docker.io/mosherw/...` and `ghcr.io/mosherw/...`. If the npm user `mosherw` or the Docker Hub namespace `mosherw` is not already owned by the maintainer, someone else can register it once the names are public and serve malicious packages or images under the documented names. | `RELEASING.md` "first release" checklist, done **before** making the repo public: confirm with `npm whoami` / `npm access list packages @mosherw` that the npm user `mosherw` belongs to the maintainer, with 2FA on "authorization and writes"; create the Docker Hub repo `mosherw/sync-system-server`; confirm GHCR namespace ownership. |
| M5 | Medium | arch. section 3 `smoke`, section 9 | The smoke test's temp project installs `react`, `react-dom` and `@types/*` from the **ranges** in `packages/react/package.json`, with no lockfile. That pulls whatever version is newest at release time and runs it (import, `renderToString`). Section 3 also omits the `--ignore-scripts` that section 9 promises. | Smoke installs with `--ignore-scripts` (in code, tested) and with **exact** versions taken from the workspace `pnpm-lock.yaml` (the versions already audited), not ranges. Keep `--prefer-offline`. (With H1 this never runs where credentials exist, but CI and the dry run still execute it.) |
| L1 | Low | `RELEASING.md` step 1 (`docker run --rm -it node:24 bash`) | The release image is a floating tag, unlike the digest-pinned Dockerfile base (L8). | Pin `node:24@sha256:...` for both release containers in `RELEASING.md`, with the same "bump deliberately" note. Consider `packageManager: "pnpm@10.28.0+sha512.<hash>"` so corepack verifies the pnpm download. |
| L2 | Low | `@changesets/cli` (new dev dependency) | A new supply-chain surface (its tree is roughly 100 packages). It runs only on a developer machine (`changeset version`), never with credentials once H1 is in place. | Exact pin (planned); lockfile in the same commit; `pnpm audit --audit-level=high` clean; do **not** add it or its deps to pnpm `onlyBuiltDependencies` (pnpm 10 keeps dependency lifecycle scripts off by default); never `@changesets/changelog-github` (rejected, needs a token). In code mode the engineer lists the resolved version and its direct deps. |
| L3 | Low | repo going public (Q18) | Regex sweep of all 626 commits (gitleaks is **not installed**) found **no committed secret**. Values found are intentionally public: the dev API key in `config/apps.dev.json` (refused unless `NODE_ENV` is `development`/`test`, `dev-key.ts`), dev/test `TOKEN_SECRET` and Redis passwords in tests and compose, and the CI-only Redis password. Also public after the switch: `.claude/` and the tracked `.claude.zip` (agent prompts, board config, no secrets), `docs/issues/**` (past security reviews, including known open limits), and the maintainer's personal Gmail address as author on about 1,200 commits. | Before flipping visibility the maintainer runs `gitleaks git --redact` over full history and checks repo Settings (Actions secrets, environments, deploy keys) and issue/PR comments. The author email is a privacy choice for the maintainer: accept it, or rewrite history before going public (destructive; user decision; not recommended this late). Use the GitHub noreply email from now on either way. Optionally untrack `.claude.zip`, a stray archive. |
| L4 | Low | arch. section 2 Q-I | Public repo and public packages with no disclosure channel. | Accept Q-I: `SECURITY.md` with private vulnerability reporting (enable it when going public), the supported versions (`1.x`), and "do not open public issues for vulnerabilities". |
| L5 | Low | ADR 0016 consequences, ADR 0017 consequences | No provenance and no image signature (accepted, Q-D), so users cannot verify what they got. | GitHub release notes list each tarball's `sha512` integrity and the image's manifest-list digest (from `imagetools inspect`), so users can pin and compare. |
| L6 | Low | `.gitignore` | A project `.npmrc` with `_authToken` could be committed by accident during a release. | Add a `release-files.test.ts` check that no tracked file named `.npmrc` contains `_authToken` (and that `.npmrc` is not in any tarball, which the `pack:check` allow-list already gives). |

Not findings (checked):
- `SERVER_PACKAGE_NAME` rename: the startup check stays as strong as today
  (exact name match, 64 KiB cap, semver, no content in errors). The new name
  sits in the maintainer's own scope, which **removes** today's squat-able
  `@sync-system` scope. Control C7 keeps it atomic.
- Tarball allow-list in `pack:check` (only `package.json`, `README.md`,
  `CHANGELOG.md`, `LICENSE`, `dist/**` js/d.ts/maps) is the right shape. Source
  maps reference `../src`; `sourcesContent` would only embed already-public GPL
  source. Fine.
- Dockerfile: `COPY LICENSE` (one file, root-owned, runtime stage) and static
  OCI labels add nothing sensitive. `.dockerignore` keeps excluding `.env*`,
  config registries, `.git`, `.claude`, `docs`. Fine with C8.
- Building on the host from a fresh clone of the tag (ADR 0017 A1) instead of
  mounting the Docker socket into the npm container (A2): correct, keep it.
- `docs:links` never fetches URLs (no SSRF or network surface). Fine.
- ci.yml stays `permissions: contents: read`, no secrets. `pack:check` and
  `smoke` add none.
- ADR 0016 E1 over E2 (no long-lived npm token; packages set to "require 2FA and
  disallow tokens"): correct, keep it. H1 is about *where* the login happens,
  not the method.

## 4. Required controls (part of the plan)

- **C1 (H1).** Two-container release: the build container never gets a
  credential; the publish container is a fresh pinned `node:24` that runs no
  project code and publishes the exact `pack:check`-verified tarballs by path
  (`npm publish <tgz> --access public --otp`), with a `sha512` comparison before
  publish and against `npm view ... dist.integrity` after. `npm logout` on every
  exit path. ADR 0016 and `RELEASING.md` updated; `release:dry-run` mirrors it
  (`npm publish <tgz> --dry-run` on the packed files).
- **C2 (M1).** Tag on the host from the verified merge SHA; containers clone
  the tag read-only and assert HEAD == tag commit and a clean tree; no git
  credential inside any container.
- **C3 (M2).** Registry logins: `trap` logout + `rm -rf "$DOCKER_CONFIG"`
  before the first login; `read -rs` + `--password-stdin`; least-scope,
  short-expiry tokens revoked after the release.
- **C4 (M3).** A test asserts the set of non-private packages is exactly the
  three published names, and server, reader and root stay `private: true`.
- **C5 (M4).** First-release checklist confirms ownership of npm `mosherw`,
  Docker Hub `mosherw/sync-system-server` and GHCR before the repo goes public.
- **C6 (M5).** Smoke installs with `--ignore-scripts` and exact
  lockfile-resolved versions for `react`, `react-dom`, `@types/react`,
  `@types/react-dom`.
- **C7.** Rename atomicity: `SERVER_PACKAGE_NAME` and
  `apps/sync-server/package.json` `name` change in the same commit; the
  existing version tests (wrong package refused) pass with the new name; the
  image's `/app/package.json` carries the new name (dry-run `/health` proves it).
- **C8.** Dockerfile: `COPY LICENSE` copies that single file into the runtime
  stage only, never a directory or the repo root (M1 hygiene test extended);
  no `ARG`/`ENV` carrying credentials; `--label` values are only version and
  revision.
- **C9.** `@changesets/cli` exact pin, lockfile updated, `pnpm audit
  --audit-level=high` clean, not allowed to run build scripts.
- **C10.** `pack:check` as planned (allow-list, no `private`, no `workspace:`,
  no `-source` condition, license, `repository.directory`, equal versions).
- **C11.** Docs and examples contain only placeholders or the documented dev
  values. The operator guide keeps the "generate `TOKEN_SECRET`" and "never use
  the dev key in production" guidance, and recommends pinning `X.Y.Z` or a
  digest.

Advisory (do not block): L1 to L6 above. L3 needs a maintainer action before
the repo goes public (gitleaks over full history, settings check, the
author-email decision).

## 5. What code mode will check

- `RELEASING.md` and ADR 0016/0017 text implement C1 to C5 exactly (two
  containers, pinned digests, trap/logout, host tagging, hash comparison, token
  revocation, the first-release ownership checklist).
- `scripts/release/{pack-check,smoke,lib}.ts`: allow-list logic, the
  publishable-set assertion, `--ignore-scripts`, exact versions, temp dir
  outside the workspace and removed in `finally`, no shell string interpolation
  of paths (use `execFile`/`spawn` with argument arrays).
- `check-links.ts`: no network access.
- `package.json` diffs: `private` only removed on the three; `publishConfig`,
  `files`; `@changesets/cli` exact pin; no new `onlyBuiltDependencies`.
- `version.ts` and the Dockerfile diff (C7, C8); `.dockerignore` unchanged or
  stricter.
- gitleaks (if installed), semgrep on changed scripts, `npm audit` (the lockfile
  changes).
- `SECURITY.md` content (if Q-I accepted); docs free of real secrets.

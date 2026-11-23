# Architecture: #37 public docs, changelog and first semver release (PRD item 9c)

Spec: [`spec.md`](spec.md). Path: full. Branch: `feat/37-docs-changelog-release`.
No UI impact (no design phase).

## 1. Repo layout

- Layout: **monorepo** (pnpm workspace `apps/*`, `packages/*`), no submodules
  (`git submodule status` empty), no other repo touched, no linked issue.
- Affected packages (all of them, by the scope rename):

| Path                | Name after 9c                                       | npm                 | Checks                                        |
| ------------------- | --------------------------------------------------- | ------------------- | --------------------------------------------- |
| `packages/protocol` | `@mosherw/sync-system-protocol`                     | published           | typecheck, test, build, pack, smoke           |
| `packages/client`   | `@mosherw/sync-system-client`                       | published           | typecheck, test, build, pack, smoke           |
| `packages/react`    | `@mosherw/sync-system-react`                        | published           | typecheck, test, build, pack, smoke           |
| `apps/sync-server`  | `@mosherw/sync-system-server`                       | private, image only | typecheck, test (Redis suites), build, image  |
| `apps/reader`       | `@mosherw/sync-system-reader`                       | private, no version | typecheck, test, build, e2e (unchanged)       |
| root                | `sync-system` (private)                             | -                   | audit, lint (+ link check), compose config    |

## 2. Decisions

Two ADRs, status `Proposed`, decided at Gate 2:

- [ADR 0016 Versioning and npm release process](../../decisions/0016-versioning-and-npm-release.md).
  Recommended: Changesets fixed group of protocol, client, react **and server**
  (`privatePackages.version: true, tag: false`, reader ignored, built-in
  changelog generator); the version bump happens in a reviewed release PR
  (for 1.0.0: this PR); internal deps stay `workspace:*` (published as the
  exact version); one annotated git tag `vX.Y.Z`, created on the host;
  publishing is `npm publish <tarball> --access public --ignore-scripts
  --otp <code>` of the three `pack:check`-verified tarballs, by path, from a
  separate credential-only publish container (never `pnpm -r publish`, never
  `changeset publish`); npm login interactive in that publish container only,
  with 2FA OTP, no long-lived npm token, packages set to "require 2FA and
  disallow tokens" after the first publish (revised after security plan
  review H1, see section 9a).
- [ADR 0017 Server image build, tags and push](../../decisions/0017-server-image-publishing.md).
  Recommended: build on the host with `docker buildx` from a fresh clone of
  the tag; tags `X.Y.Z`, `X.Y`, `X`, `latest` in both registries; one
  multi-platform push `linux/amd64,linux/arm64`; a temporary `DOCKER_CONFIG`
  with `read -rs` + `--password-stdin` logins, and a `trap` set before the
  first login that runs `docker logout` for both registries and removes the
  config on every exit (Docker Desktop's credential helper keeps tokens in
  the OS keychain otherwise; security plan review M2).

### Gate 2 questions (not ADRs)

- **Q-E (deferred from Gate 1).** Recommended (ADR 0016 options E1, F1):
  `repository` = `git+https://github.com/MosheRW/sync-system.git` with a
  per-package `directory`; `homepage` = the package folder's README on
  GitHub (`.../tree/main/<path>#readme`); `bugs` =
  `https://github.com/MosheRW/sync-system/issues`; npm account 2FA on
  "authorization and writes", interactive login with OTP, no publish token.
- **Q-H. Env variables without a maximum.** 17 numeric server variables have
  no upper bound in code (only "safe integer"), e.g. `MAX_CONNECTIONS`,
  `MAX_GROUP_SIZE_CEILING`, `MAX_BUFFERED_BYTES`. AC45 wants a maximum
  column. Under the versioning policy, adding a maximum after 1.0.0 is a
  breaking config change. Recommended: **no new maxima in 9c**; the
  reference shows `none` and the operator guide's sizing notes (memory per
  connection) stay the guidance. Alternative: add maxima now (a code change
  per variable, more tests, more risk late in the release).
- **Q-I. `SECURITY.md`.** The repo turns public. Recommended: a short
  `SECURITY.md` (report privately through GitHub private vulnerability
  reporting, which the maintainer enables when the repo goes public).
  It is one file in the docs chunk; say no to drop it. (This is also security
  advisory L4.)
- **Q-L3. Going public: author email and `.claude.zip` (security advisory
  L3, user decision, no recommendation from the architect).** The repo turns
  public at the first release. A regex sweep of all 626 commits found no
  committed secret, but after the switch these become public: the
  maintainer's personal Gmail address as author on about 1,200 commits, the
  tracked `.claude.zip` archive and `.claude/` (agent prompts, board config,
  no secrets), and `docs/issues/**` (past security reviews with known open
  limits). Choices for the user:
  1. Accept the author email as it is; use the GitHub noreply email for
     commits from now on.
  2. Rewrite history before going public (destructive, force-push of `main`
     and every branch, all open PRs and SHAs change; a separate, human-run
     task outside this PR).
  And separately: keep or untrack `.claude.zip` (untracking it would be one
  `chore` commit in this PR; it stays in history either way).
  Independent of the choice, `RELEASING.md` "first release" makes the
  maintainer run `gitleaks git --redact` over the full history and check the
  repo settings (Actions secrets, environments, deploy keys) and issue/PR
  comments before flipping visibility.
- **Security advisories L1, L2, L5, L6 (adopt or not).** See section 9a for
  each one and the recommendation (all four: adopt; they cost one test, one
  doc line or a pinned digest each).

## 3. Approach

Five strands, in this order so that every commit passes the full checks:

1. **Rename** `@sync-system/*` to `@mosherw/sync-system-*` everywhere outside
   history (one regex `@sync-system/` → `@mosherw/sync-system-`; it also turns
   the custom condition `@sync-system/source` into
   `@mosherw/sync-system-source`). Excluded: `docs/issues/**` and the
   decisions/ADR bodies of 0001-0015 (history; their links still resolve),
   `pnpm-lock.yaml` (regenerated by `pnpm install`). Must include:
   `apps/sync-server/src/version.ts` `SERVER_PACKAGE_NAME` (the server refuses
   to start with a foreign `package.json`), `eslint.config.js`
   `no-restricted-imports`, every `vitest.config.ts` and `vite.config.ts`
   `conditions`, `tsconfig.base.json` `customConditions`, the `dev` script's
   `--conditions`, both Dockerfiles' `--filter`, `ci.yml` filters, the
   READMEs and `docs/conventions.md`. Compose's local image names
   (`sync-system/sync-server:dev`) are tags, not npm names: unchanged.
2. **License and package metadata.** Root `LICENSE` (GPL-3.0 full text,
   verbatim from gnu.org), committed copies in each published package (a test
   asserts byte equality with the root file), `"license": "GPL-3.0-only"` in
   every `package.json` (root, five packages). Published packages: drop
   `private`, add `repository`/`homepage`/`bugs` (Q-E), `publishConfig:
   { access: "public", exports: <same without the source condition> }`
   (pnpm applies `publishConfig.exports` at pack time), `files: ["dist",
   "CHANGELOG.md"]` (README, LICENSE and package.json are always packed).
   Protocol package gets its README. Server Dockerfile: OCI labels and
   `COPY LICENSE` (ADR 0017).
3. **Release tooling.** `@changesets/cli` (exact pin) and
   `.changeset/config.json` (ADR 0016), the first changeset
   (`.changeset/v1-first-release.md`, `major` for the four grouped packages,
   0.1.0 → 1.0.0) with the AC49 text. Root scripts:
   - `pack:check`: `node scripts/release/pack-check.ts` (Node 24 strips types,
     no new dependency). Runs `pnpm pack` for each published package into a
     temp dir, lists each tarball (`tar -tzf`), fails on any entry outside the
     allow-list `package/{package.json,README.md,CHANGELOG.md,LICENSE}` and
     `package/dist/**/*.{js,d.ts,js.map,d.ts.map}`, and checks the packed
     `package.json`: no `private`, no `workspace:` range, no
     `@mosherw/sync-system-source` condition, `license` `GPL-3.0-only`,
     `repository.directory` set, no lifecycle `scripts` (`preinstall`,
     `install`, `postinstall`, `prepare`, `prepublish*`, `prepack`,
     `postpack`), and version equal across the group. Before packing it
     asserts the publishable set (C4): the non-private workspace packages
     are exactly the three published names, and root,
     `@mosherw/sync-system-server` and `@mosherw/sync-system-reader` are
     `private: true`. With `--out <dir>` it keeps the checked tarballs in
     `<dir>` (created empty; fails if not empty) and writes
     `<dir>/INTEGRITY.txt`: one line per tarball, `<file> sha512-<base64>`
     (the same format as npm's `dist.integrity`), in publish order
     protocol, client, react. Without `--out` the temp dir is removed in
     `finally`. These kept tarballs are the only bytes ever published (C1).
   - `smoke`: `node scripts/release/smoke.ts`. Packs the three packages,
     creates a project in `os.tmpdir()` (outside the workspace), installs the
     tarballs with `pnpm install --ignore-scripts --offline` (C6; the store
     is the one the workspace's `--frozen-lockfile` install filled, so only
     lockfile-audited versions resolve; if pnpm cannot resolve offline in
     the CI container, `--prefer-offline` is the fallback and the engineer
     reports it as a deviation), mapping each
     `@mosherw/sync-system-*` name to its tarball through `pnpm.overrides`
     (the client's tarball depends on `@mosherw/sync-system-protocol@1.0.0`,
     which is not on the registry before publish), plus `react`,
     `react-dom`, `@types/react`, `@types/react-dom` at the **exact**
     versions the workspace lockfile resolved for `packages/react` (read
     with `pnpm list --filter @mosherw/sync-system-react --json --depth 0`
     through `execFile`, no YAML dependency), never the ranges. All child
     processes use `execFile`/`spawn` with argument arrays, no shell string.
     Then: ESM import of each package with
     `node` (checks the documented exports exist); `tsc --noEmit` with the
     workspace's TypeScript on a `.ts`/`.tsx` file importing every public
     type, once with `moduleResolution: NodeNext` and once with `Bundler`;
     `renderToString(<SyncProvider options={...}>...)` under Node with no
     browser globals (SSR safety, #15), asserting no throw and no socket.
     The temp dir is removed in `finally`.
   - `docs:links`: `node scripts/release/check-links.ts`, run inside
     `pnpm lint`. Scans every `*.md` except `node_modules`, `dist*`,
     `.claude/**`, `docs/issues/**` and generated `CHANGELOG.md` files.
     Checks every relative link target exists, every `#fragment` matches a
     heading slug of the target (GitHub slug rules), and every
     `https://github.com/MosheRW/sync-system/(blob|tree)/main/<path>` link
     maps to an existing local path. External links are not fetched.
   - `release:dry-run`: `node scripts/release/dry-run.ts`. Mirrors the real
     publish (C1): runs `pack-check.ts --out .release-out` (`.release-out/`
     is git-ignored and removed first), then for each tarball in
     `INTEGRITY.txt` order runs `npm publish <tgz> --dry-run --ignore-scripts
     --access public` (no login, no OTP) and prints each file's integrity
     line. It never uses `pnpm -r publish`. In the real release, the build
     container runs `pnpm pack:check --out /out` instead and nothing is
     published from it.
   The scripts live in `scripts/release/`, with `scripts/tsconfig.json`
   (root `typecheck` adds `tsc -p scripts`), ESLint's type-checked block
   extended to `scripts/**/*.ts`, and unit tests in
   `scripts/release/*.test.ts` run with Node's built-in test runner (root
   `test` adds `node --test scripts/release/`). No new test framework.
4. **Docs (Q-G).** Move, then complete:
   - `docs/operator-guide.md`: install with Docker Compose (the published
     image, both registries, pin `X.Y.Z`), config file, **env reference**
     (columns Variable, Default, Min, Max, Purpose), token secret, timers,
     Redis storage, several instances, health and readiness, upgrading
     (incl. 1.0.0 notes), deployment security, known limits (#41, #42 if
     open), license note, link to `docs/startup-errors.md` (not copied).
     Text moved from the root README keeps its wording, so the existing drift
     tests in `apps/sync-server/test/repo-hygiene.test.ts` only change the
     file they read.
   - `docs/protocol.md`: wire protocol v1 reference, self-contained: framing,
     handshake, every client and server message type with fields, every error
     code and close code, versioning (`PROTOCOL_VERSION`,
     `MIN_CLIENT_PROTOCOL_VERSION`), limits. Content comes from
     `packages/protocol/src` and the root README's "Protocol (v1) in brief",
     "Joining", "Roles and group lifecycle" and "Recovery and tokens".
   - `docs/integration-guide.md`: the reader as the worked example: register
     an app, run server and reader with compose, provider setup, create/join
     flows, following the position, leader controls, recovery, content
     fingerprint for metadata; links into the package READMEs and reader code.
   - `docs/versioning.md`: the AC47 policy (below, section 6).
   - `RELEASING.md` (root): the AC54 procedure (section 7).
   - Root `README.md` trimmed to an overview (what it is, quick start,
     packages table with npm names and image names, links to all docs and
     changelogs, license with the GPL note for the client and React packages).
   - `packages/client/README.md`, `packages/react/README.md`: new names,
     install lines, license note, absolute GitHub URLs for links that leave
     the package (relative ones break on npmjs.com).
5. **Version.** `pnpm changeset version` on the branch: four packages to
   1.0.0, four `CHANGELOG.md` files. This is the release candidate (AC55);
   tag, publish, push and GitHub release happen after merge, by the human.

### Alternatives rejected

- A link-checking dependency (`markdown-link-check`, `lychee`): network
  fetches, extra supply chain; a ~150-line script checks what AC43 asks.
- Copying `LICENSE` at `prepack`: the file is generated at pack time only, so
  a plain `pnpm pack` from another tool can miss it; committed copies plus a
  test are simpler.
- A separate workspace package for the release scripts: one more name in the
  rename and in the Changesets ignore list for three scripts.
- Keeping the env reference in the root README: Q-G moves it to the operator
  guide.
- Exporting a new "reference" structure for AC45 only: the test instead reads
  the parser's own bound tables (below), so the doc is checked against what
  the code enforces.

## 4. Files

### Create

| Path | What |
| --- | --- |
| `LICENSE` | GPL-3.0 full text |
| `packages/{protocol,client,react}/LICENSE` | copies of the root file |
| `packages/protocol/README.md` | install, exports overview, link to `docs/protocol.md`, license |
| `.changeset/config.json` | ADR 0016 configuration |
| `.changeset/README.md` | how to add a changeset (Changesets' default text, shortened) |
| `.changeset/v1-first-release.md` | first entry (AC48, AC49); consumed by the version chunk |
| `scripts/tsconfig.json` | typecheck for the release scripts (Node types, `allowImportingTsExtensions`, `noEmit`) |
| `scripts/release/pack-check.ts` | tarball contents and packed manifest check |
| `scripts/release/smoke.ts` | clean-project install, import, type-check, SSR render |
| `scripts/release/check-links.ts` | relative link and anchor check |
| `scripts/release/dry-run.ts` | `pack-check --out .release-out`, then `npm publish <tgz> --dry-run --ignore-scripts` per tarball |
| `scripts/release/lib.ts` | shared helpers (published package list, publishable-set check, temp dirs, `pnpm pack` runner, sha512 integrity, slugger) |
| `scripts/release/check-links.test.ts`, `pack-check.test.ts` | `node --test` unit tests of the pure parts (allow-list, manifest checks incl. lifecycle scripts, publishable-set check, integrity format) |
| `docs/operator-guide.md`, `docs/protocol.md`, `docs/integration-guide.md`, `docs/versioning.md` | public docs |
| `RELEASING.md` | release procedure |
| `SECURITY.md` | if Q-I is accepted |
| `apps/sync-server/test/env-reference.test.ts` | AC45 test |
| `packages/protocol/test/protocol-doc.test.ts` | every message type, error code and close code appears in `docs/protocol.md` |
| `apps/sync-server/test/release-files.test.ts` | LICENSE copies equal the root; every `package.json` has the license; published ones have the Q-E metadata and `publishConfig`; the non-private set is exactly the three published names and root/server/reader are `private: true` (C4); no tracked `.npmrc` contains `_authToken` (L6, if adopted); `@changesets/cli` is an exact version (C9); `RELEASING.md` contains the C1-C5 markers (below) |
| `{packages/*,apps/sync-server}/CHANGELOG.md` | generated by `changeset version` (chunk 14) |

### Modify

| Path | What |
| --- | --- |
| every `package.json` | rename; `license`; published: metadata, `publishConfig`, `files`; root: `@changesets/cli`, scripts `pack:check`, `smoke`, `docs:links`, `release:dry-run`, `lint` + link check, `typecheck` + scripts, `test` + `node --test` |
| `tsconfig.base.json` | `customConditions: ["@mosherw/sync-system-source"]` |
| `apps/*/vitest.config.ts`, `packages/*/vitest.config.ts`, `apps/reader/vite.config.ts` | condition rename |
| `apps/sync-server/src/version.ts` | `SERVER_PACKAGE_NAME` |
| ~200 source, test and README files | import specifiers (mechanical) |
| `pnpm-lock.yaml` | regenerated |
| `eslint.config.js` | restricted import names; `scripts/**/*.ts` in the type-checked block |
| `apps/sync-server/Dockerfile` | `--filter` names, OCI labels, `COPY LICENSE` |
| `apps/reader/Dockerfile` | `--filter` names |
| `.github/workflows/ci.yml` | filter names; after Build: `pnpm pack:check`, `pnpm smoke` |
| `apps/sync-server/test/repo-hygiene.test.ts` | CI step order includes pack and smoke; README drift tests read `docs/operator-guide.md` / `docs/protocol.md` where the sections moved |
| `apps/reader/test/readme.node.test.ts` | root README assertions follow the trimmed README |
| `apps/sync-server/src/config/env.ts` | `export` the existing `NUMERIC_VARS` table (no behaviour change) |
| `apps/sync-server/src/config/redis.ts` | export the existing bounds as named constants used by the parser (no behaviour change) |
| `apps/sync-server/src/config/known-vars.ts` | unknown-variable hint names `docs/operator-guide.md` instead of `README.md` (message text change; `docs/startup-errors.md` and its test follow) |
| `README.md`, `packages/client/README.md`, `packages/react/README.md`, `apps/reader/README.md` | trim / rename / links / license note |
| `docs/conventions.md` | names, release and license rows, ADRs 0016-0017, scope `release` |
| `docs/startup-errors.md` | hint text and links to the operator guide |
| `docs/PRD Group Reading Sync.md`, `docs/roadmap.md` | AC46 answers, 9c status |
| `.prettierignore` | `CHANGELOG.md` files (Changesets' output style) |
| `.gitignore` | `.release-out/` (dry-run tarballs) |
| root `package.json` `packageManager` | `pnpm@10.28.0+sha512.<hash>` so corepack verifies the download (L1, if adopted) |
| `.claude.zip` | untracked (`git rm --cached`, added to `.gitignore`) only if the user chooses so at Gate 2 (Q-L3) |

## 5. Data model, contracts, Docker

- Data model: none (no database, no storage key change).
- Wire protocol: unchanged, `PROTOCOL_VERSION = 1`, `MIN_CLIENT_PROTOCOL_VERSION = 1`.
- Public package contracts (new, documented, checked by `pack:check` and
  `smoke`):
  - Each published package: ESM only, one entry `"."` with `types` and
    `default`; the dist is ES2023.
  - `@mosherw/sync-system-client` depends on `@mosherw/sync-system-protocol`
    at the exact same version; `@mosherw/sync-system-react` on the client at
    the exact same version, peer `react ^18.3 || ^19`.
  - The public API is what each `src/index.ts` exports today (the
    `package.test.ts` export lists are the contract and stay unchanged
    apart from names).
- Image contract: `ghcr.io/mosherw/sync-system-server:<X.Y.Z|X.Y|X|latest>`
  and the same on `docker.io`; `linux/amd64`, `linux/arm64`; `/health`
  `version` = `X.Y.Z`; port 8080; config via `SYNC_CONFIG_PATH` mount;
  user `node`; labels per ADR 0017.
- User-visible message change: the unknown-variable hint points at
  `docs/operator-guide.md` (#36 message, listed in `docs/startup-errors.md`).
- **Docker impact:** `apps/sync-server/Dockerfile` (labels, `LICENSE`,
  filter), `apps/reader/Dockerfile` (filter). Compose: none.
  `docker compose ... config -q` must pass unchanged.

## 6. Versioning policy (content of `docs/versioning.md`, AC47)

- Semver per published package; the fixed group means all four move together.
- Breaking (major):
  - protocol: removing or renaming a message, field, error code or close
    code; a new required field; a tighter limit; raising
    `MIN_CLIENT_PROTOCOL_VERSION`;
  - client API / React API: removing or renaming an export, option, event,
    hook, state or error code; narrowing accepted input; a new required
    option; dropping a React major from the peer range;
  - server config and env: removing or renaming a variable or config key,
    a lower maximum or higher minimum, a changed default that changes
    behaviour visibly, a new required variable, a newly refused config.
- Minor: additions (optional fields, new messages a client may ignore, new
  variables with defaults, new hooks). Patch: fixes with no contract change.
- `PROTOCOL_VERSION` rises when the wire format gains a message or field a
  peer must understand; `MIN_CLIENT_PROTOCOL_VERSION` rises only in a server
  major, after one minor release that warns. Compatibility table: packages
  1.x work with server 1.x (protocol 1); the client refuses servers below its
  `MIN_SERVER_PROTOCOL_VERSION`.

## 7. Release procedure (content of `RELEASING.md`, AC54, AC55)

- Phase A, release PR (agent or human): add changesets during development;
  `pnpm changeset version`; review; merge.
Revised after the security plan review (H1, M1-M5; controls C1-C5). The
rule: **code that runs project dependencies never sees a credential, and
the place that holds a credential runs no project code.** Three places:
the host (git tag, image push), a build container (no credential ever), a
publish container (npm credential only, no clone, no install).

`RELEASING.md` gives every command literally. Both container images are
pinned by digest: `node:24@sha256:<digest>` (the publish container always;
the build container too if L1 is adopted), with a "bump deliberately"
note like the Dockerfile's.

- **Phase A, release PR (agent or human):** add changesets during
  development; `pnpm changeset version`; review; merge.
- **Phase B, human only, after merge:**
  0. **First release only, before the repo goes public (C5, L3):**
     - npm: `npm whoami` is `mosherw` and the account owns the scope
       (`npm access list packages @mosherw`), with 2FA on "authorization and
       writes" and recovery codes stored.
     - Docker Hub: create the public repository `mosherw/sync-system-server`
       under the maintainer's account.
     - GHCR: confirm the `mosherw` namespace is the maintainer's account.
     - Run `gitleaks git --redact` over the full history; check repo settings
       (Actions secrets, environments, deploy keys) and issue/PR comments;
       apply the Q-L3 decision.
     - Then make the repo public (Q18).
  1. **Tag on the host (C2).** With the maintainer's normal git credentials,
     no credential ever enters a container:
     `git fetch origin`; `M=$(gh pr view <release-PR> --json mergeCommit
     --jq .mergeCommit.oid)`; `git merge-base --is-ancestor "$M"
     origin/main`; `git show "$M":packages/protocol/package.json` (and the
     other three) shows `"version": "X.Y.Z"`; `git tag -a vX.Y.Z "$M" -m
     "vX.Y.Z"`; `git push origin vX.Y.Z` (the only git write). Note `$M`.
  2. **Build container (no credential, C1a).** `git bundle create
     release.bundle vX.Y.Z` on the host; `docker run --name
     sync-release-build -it --network <private net with the Redis sidecar>
     node:24@sha256:<digest> bash` (no `--rm`, no bind mount, no `-e` with a
     secret); `docker cp release.bundle` in; inside: `git clone --branch
     vX.Y.Z release.bundle /src`; assert `git rev-parse HEAD` equals `$M`
     and `git status --porcelain` is empty; `corepack enable`; `pnpm install
     --frozen-lockfile`; `pnpm audit --audit-level=high`, `lint`,
     `typecheck`, `test` (`SYNC_TEST_REDIS_URL`, `CI=true`), `build`,
     `smoke`, then `pnpm pack:check --out /out` (keeps the three checked
     tarballs and prints `/out/INTEGRITY.txt`). Exit. On the host: `docker
     cp sync-release-build:/out ./release-out`; `docker rm
     sync-release-build`. The maintainer keeps the printed integrity lines.
  3. **Publish container (npm credential only, C1b).** `docker run --rm -it
     --name sync-release-publish node:24@sha256:<digest> bash` (fresh, no
     clone, no `pnpm install`, no project code, no bind mount); `docker cp
     ./release-out/. sync-release-publish:/release` from a second host
     shell. Inside, in this order:
     - `trap 'npm logout >/dev/null 2>&1 || true' EXIT` (set **before**
       login, so logout runs on every exit path, including a failed
       publish or `exit`);
     - recompute each tarball's integrity with Node's built-in crypto (a
       one-line `node -e` given in `RELEASING.md`, not project code) and
       compare it with `INTEGRITY.txt` **and** with the lines printed in
       step 2; stop on any mismatch;
     - `npm login` (interactive, 2FA);
     - `npm publish /release/<protocol>.tgz --access public --ignore-scripts
       --otp <code>`, then client, then react (an expired OTP is retried
       with a new one; a tarball already published is skipped after
       `npm view <pkg>@X.Y.Z version` confirms it);
     - for each package: `npm view <pkg>@X.Y.Z dist.integrity` equals the
       integrity line; a mismatch is an incident (deprecate, report);
     - `npm logout`; `exit` (the trap runs again harmlessly; `--rm` removes
       the container and its `~/.npmrc`).
     pnpm already rewrote `workspace:*` ranges and applied
     `publishConfig.exports` at pack time, so publishing the tarball by
     path is correct and `changeset publish` is still never used.
  4. **Image on the host (ADR 0017, C3).** Fresh `git clone --branch
     vX.Y.Z --depth 1` into a temp dir; assert `git rev-parse HEAD` equals
     `$M` and a clean tree; dry-run `buildx --load` amd64 and `/health`
     version check. Then, in one shell script block from `RELEASING.md`:
     `export DOCKER_CONFIG="$(mktemp -d)"`; `trap 'docker logout ghcr.io;
     docker logout docker.io; rm -rf "$DOCKER_CONFIG"' EXIT` set **before**
     the first login; `read -rs T` then `printf '%s' "$T" | docker login
     ghcr.io -u mosherw --password-stdin`; `unset T`; same for
     `docker.io`; the token is never echoed or passed as an argument. One
     multi-platform `buildx --push` with eight tags and `--label` only for
     `.version` and `.revision`; `docker buildx imagetools inspect` both
     (record the manifest-list digest); exit runs the trap.
     Tokens: GHCR classic PAT with only `write:packages`, Docker Hub PAT
     limited to the one repository if available (else "Read & Write"),
     both with the shortest expiry; **revoke both after the release**
     (written as a checklist step).
  5. `gh release create vX.Y.Z --notes-file <changelog section>`; with L5
     the notes also list each tarball's `sha512-...` integrity and the
     image's manifest-list digest.
  6. First release only, after publish: set the GHCR package public; set
     each npm package to "require two-factor authentication and disallow
     tokens"; delete `./release-out` and `release.bundle`.
- **Dry run (QA, AC54):** step 2 without step 1 (the bundle is made from
  the PR head, and the HEAD assertion uses that SHA), then `pnpm
  release:dry-run` inside the build container (`npm publish <tgz> --dry-run`
  on the packed files), then step 4's `--load` build and `/health` check.
  No tag, no login, no push, no publish container.
- **Residual risk (stated in `RELEASING.md`):** the tarballs are built in
  the build container, so a compromised dev dependency could still alter
  `dist/` before packing; `pack:check` limits *which files* ship but not
  their content. The split removes the credential and OTP theft and the
  self-republish path; content integrity rests on the frozen, audited
  lockfile, as it does in CI.
- **Known limits:** no npm provenance, no image signature or SBOM; how to
  adopt an Actions workflow later (trusted publishing via OIDC,
  `--provenance`, `docker/build-push-action` with attestations) once
  Actions is available.

`release-files.test.ts` guards the procedure's load-bearing lines in
`RELEASING.md` (C1-C5): it contains `npm publish` with `--ignore-scripts`
and `--otp`, never `pnpm -r publish` or `changeset publish`; `node:24@sha256:`
appears and no bare `node:24 ` image; `trap` lines with `npm logout`,
`docker logout ghcr.io`, `docker logout docker.io` and `rm -rf
"$DOCKER_CONFIG"`; `read -rs` and `--password-stdin`; `dist.integrity`;
`git tag -a` appears only in the host step; the words "revoke" and the
first-release ownership checklist heading.

## 8. Risks and edge cases

- **Rename breadth.** ~224 files. Mitigation: one mechanical commit, then
  `grep -r "@sync-system/"` outside `docs/issues` and ADR 0001-0015 must be
  empty (a test in `release-files.test.ts` scans tracked files except those
  paths). The lockfile must be regenerated in the same commit.
- **Changesets with a private package in a fixed group.** If `changeset
  status` refuses the mix, fallback: keep the server outside the group and
  bump it by `changeset version` plus a `release-files` test that its version
  equals the protocol package's. Engineer reports this as a deviation.
- **`pnpm audit`** must stay clean with Changesets' dependency tree; if a
  high finding appears, pin an override or stop and report (no `--no-verify`).
- **`publishConfig.exports`** must be honoured by `pnpm pack`; `pack:check`
  asserts the condition is absent from the packed manifest.
- **Smoke test offline install.** `--offline` relies on the workspace
  install having filled the same pnpm store with the exact react/types
  versions and their dependencies; if a transitive dependency is missing,
  fall back to `--prefer-offline` (still exact top-level versions and
  `--ignore-scripts`) and report the deviation.
- **Tarball transfer.** `docker cp` between build container, host and
  publish container; the integrity comparison in the publish container
  catches any change on the way.
- **Source maps** reference `../src`, which is not shipped; harmless, noted.
- **Moving README text** can break the many phrase-based drift tests;
  move verbatim, retarget the file path, then edit.
- **GPL scope statement** must be exact (AC53); text reviewed by QA.
- **Known 1.0.0 limits to state:** #41 (join-attempt limits per instance) and
  #42 (just-started instance as successor). #44, #47 and #48 are not release
  blockers; #48's README wording fix becomes moot or moves with the text to the
  operator guide (mention it in #48 at Gate 3, don't fix here).
- **Human prerequisites (C5):** confirmed **before** the repo goes public,
  as the first-release checklist in `RELEASING.md` step 0: npm user
  `mosherw` owns the scope with 2FA; Docker Hub repository
  `mosherw/sync-system-server` exists under the maintainer; GHCR namespace
  is the maintainer's; then the repo is made public before publish
  (package metadata links).

## 9. Security-sensitive areas

Security-sensitive: yes

- Release credentials: npm session/2FA, GHCR and Docker Hub tokens
  (`RELEASING.md`, ADR 0016 E, ADR 0017 D): never stored, never on a command
  line, never in the repo or image; the npm session exists only in a
  publish container that runs no project code (C1); registry tokens behind
  a `trap` logout (C3); no git credential in any container (C2).
- New dev dependency `@changesets/cli` (supply chain, `pnpm audit`, C9).
- Published package contents (`pack:check` allow-list: no `src`, tests,
  `.env`, config or maps of secrets), `publishConfig` correctness, the
  publishable set (C4, C10).
- Dockerfile change (labels, `COPY LICENSE`; never the repo root, C8).
- Server package rename and `SERVER_PACKAGE_NAME` (C7).
- Agents never publish, push images, tag or create releases (AC55).
- Smoke test runs `pnpm install --ignore-scripts --offline` of local
  tarballs and exact lockfile versions in a temp dir (C6).
- Public repo: docs must not contain secrets (C11); `SECURITY.md` (Q-I/L4);
  history and author metadata go public (Q-L3).

## 9a. Security plan review round 1 (how each finding is addressed)

Source: [`security.md`](security.md), result FAIL (H1).

| Finding | Control | Where in this plan |
| --- | --- | --- |
| **H1 (high)** shared check/publish container | **C1**: build container never gets a credential; fresh publish container `node:24@sha256:<digest>` receives only the three checked `.tgz` files, compares sha512 integrity before publish, `npm publish <tgz> --access public --ignore-scripts --otp` in order protocol, client, react, compares `npm view ... dist.integrity` after, `npm logout` in a `trap ... EXIT` set before login. `release:dry-run` mirrors it with `npm publish <tgz> --dry-run`. | Section 7 steps 2-3; section 3 `pack:check --out`, `release:dry-run`; ADR 0016 option E1 and Decision rewritten; chunks 6, 7, 15 |
| M1 | **C2**: tag on the host from the verified merge SHA (`gh pr view`, `merge-base --is-ancestor`, version check); containers get a `git bundle` of the tag, assert HEAD == `$M` and a clean tree; no git credential in any container | Section 7 steps 1, 2, 4; ADR 0016 option D1 text; chunk 15 |
| M2 | **C3**: `trap` with `docker logout` both registries + `rm -rf "$DOCKER_CONFIG"` before the first login; `read -rs` + `printf ... \| --password-stdin`, `unset`; least-scope, short-expiry tokens revoked after the release | Section 7 step 4; ADR 0017 option D1 and Decision; chunks 1, 15 |
| M3 | **C4**: publishable set is exactly the three names; root/server/reader `private: true`; checked in `release-files.test.ts` and before packing in `pack:check`; publish is by tarball path, never `-r` | Section 3 `pack:check`; section 4 test row; chunks 4, 7 |
| M4 | **C5**: first-release ownership checklist (npm `mosherw` + 2FA, Docker Hub repo, GHCR) before the repo goes public | Section 7 step 0; section 8; chunk 15 |
| M5 | **C6**: smoke with `--ignore-scripts`, exact lockfile versions (`pnpm list --json`), `--offline` | Section 3 `smoke`; chunk 7 |
| - | **C7**: `SERVER_PACKAGE_NAME` and `apps/sync-server/package.json` `name` change in the **same** commit (chunk 2); existing "wrong package refused" version tests pass with the new name; the dry run's `/health` proves the image's `/app/package.json` carries the new name | Chunk 2; AC52 dry run |
| - | **C8**: runtime stage gets exactly `COPY LICENSE ./LICENSE` (one file, never a directory or `.`); no credential `ARG`/`ENV`; `--label` only `.version`/`.revision`; the existing Dockerfile hygiene test is extended to assert this exact line and no `ARG`/`ENV` with `TOKEN`/`SECRET`/`PASSWORD`/`KEY` in the name | Chunk 5 |
| - | **C9**: `@changesets/cli` exact version, lockfile in the same commit, `pnpm audit --audit-level=high` clean, not in `onlyBuiltDependencies`, no `@changesets/changelog-github`; engineer lists resolved version and direct deps in the PR | Chunk 6 |
| - | **C10**: `pack:check` allow-list and manifest checks (plus no lifecycle scripts) | Section 3; chunk 7 |
| - | **C11**: docs and examples carry only placeholders or the documented dev values; operator guide keeps "generate `TOKEN_SECRET`", "never use the dev key in production", and recommends pinning `X.Y.Z` or a digest (drift tests on those phrases) | Chunks 9, 12, 13 |

### Advisories (user decides at Gate 2; architect's recommendation)

| # | Advisory | Recommendation | Cost if adopted |
| --- | --- | --- | --- |
| L1 | Pin the build container `node:24@sha256:...` too (the publish one is pinned by C1); `packageManager: "pnpm@10.28.0+sha512.<hash>"` so corepack verifies pnpm | **Adopt.** The build container runs the whole release; a floating tag is the same gap the Dockerfile already closed | One `RELEASING.md` line; one `package.json` field (chunk 6) |
| L2 | `@changesets/cli` supply-chain hygiene | **Adopt** (already C9; adds the PR note listing resolved deps) | None beyond C9 |
| L4 | `SECURITY.md` with private vulnerability reporting (= Q-I) | **Adopt.** Public packages need a disclosure channel | One file (chunk 13); enable the GitHub setting when going public |
| L5 | Release notes list each tarball's `sha512` integrity and the image's manifest-list digest | **Adopt.** Free given C1 prints them; lets users pin and compare without provenance | One `RELEASING.md` step (chunk 15) |
| L6 | Test that no tracked `.npmrc` contains `_authToken` | **Adopt.** One assertion in `release-files.test.ts` | Chunk 4 |
| L3 | Author email and `.claude.zip` going public | **No recommendation; user decision** (Q-L3 in section 2) | Untracking `.claude.zip`: one commit; history rewrite: outside this PR |

## 10. Implementer model

Implementer model: opus
Reason: security-sensitive, new dependency, two open ADRs, ~230 files touched
and many drift tests to keep green while moving docs; the revised release
procedure (two containers, integrity checks, traps) must be written exactly.

## 11. Test plan (AC → check)

All checks run in local CI (AC56): `node:24` container from a git bundle, no
bind mounts, `redis:7.2.17-alpine` (pinned digest) on a private network,
order: install, audit, lint (incl. links), typecheck, test (Redis suites with
`CI=true`, `redis-required.test.ts` not skipped), compose config, build,
`pack:check`, `smoke`.

| AC | Check |
| --- | --- |
| AC43 | Docs exist with the listed sections (`repo-hygiene` + new heading checks); `pnpm docs:links` in `pnpm lint`; `check-links.test.ts` proves a broken file link and a broken anchor fail |
| AC45 | `env-reference.test.ts`: table names equal `KNOWN_SERVER_VARIABLES`; for each numeric variable default/min/max cells equal `NUMERIC_VARS` and the Redis bounds (`none` where the code has no max); string variables' defaults equal the parser defaults; plus behavioural spot checks (`min - 1` and `max + 1` give a `Config error` naming the variable, for variables without cross rules). Reader: existing `readme.node.test.ts` extended to compare its table defaults with the reader schema if cheap, otherwise names only (stated in the test) |
| AC46 | PRD open questions ticked with the answers; roadmap row; QA reads |
| AC47 | `docs/versioning.md` sections; QA reads |
| AC48 | After the version chunk: four `package.json` at `1.0.0`, reader at `0.1.0` and `private`; `PROTOCOL_VERSION` 1 / min 1 unchanged (protocol tests); changelog text states it (`release-files.test.ts`) |
| AC49 | `.changeset/config.json` fixed group (test); `CHANGELOG.md` 1.0.0 entry contains the listed notes (#10 join by group ID removed, token format 2, `MAX_BUFFERED_BYTES` minimum, Redis storage, stop every instance, unknown variables) (`release-files.test.ts`) |
| AC50 | `pnpm pack:check` (contents allow-list, manifest fields, no lifecycle scripts, publishable set C4); `pack-check.test.ts` proves a private-flag drop on server/reader/root and an extra non-private package both fail; no `@sync-system/` left (`release-files.test.ts`); full install/lint/typecheck/test/build green |
| AC51 | `pnpm smoke` (`--ignore-scripts`, exact lockfile versions, `--offline`; a unit test of the version lookup asserts exact versions, never ranges) |
| AC52 | Dry run: `docker buildx build --platform linux/amd64 --load`, run with a copied-in dev config (`docker create` + `docker cp`, no bind mount), `/health` `version` = `1.0.0`; labels via `docker inspect`; operator guide lists both registries (drift test) |
| AC53 | `release-files.test.ts`: root `LICENSE` is GPL-3.0, copies byte-equal, every `package.json` `GPL-3.0-only`; `pack:check` requires `LICENSE` in each tarball; docs GPL statement (drift test on the phrase) |
| AC54 | QA runs the `RELEASING.md` dry run end to end (build container from a bundle with the HEAD/clean-tree assertion, `pnpm release:dry-run` printing three integrity lines, `--load` build, `/health`); `release-files.test.ts` checks the C1-C5 markers in `RELEASING.md` (section 7) |
| AC55 | QA confirms no publish/push/tag/release happened (`npm view`, registry lookups 404, `git ls-remote --tags` has no `v1.0.0`) |
| AC56 | `ci.yml` has pack and smoke after Build (`repo-hygiene` step-order test); local CI run |

## 12. Implementation chunks

1. `docs(adr): accept 0016 versioning-and-npm-release and 0017 server-image-publishing`
   (ADRs to Accepted with the Gate 2 choices, including the H1/M1/M2
   revisions; `docs/conventions.md`: release, license, package names, scope
   `release`)
2. `refactor: rename workspace packages to the @mosherw scope`
   (all names, condition, imports, configs, Dockerfile filters, ci filters,
   READMEs, lockfile; C7: `SERVER_PACKAGE_NAME` and
   `apps/sync-server/package.json` `name` in this same commit, existing
   version tests green)
3. `chore: license the project under GPL-3.0-only`
   (`LICENSE`, copies, `license` fields, `release-files.test.ts` license part)
4. `build: prepare protocol, client and react for publishing`
   (`private` removed on the three only, Q-E metadata, `publishConfig`,
   `files`, protocol README, release-files metadata checks, C4
   publishable-set test, L6 `.npmrc` test if adopted)
5. `build(server): label the image and ship the license`
   (Dockerfile OCI labels, runtime-stage `COPY LICENSE ./LICENSE`, hygiene
   test extended for C8)
6. `build(release): add changesets with one fixed version group`
   (`@changesets/cli` exact pin + lockfile, C9; `.changeset/config.json`,
   `.changeset/README.md`, `.changeset/v1-first-release.md`;
   `packageManager` with sha512 if L1 is adopted)
7. `test(release): check packed tarballs and smoke-test a clean install`
   (`scripts/release/{lib,pack-check,smoke,dry-run}.ts`, tests,
   `scripts/tsconfig.json`, ESLint, root scripts `pack:check` (with
   `--out` and `INTEGRITY.txt`), `smoke` (C6), `release:dry-run` (C1
   mirror, `npm publish <tgz> --dry-run`), `.gitignore` `.release-out/`)
8. `ci: run the pack check and smoke test after build`
   (`ci.yml`, repo-hygiene step order)
9. `docs: move server operation docs into the operator guide`
   (`docs/operator-guide.md`, env table with Min/Max columns, drift tests
   retargeted, unknown-variable hint, `docs/startup-errors.md`)
10. `test(server): check the env reference against the parser bounds`
    (exports in `env.ts`/`redis.ts`, `env-reference.test.ts`)
11. `docs(protocol): add the wire protocol v1 reference`
    (`docs/protocol.md`, `protocol-doc.test.ts`)
12. `docs: add the integration guide and versioning policy`
    (`docs/integration-guide.md`, `docs/versioning.md`)
13. `docs: trim the root readme and update package readmes`
    (README overview, GPL note, package READMEs, `SECURITY.md` if Q-I)
14. `build(docs): fail lint on broken links and anchors`
    (`check-links.ts`, its test, `lint` script; fix any broken link found)
15. `docs(release): add the release procedure`
    (`RELEASING.md` per section 7: host tagging, build container, publish
    container, image push with trap/logout, token revocation, first-release
    ownership and go-public checklist, L5 release-note hashes if adopted,
    residual risk; `release-files.test.ts` C1-C5 marker checks)
15a. Only if the user chooses it at Gate 2 (Q-L3):
    `chore: stop tracking the claude archive` (`git rm --cached .claude.zip`,
    `.gitignore`)
16. `chore(release): version packages for 1.0.0`
    (`pnpm changeset version`: four versions, four `CHANGELOG.md`,
    changeset consumed; `release-files` changelog checks)
17. `docs: close the prd open questions and record the release candidate`
    (PRD AC46 answers, `docs/roadmap.md`, `.prettierignore` if needed)

Docs impact: `README.md`, `RELEASING.md`, `SECURITY.md` (Q-I),
`docs/operator-guide.md`, `docs/protocol.md`, `docs/integration-guide.md`,
`docs/versioning.md`, `docs/startup-errors.md`, `docs/conventions.md`,
`docs/roadmap.md`, the PRD, ADRs 0016-0017, package READMEs, changelogs.

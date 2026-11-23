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

Two ADRs, **Accepted at Gate 2 (2026-11-23)** with the user's choices
(section 9b). `Decisions: none open`.

- [ADR 0016 Versioning and npm release process](../../decisions/0016-versioning-and-npm-release.md).
  Accepted: **A1, B1, C1, D1, E2, F1** (the user chose E2 over the
  recommended E1). Changesets fixed group of protocol, client, react **and
  server** (`privatePackages.version: true, tag: false`, reader ignored,
  built-in changelog generator); the version bump happens in a reviewed
  release PR (for 1.0.0: this PR); internal deps stay `workspace:*`
  (published as the exact version); one annotated git tag `vX.Y.Z`, created
  on the host; publishing is `npm publish <tarball> --access public
  --ignore-scripts` of the three `pack:check`-verified tarballs, by literal
  path, from a separate fresh publish container (never `pnpm -r publish`,
  never `changeset publish`). npm auth (E2): a **granular access token**
  (read and write, `@mosherw` packages only, 7-day expiry, IP allowlist,
  "bypass 2FA"), created just before the publish, read on the host with
  `read -rs`, piped over `docker exec -i` stdin into `/root/.npmrc` (mode
  600) of the publish container only, never on a command line, in an env
  var of a container, in a host file or in shell history; removed with the
  container by a host `trap`, and revoked right after the release. The
  two-container split from H1 (C1) is unchanged. E1 (interactive
  `npm login` + OTP) was considered and not chosen (section 7, ADR 0016).
- [ADR 0017 Server image build, tags and push](../../decisions/0017-server-image-publishing.md).
  Accepted: **A1, B1, C1, D1** as recommended. Build on the host with `docker buildx` from a fresh clone of
  the tag; tags `X.Y.Z`, `X.Y`, `X`, `latest` in both registries; one
  multi-platform push `linux/amd64,linux/arm64`; a temporary `DOCKER_CONFIG`
  with `read -rs` + `--password-stdin` logins, and a `trap` set before the
  first login that runs `docker logout` for both registries and removes the
  config on every exit (Docker Desktop's credential helper keeps tokens in
  the OS keychain otherwise; security plan review M2).

### Gate 2 questions (not ADRs), all decided 2026-11-23 (section 9b)

- **Q-E (deferred from Gate 1). Decided: URLs as proposed; npm auth per
  ADR 0016 E2.**
  `repository` = `git+https://github.com/MosheRW/sync-system.git` with a
  per-package `directory`; `homepage` = the package folder's README on
  GitHub (`.../tree/main/<path>#readme`); `bugs` =
  `https://github.com/MosheRW/sync-system/issues`; npm account 2FA on
  "authorization and writes"; publish with a short-lived granular token
  (E2), each package's publishing access set to "Require two-factor
  authentication or a granular access token with bypass 2FA enabled".
- **Q-H. Env variables without a maximum. Decided: no new maxima; the
  reference shows `none`.** 17 numeric server variables have
  no upper bound in code (only "safe integer"), e.g. `MAX_CONNECTIONS`,
  `MAX_GROUP_SIZE_CEILING`, `MAX_BUFFERED_BYTES`. AC45 wants a maximum
  column. Under the versioning policy, adding a maximum after 1.0.0 is a
  breaking config change. Recommended: **no new maxima in 9c**; the
  reference shows `none` and the operator guide's sizing notes (memory per
  connection) stay the guidance. Alternative: add maxima now (a code change
  per variable, more tests, more risk late in the release).
- **Q-I. `SECURITY.md`. Decided: add it.** The repo turns public. Recommended: a short
  `SECURITY.md` (report privately through GitHub private vulnerability
  reporting, which the maintainer enables when the repo goes public).
  It is one file in the docs chunk; say no to drop it. (This is also security
  advisory L4.)
- **Q-L3. Going public: author email and `.claude.zip` (security advisory
  L3). Decided: choice 1 (keep the personal email in existing history, no
  history rewrite; new commits use the GitHub noreply address, already set
  in the repo's local git config) and untrack `.claude.zip` (chunk 15a; it
  stays in history).** The repo turns
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
- **Security advisories. Decided: L1, L2, L4, L5, L6, L8, L9, L10, L11
  adopted; L7 not adopted.** See sections 9a and 9b.

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
     `repository.directory` set, no lifecycle `scripts` (L10: any script
     name matching `/^(pre|post)?(install|prepare|publish|pack|version)$/`
     or equal to `prepublishOnly` or `dependencies` fails; simplest is to
     require the packed `scripts` to be absent or empty, since the
     published packages need none), and version equal across the group. Before packing it
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
     protocol, client, react order (literal expected file names, not names
     read from `INTEGRITY.txt`) runs `npm publish <tgz> --dry-run
     --ignore-scripts --access public` (no token, no `.npmrc`) and prints
     each file's integrity line. It never uses `pnpm -r publish`. In the
     real release, the build container runs `pnpm pack:check --out /out`
     instead and nothing is published from it.
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
| `SECURITY.md` | private vulnerability reporting through GitHub, supported versions `1.x`, "do not open public issues for vulnerabilities" (Q-I, L4) |
| `apps/sync-server/test/env-reference.test.ts` | AC45 test |
| `packages/protocol/test/protocol-doc.test.ts` | every message type, error code and close code appears in `docs/protocol.md` |
| `apps/sync-server/test/release-files.test.ts` | LICENSE copies equal the root; every `package.json` has the license; published ones have the Q-E metadata and `publishConfig`; the non-private set is exactly the three published names and root/server/reader are `private: true` (C4); no tracked `.npmrc` contains `_authToken` (L6); `@changesets/cli` is an exact version (C9); `RELEASING.md` contains the C1-C5 markers (below) |
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
| `.gitignore` | `.release-out/` (dry-run tarballs), `.claude.zip` (chunk 15a) |
| `.dockerignore` | `.release-out` (L11) |
| root `package.json` `packageManager` | `pnpm@10.28.0+sha512.<hash>` so corepack verifies the download (L1) |
| `.claude.zip` | untracked (`git rm --cached`, added to `.gitignore`; Q-L3, chunk 15a; stays in history) |

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

Revised after the security plan review (H1, M1-M5; controls C1-C5) and
after Gate 2 (ADR 0016 E2, advisories L1, L5, L8-L11). The rule: **code
that runs project dependencies never sees a credential, and the place that
holds a credential runs no project code.** Three places: the host (git
tag, image push, the npm token's only hop), a build container (no
credential ever), a publish container (npm token only, no clone, no
install, no project code).

`RELEASING.md` gives every command literally. Both container images are
pinned by digest, `node:24@sha256:<digest>` (L1), with a "bump
deliberately" note like the Dockerfile's. Every host block that touches a
credential is shipped as **one subshell** `( set -euo pipefail; ... )`
pasted at once, so its `trap ... EXIT` fires when the block ends, not when
the terminal closes (L9). Git Bash on Windows: the blocks start with
`export MSYS_NO_PATHCONV=1` (otherwise container paths such as
`/release/...` are rewritten into Windows paths) and host paths given to
`docker` are converted with `cygpath -m` when `cygpath` exists.

- **Phase A, release PR (agent or human):** add changesets during
  development; `pnpm changeset version`; review; merge.
- **Phase B, human only, after merge:**
  0. **First release only, before the repo goes public (C5, L3):**
     - npm: `npm whoami` is `mosherw` and the account owns the scope
       (`npm access list packages @mosherw`); account 2FA enabled for
       "Authorization and writes" (a security key if available, else
       TOTP) and recovery codes stored offline; the account's Access
       Tokens page lists **no** token (no classic or older granular
       tokens).
     - Docker Hub: create the public repository `mosherw/sync-system-server`
       under the maintainer's account.
     - GHCR: confirm the `mosherw` namespace is the maintainer's account.
     - Run `gitleaks git --redact` over the full history; check repo settings
       (Actions secrets, environments, deploy keys) and issue/PR comments.
       Q-L3 decision: history is **not** rewritten (the personal author
       email stays in old commits); check `git config user.email` is the
       GitHub noreply address; `.claude.zip` is already untracked (chunk
       15a).
     - Enable GitHub private vulnerability reporting (`SECURITY.md`, L4).
     - Then make the repo public (Q18).
  1. **Tag on the host (C2).** With the maintainer's normal git credentials,
     no credential ever enters a container:
     `git fetch origin`; `M=$(gh pr view <release-PR> --json mergeCommit
     --jq .mergeCommit.oid)`; `git merge-base --is-ancestor "$M"
     origin/main`; `git show "$M":packages/protocol/package.json` (and the
     other three) shows `"version": "X.Y.Z"`; `git tag -a vX.Y.Z "$M" -m
     "vX.Y.Z"`; `git push origin vX.Y.Z` (the only git write). Note `$M`.
  2. **Build container (no credential, C1a).** On the host, outside the
     repo (L11): `REL="$(mktemp -d)"`; `git bundle create
     "$REL/release.bundle" vX.Y.Z`; `docker run --name sync-release-build
     -it --network <private net with the Redis sidecar>
     node:24@sha256:<digest> bash` (no `--rm`, no bind mount, no `-e` with
     a secret); `docker cp "$REL/release.bundle"` in; inside: `git clone
     --branch vX.Y.Z release.bundle /src`; assert `git rev-parse HEAD`
     equals `$M` and `git status --porcelain` is empty; `corepack enable`
     (corepack verifies pnpm against the `packageManager` sha512, L1);
     `pnpm install --frozen-lockfile`; `pnpm audit --audit-level=high`,
     `lint`, `typecheck`, `test` (`SYNC_TEST_REDIS_URL`, `CI=true`),
     `build`, `smoke`, then `pnpm pack:check --out /out` (keeps the three
     checked tarballs and prints `/out/INTEGRITY.txt`). Exit. On the host:
     `docker cp sync-release-build:/out "$REL/out"`; `docker rm
     sync-release-build`. The maintainer keeps the three printed integrity
     lines (e.g. pasted into the release notes draft).
  3. **Create the npm token (E2), right before step 4, never earlier.**
     npmjs.com, Access Tokens, Generate New Token, **Granular Access
     Token**:
     - name `sync-system-release-vX.Y.Z`; expiration **7 days** (a closer
       custom date is fine);
     - Packages and scopes: **Read and write**, "only select packages and
       scopes": the three packages from the second release on; for the
       first release (the packages don't exist yet) the `@mosherw` scope.
       If the form offers no way to limit a not-yet-published name, the
       first release uses "All packages" (the account owns no other
       packages, step 0) and `RELEASING.md` says so;
     - Organizations: no access;
     - Allowed IP ranges: the host's current public IPv4 as `/32` (plus
       its IPv6 range if the host reaches npm over IPv6); the publish
       container leaves through the host's NAT, so the same address;
     - **Bypass two-factor authentication: on** (required: the token
       publishes without an OTP; this is the trade-off the user accepted).
     Creating the token itself needs the account 2FA. The token is copied
     from the page straight into step 4's prompt: never saved to a file,
     password manager, note or chat; the clipboard (and Windows clipboard
     history) is cleared right after the paste.
  4. **Publish container (npm token only, C1b as amended for E2).** One
     host subshell block from `RELEASING.md`, in this order:
     - `C=sync-release-publish`; `trap` set **first**, before anything
       touches the token: it runs `docker exec "$C" npm logout` (asks the
       registry to end the token's session, best effort) and `docker rm -f
       "$C"` (removes the container and its `/root/.npmrc`), and `unset
       NPM_TOKEN`; it fires on every exit path (failed check, failed
       publish, Ctrl-C, end of block);
     - `docker run -d --rm --name "$C" node:24@sha256:<digest> sleep
       infinity` (fresh; no clone, no `pnpm install`, no project code, no
       bind mount, no `-e`, no `--env-file`);
     - `docker cp "$REL/out/." "$C":/release`;
     - checks inside, all through `docker exec`, **before** the token
       exists anywhere (L8): `/release` holds exactly `INTEGRITY.txt` and
       the three literal file names `mosherw-sync-system-protocol-X.Y.Z.tgz`,
       `mosherw-sync-system-client-X.Y.Z.tgz`,
       `mosherw-sync-system-react-X.Y.Z.tgz`, all regular files (`find
       /release -mindepth 1 ! -type f` prints nothing, so no symlink or
       directory); each tarball's `package/package.json` (`tar -xOzf`) has
       the expected `name` and `version` `X.Y.Z`; each tarball's sha512
       integrity, recomputed with a one-line `node -e` using Node's
       built-in `crypto` (no project code), equals its `INTEGRITY.txt`
       line, and the maintainer compares the printed values with the lines
       kept from step 2; any mismatch exits (the trap cleans up). File
       names are always written literally in `RELEASING.md`, never read
       from `INTEGRITY.txt` or from the directory;
     - **token in (the only hop):** `read -rs -p 'npm token: ' NPM_TOKEN`
       on the host (no echo, not in history); `printf
       '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" | docker exec
       -i "$C" sh -c 'umask 077 && cat > /root/.npmrc'` (`printf` is a
       shell builtin, so the token is in no process's argument list; it
       travels over the `docker exec` stdin stream and lands in a mode-600
       file inside the publish container only); `unset NPM_TOKEN`
       immediately;
     - `docker exec "$C" npm whoami` must print `mosherw`, else exit;
     - three literal lines, in order protocol, client, react: `docker exec
       "$C" npm publish /release/mosherw-sync-system-<pkg>-X.Y.Z.tgz
       --access public --ignore-scripts` (no `--otp`); a re-run skips a
       package for which `npm view @mosherw/sync-system-<pkg>@X.Y.Z
       version` already answers;
     - `docker exec "$C" npm logout`; `docker exec "$C" rm -f
       /root/.npmrc`;
     - for each package: `npm view @mosherw/sync-system-<pkg>@X.Y.Z
       dist.integrity` (anonymous, retried for registry lag) equals its
       integrity line; a mismatch is an incident (deprecate, revoke,
       report);
     - the block ends; the trap removes the container.
     pnpm already rewrote `workspace:*` ranges and applied
     `publishConfig.exports` at pack time, so publishing the tarball by
     path is correct and `changeset publish` is still never used.
  5. **Revoke the npm token now** (before the image push, so its life is
     minutes): Access Tokens page, delete `sync-system-release-vX.Y.Z`;
     the page lists no token afterwards. Written as a checklist step that
     is not skipped even when `npm logout` succeeded.
  6. **Image on the host (ADR 0017, C3).** Fresh `git clone --branch
     vX.Y.Z --depth 1` from GitHub into `mktemp -d` (L11); assert `git
     rev-parse HEAD` equals `$M` and a clean tree; dry-run `buildx --load`
     amd64 and `/health` version check. Then one host subshell block from
     `RELEASING.md` (L9): `export DOCKER_CONFIG="$(mktemp -d)"`; `trap
     'docker logout ghcr.io; docker logout docker.io; rm -rf
     "$DOCKER_CONFIG"' EXIT` set **before** the first login; `read -rs T`
     then `printf '%s' "$T" | docker login ghcr.io -u mosherw
     --password-stdin`; `unset T`; same for `docker.io`; the token is never
     echoed or passed as an argument. One multi-platform `buildx --push`
     with eight tags and `--label` only for `.version` and `.revision`;
     `docker buildx imagetools inspect` both (record the manifest-list
     digest); the block ends and the trap runs. After the block (L9):
     `docker-credential-wincred list` (or `-desktop`/`-osxkeychain`, the
     platform's helper) and `~/.docker/config.json` show no `ghcr.io` or
     `index.docker.io` entry; if one does, `docker logout <registry>`.
     Tokens: GHCR classic PAT with only `write:packages`, Docker Hub PAT
     limited to the one repository if available (else "Read & Write"),
     both with the shortest expiry; **revoke both after the release**
     (checklist step).
  7. `gh release create vX.Y.Z --notes-file <changelog section>`; the notes
     also list each tarball's `sha512-...` integrity and the image's
     manifest-list digest (L5).
  8. First release only, after publish: set the GHCR package public; on
     npmjs.com set each of the three packages' **Publishing access** to
     "**Require two-factor authentication or a granular access token with
     bypass 2FA enabled**" (the setting E2 needs: interactive publishes
     need an OTP, and only a granular token with bypass 2FA publishes
     without one; "Require two-factor authentication and disallow tokens"
     would block E2 and is **not** used; "Don't require two-factor
     authentication" is never used). Every release: delete `"$REL"` and
     the image clone's temp dir.
- **Dry run (QA, AC54):** step 2 without step 1 (the bundle is made from
  the PR head into `mktemp -d`, and the HEAD assertion uses that SHA), then
  `pnpm release:dry-run` inside the build container (`npm publish <tgz>
  --dry-run` on the packed files, no token), then step 6's `--load` build
  and `/health` check. No tag, no token, no login, no push, no publish
  container.
- **Residual risk (stated in `RELEASING.md`):**
  - The tarballs are built in the build container, so a compromised dev
    dependency could still alter `dist/` before packing and print matching
    hashes; `pack:check` limits *which files* ship, not their content. The
    split removes credential theft and the self-republish path; content
    integrity rests on the frozen, audited lockfile, as in CI (L7, an
    independent second build to compare hashes, was not adopted at Gate 2).
  - E2: the token is a bearer credential that publishes without an OTP.
    Its exposure is the npmjs.com page, the clipboard, one host shell
    variable and the publish container; it is bounded by the package/scope
    limit, the IP allowlist, the 7-day expiry and revocation within
    minutes (step 5). A host compromised during those minutes could use
    it; with E1 the same host could also capture an OTP, so the difference
    is the window, which step 5 keeps short.
- **Known limits:** no npm provenance, no image signature or SBOM; how to
  adopt an Actions workflow later (trusted publishing via OIDC,
  `--provenance`, `docker/build-push-action` with attestations) once
  Actions is available. Trusted publishing would replace the E2 token.

`release-files.test.ts` guards the procedure's load-bearing lines in
`RELEASING.md` (C1-C5 as amended for E2, L8, L9, L11):
- `npm publish` lines carry `--ignore-scripts` and `--access public` and
  never `--otp`; never `pnpm -r publish`, `changeset publish` or `npm
  login`;
- the three literal tarball names
  `mosherw-sync-system-{protocol,client,react}-` appear; `find /release`
  and `tar -xOzf` appear (L8);
- `node:24@sha256:` appears and no bare `node:24 ` image;
- npm token: `read -rs` with `NPM_TOKEN`; `docker exec -i` with `umask
  077`; a `trap` with `docker rm -f` and `npm logout`; `unset NPM_TOKEN`;
  **no** `-e NPM_TOKEN`, `--env-file`, `NPM_TOKEN=` assignment or
  `_authToken=` followed by anything other than `%s`;
- the npm settings phrases "Bypass two-factor authentication" and
  "Require two-factor authentication or a granular access token";
- registries: `trap` with `docker logout ghcr.io`, `docker logout
  docker.io` and `rm -rf "$DOCKER_CONFIG"`; `--password-stdin`;
  `docker-credential-` (L9);
- `mktemp -d` for the bundle and outputs (L11); `dist.integrity`;
- `git tag -a` appears only in the host tagging step; the word "revoke"
  for the npm token and both registry tokens; the first-release
  ownership checklist heading.

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
  `mosherw` owns the scope with 2FA and no existing tokens; Docker Hub repository
  `mosherw/sync-system-server` exists under the maintainer; GHCR namespace
  is the maintainer's; then the repo is made public before publish
  (package metadata links).
- **npm token details may differ from the plan (E2).** The granular-token
  form may not allow limiting a not-yet-published name or an IP range in
  the way section 7 step 3 assumes. `RELEASING.md` states the fallback
  (first release with "All packages" on an account that owns no other
  packages; IP allowlist skipped only if the form lacks it) and the
  maintainer notes which was used; the 7-day expiry and revocation within
  minutes are never dropped.
- **Git Bash path conversion.** Without `MSYS_NO_PATHCONV=1`,
  `docker exec ... /release/...` arguments are rewritten into Windows
  paths and the publish fails (safely). QA's dry run on the Windows host
  exercises the same blocks without the token.

## 9. Security-sensitive areas

Security-sensitive: yes

- Release credentials: the npm granular token (ADR 0016 E2), GHCR and
  Docker Hub tokens (ADR 0017 D1), all in `RELEASING.md`: never stored,
  never on a command line, in an env var of a container, in a host file or
  in shell history, never in the repo or image. The npm token's path is
  npmjs.com page, clipboard, `read -rs` host variable, `docker exec -i`
  stdin, mode-600 `/root/.npmrc` in a publish container that runs no
  project code (C1 as amended); a host `trap` removes the container; the
  token is revoked right after the publish. Registry tokens behind a
  `trap` logout and a credential-helper check (C3, L9); no git credential
  in any container (C2).
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
| **H1 (high)** shared check/publish container | **C1 (as amended for E2 at Gate 2)**: build container never gets a credential; fresh publish container `node:24@sha256:<digest>` (run detached, driven by `docker exec` from one host subshell) receives only the three checked `.tgz` files and `INTEGRITY.txt`; before the token exists it checks the literal file names, regular files only, the packed `name`/`version`, and sha512 integrity against `INTEGRITY.txt` and the step-2 lines; then the granular token goes in over `docker exec -i` stdin to a mode-600 `/root/.npmrc` (never argv, env, host file or history); `npm whoami`; `npm publish <literal tgz path> --access public --ignore-scripts` (no `--otp`) in order protocol, client, react; `npm view ... dist.integrity` compared after; a host `trap ... EXIT` set before the token is read runs `npm logout` and `docker rm -f`; the token is revoked right after. `release:dry-run` mirrors it with `npm publish <tgz> --dry-run` and no token. | Section 7 steps 2-5; section 3 `pack:check --out`, `release:dry-run`; ADR 0016 option E2 and Decision; chunks 6, 7, 15 |
| M1 | **C2**: tag on the host from the verified merge SHA (`gh pr view`, `merge-base --is-ancestor`, version check); containers get a `git bundle` of the tag, assert HEAD == `$M` and a clean tree; no git credential in any container | Section 7 steps 1, 2, 6; ADR 0016 option D1 text; chunk 15 |
| M2 | **C3**: `trap` with `docker logout` both registries + `rm -rf "$DOCKER_CONFIG"` before the first login; `read -rs` + `printf ... \| --password-stdin`, `unset`; least-scope, short-expiry tokens revoked after the release | Section 7 step 6; ADR 0017 option D1 and Decision; chunk 15 |
| M3 | **C4**: publishable set is exactly the three names; root/server/reader `private: true`; checked in `release-files.test.ts` and before packing in `pack:check`; publish is by tarball path, never `-r` | Section 3 `pack:check`; section 4 test row; chunks 4, 7 |
| M4 | **C5**: first-release ownership checklist (npm `mosherw` + 2FA + no existing tokens, Docker Hub repo, GHCR) before the repo goes public | Section 7 step 0; section 8; chunk 15 |
| M5 | **C6**: smoke with `--ignore-scripts`, exact lockfile versions (`pnpm list --json`), `--offline` | Section 3 `smoke`; chunk 7 |
| - | **C7**: `SERVER_PACKAGE_NAME` and `apps/sync-server/package.json` `name` change in the **same** commit (chunk 2); existing "wrong package refused" version tests pass with the new name; the dry run's `/health` proves the image's `/app/package.json` carries the new name | Chunk 2; AC52 dry run |
| - | **C8**: runtime stage gets exactly `COPY LICENSE ./LICENSE` (one file, never a directory or `.`); no credential `ARG`/`ENV`; `--label` only `.version`/`.revision`; the existing Dockerfile hygiene test is extended to assert this exact line and no `ARG`/`ENV` with `TOKEN`/`SECRET`/`PASSWORD`/`KEY` in the name | Chunk 5 |
| - | **C9**: `@changesets/cli` exact version, lockfile in the same commit, `pnpm audit --audit-level=high` clean, not in `onlyBuiltDependencies`, no `@changesets/changelog-github`; engineer lists resolved version and direct deps in the PR | Chunk 6 |
| - | **C10**: `pack:check` allow-list and manifest checks (plus no lifecycle scripts, complete deny-list per L10) | Section 3; chunk 7 |
| - | **C11**: docs and examples carry only placeholders or the documented dev values; operator guide keeps "generate `TOKEN_SECRET`", "never use the dev key in production", and recommends pinning `X.Y.Z` or a digest (drift tests on those phrases) | Chunks 9, 12, 13 |

### Advisories (decided at Gate 2, 2026-11-23)

| # | Advisory | Gate 2 | Where |
| --- | --- | --- | --- |
| L1 | Pin the build container `node:24@sha256:...` too; `packageManager: "pnpm@10.28.0+sha512.<hash>"` so corepack verifies pnpm | **Adopted** | Section 7 step 2; chunk 6 (`packageManager`), chunk 15 |
| L2 | `@changesets/cli` supply-chain hygiene (C9 plus a PR note listing resolved version and direct deps) | **Adopted** | Chunk 6; PR body |
| L3 | Author email and `.claude.zip` going public | **Decided (Q-L3):** keep history as is, noreply email from now on, untrack `.claude.zip` | Chunk 15a; section 7 step 0 |
| L4 | `SECURITY.md` with private vulnerability reporting (= Q-I) | **Adopted** | Chunk 13; section 7 step 0 enables the setting |
| L5 | Release notes list each tarball's `sha512` integrity and the image's manifest-list digest | **Adopted** | Section 7 step 7; chunk 15 |
| L6 | Test that no tracked `.npmrc` contains `_authToken` | **Adopted** | Chunk 4 |
| L7 | Compare integrity with an independent second build | **Not adopted** (residual risk stays stated in `RELEASING.md`) | Section 7 "Residual risk" |
| L8 | Publish container trusts names/manifests from the build container | **Adopted**: literal names, regular files only (`find`), packed `name`/`version` check (`tar -xOzf`), all before the token is read | Section 7 step 4; chunk 15 markers |
| L9 | `trap` only fires when the shell exits; Git Bash `DOCKER_CONFIG` | **Adopted**: every credential block is one subshell; credential-helper and `config.json` check after the image push; `MSYS_NO_PATHCONV=1` | Section 7 intro, steps 4, 6; chunk 15 markers |
| L10 | Incomplete lifecycle-script deny-list | **Adopted**: packed `scripts` must be absent or empty, else the regex deny-list fails | Section 3 `pack:check`; chunk 7 tests |
| L11 | Bundle and outputs inside the working copy; `.release-out` not docker-ignored | **Adopted**: `mktemp -d` outside the repo; `.release-out` in `.dockerignore` | Section 7 steps 2, 6; chunk 7 |

## 9b. Gate 2 decisions (2026-11-23)

- ADR 0016: **A1, B1, C1, D1, F1** as recommended; **E2 instead of E1**
  (npm granular access token instead of interactive `npm login` + OTP;
  user's reason: less typing, no OTP per package). The two-container split
  (H1/C1) is kept unchanged; the token only ever enters the publish
  container. E1 is recorded in the ADR as considered and not chosen.
- ADR 0017: **A1, B1, C1, D1** as recommended.
- Both ADRs set to `Accepted` in this plan revision.
- Q-E: URLs as proposed. Q-H: no new maxima, the reference shows `none`.
  Q-I/L4: add `SECURITY.md`.
- Q-L3: keep the personal email in existing history, no rewrite; new
  commits use the GitHub noreply address (already in the repo's local git
  config). Untrack `.claude.zip` (chunk 15a).
- Advisories adopted: L1, L2, L4, L5, L6, L8, L9, L10, L11. Not adopted: L7.
- **Security re-check required:** E2 changes the npm credential method that
  security round 2 reviewed (it endorsed E1 and "disallow tokens"). Control
  C1 is amended here (section 9a, H1 row); `security.md` C1 still has the
  E1 wording (`--otp`, `npm login`) until the security agent re-checks the
  plan. Plan approval is pending that re-check.

### E2 npm account and package settings

- Account: 2FA **enabled for "Authorization and writes"** (security key
  preferred), recovery codes offline; no standing tokens (the Access Tokens
  page is empty between releases).
- Token per release: **granular access token**, Read and write, only the
  three packages (from the second release; the `@mosherw` scope or, if the
  form cannot limit unpublished names, "All packages" for the first),
  Organizations no access, **7-day expiry**, allowed IP range = the host's
  public IP, **Bypass two-factor authentication on**; created right before
  the publish, revoked right after (section 7 steps 3-5).
- Each package's Publishing access: **"Require two-factor authentication
  or a granular access token with bypass 2FA enabled"**. Not "Require
  two-factor authentication and disallow tokens" (it would reject the E2
  token), never "Don't require two-factor authentication".

## 10. Implementer model

Implementer model: opus
Reason: security-sensitive, new dependency, ~230 files touched and many
drift tests to keep green while moving docs; the release procedure (two
containers, integrity checks, traps, the E2 token over stdin) must be
written and dry-run exactly.

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
| AC50 | `pnpm pack:check` (contents allow-list, manifest fields, no lifecycle scripts, publishable set C4); `pack-check.test.ts` proves a private-flag drop on server/reader/root and an extra non-private package both fail, and a packed manifest with any lifecycle script (`prepare`, `postpublish`, `preversion`, ...) fails (L10); no `@sync-system/` left (`release-files.test.ts`); full install/lint/typecheck/test/build green |
| AC51 | `pnpm smoke` (`--ignore-scripts`, exact lockfile versions, `--offline`; a unit test of the version lookup asserts exact versions, never ranges) |
| AC52 | Dry run: `docker buildx build --platform linux/amd64 --load`, run with a copied-in dev config (`docker create` + `docker cp`, no bind mount), `/health` `version` = `1.0.0`; labels via `docker inspect`; operator guide lists both registries (drift test) |
| AC53 | `release-files.test.ts`: root `LICENSE` is GPL-3.0, copies byte-equal, every `package.json` `GPL-3.0-only`; `pack:check` requires `LICENSE` in each tarball; docs GPL statement (drift test on the phrase) |
| AC54 | QA runs the `RELEASING.md` dry run end to end (build container from a bundle with the HEAD/clean-tree assertion, `pnpm release:dry-run` printing three integrity lines, `--load` build, `/health`); `release-files.test.ts` checks the markers in `RELEASING.md` (section 7: C1 as amended for E2, C2-C5, L8, L9, L11), including the absence of `--otp`, `npm login`, `-e NPM_TOKEN`, `--env-file` |
| AC55 | QA confirms no publish/push/tag/release happened (`npm view`, registry lookups 404, `git ls-remote --tags` has no `v1.0.0`) |
| AC56 | `ci.yml` has pack and smoke after Build (`repo-hygiene` step-order test); local CI run |

## 12. Implementation chunks

1. `docs(conventions): record the release, license and package-name choices`
   (ADRs 0016 and 0017 were already set to Accepted with the Gate 2
   choices in the plan revision; this chunk records them in
   `docs/conventions.md`: release process with E2 token handling, license,
   package names, scope `release`, links to both ADRs)
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
   publishable-set test, L6 `.npmrc` test)
5. `build(server): label the image and ship the license`
   (Dockerfile OCI labels, runtime-stage `COPY LICENSE ./LICENSE`, hygiene
   test extended for C8)
6. `build(release): add changesets with one fixed version group`
   (`@changesets/cli` exact pin + lockfile, C9; `.changeset/config.json`,
   `.changeset/README.md`, `.changeset/v1-first-release.md`;
   `packageManager` with sha512, L1)
7. `test(release): check packed tarballs and smoke-test a clean install`
   (`scripts/release/{lib,pack-check,smoke,dry-run}.ts`, tests,
   `scripts/tsconfig.json`, ESLint, root scripts `pack:check` (with
   `--out` and `INTEGRITY.txt`), `smoke` (C6), `release:dry-run` (C1
   mirror, `npm publish <tgz> --dry-run`), `.gitignore` `.release-out/`, `.dockerignore` `.release-out` (L11); L10
   lifecycle-script tests)
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
    (README overview, GPL note, package READMEs, `SECURITY.md` (Q-I, L4))
14. `build(docs): fail lint on broken links and anchors`
    (`check-links.ts`, its test, `lint` script; fix any broken link found)
15. `docs(release): add the release procedure`
    (`RELEASING.md` per section 7: host tagging, build container, publish
    container, image push with trap/logout, token revocation, first-release
    ownership and go-public checklist, E2 token creation / stdin hand-off /
    revocation and npm settings, L5 release-note hashes, L8 checks, L9
    subshells and credential-helper check, L11 temp dirs, residual risk;
    `release-files.test.ts` marker checks per section 7)
15a. Adopted at Gate 2 (Q-L3):
    `chore: stop tracking the claude archive` (`git rm --cached .claude.zip`,
    `.gitignore`)
16. `chore(release): version packages for 1.0.0`
    (`pnpm changeset version`: four versions, four `CHANGELOG.md`,
    changeset consumed; `release-files` changelog checks)
17. `docs: close the prd open questions and record the release candidate`
    (PRD AC46 answers, `docs/roadmap.md`, `.prettierignore` if needed)

Docs impact: `README.md`, `RELEASING.md`, `SECURITY.md` (Q-I, L4),
`docs/operator-guide.md`, `docs/protocol.md`, `docs/integration-guide.md`,
`docs/versioning.md`, `docs/startup-errors.md`, `docs/conventions.md`,
`docs/roadmap.md`, the PRD, ADRs 0016-0017, package READMEs, changelogs.

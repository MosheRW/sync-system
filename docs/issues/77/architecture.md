# Architecture: #77 feat(release): publish the reader as a public docker image

Spec: [`spec.md`](spec.md). Path: full. No design (no UI impact).

## Repo layout

- Layout: **monorepo** (pnpm workspaces `apps/*`, `packages/*`; no
  submodules, no `turbo.json`/`nx.json`). One issue, one branch, one PR.
- Affected:
  - `apps/reader` (`@mosherw/sync-system-reader`, private): `/health` body,
    version, Dockerfile, README, new `CHANGELOG.md`. Checks:
    `pnpm --filter @mosherw/sync-system-reader typecheck|test|build`.
  - `apps/sync-server/test` (repo-wide hygiene and release-file tests that
    read the Dockerfiles, `RELEASING.md` and manifests). Checks:
    `pnpm --filter @mosherw/sync-system-server test`.
  - Docs: `RELEASING.md`, `docs/versioning.md`, `docs/conventions.md`,
    `docs/operator-guide.md`, `docs/roadmap.md`, `docs/decisions/0023-*`.
    Root checks: `pnpm lint` (eslint, prettier, `check-links`),
    `pnpm typecheck`, `pnpm test`, `pnpm build`.
- No other repo. `compose.yaml` keeps building the reader locally (no change).

## Decisions

- [ADR 0023](../../decisions/0023-reader-version-tag-and-image.md),
  `Proposed`, decided at Gate 2:
  - **A. Git tag name**: recommended A1 `reader-vX.Y.Z` (`reader-v1.0.0`).
    Alternatives `reader/vX.Y.Z`, `@mosherw/sync-system-reader@X.Y.Z`.
  - **B. Version source and bump**: recommended B1, hand bump of
    `package.json` + `READER_VERSION` + hand-written `CHANGELOG.md`, reader
    stays `private: true` and in Changesets `ignore`; first bump to `1.0.0`
    in this PR. Alternatives: let Changesets version it (B2), or bump later
    in a separate release PR (B3).
  - **C. `/health` body**: recommended C1 JSON
    `{"status":"ok","version":"X.Y.Z"}`. Alternatives text `ok X.Y.Z` (C2),
    keep `ok` and read the version from the image's `package.json` (C3,
    does not meet the spec).
  - **D. Image**: recommended D1, the ADR 0017 procedure with the reader's
    names (tags `X.Y.Z`, `X.Y`, `X`, `latest`; amd64 + arm64; temporary
    `DOCKER_CONFIG`; GHCR classic PAT `write:packages`; Docker Hub PAT
    "Read & Write"). Alternative `X.Y.Z` only.
  - E (blocker gate on #27 and #28) is the Gate 1 decision, recorded only.

## Findings that shape the plan

- **The reader's `/health` has no version today**: `apps/reader/server/handler.ts`
  answers `200 text/plain "ok\n"`. The spec needs the version on `/health`,
  so a small product-code change is required (ADR 0023 C).
- The version already exists as `READER_VERSION` in
  `apps/reader/src/config/version.ts`, pinned to `package.json` by
  `apps/reader/test/sync-config.node.test.ts` ("keeps READER_VERSION equal to
  package.json"). `/health` uses that constant: no file read at startup, no
  new startup error, no `semver` dependency.
- `private: true` **stays**: it is what keeps the reader off npm (pnpm and
  Changesets skip private packages; `pack:check` `checkPublishableSet` and
  `release-files.test.ts` require it). The Changesets `ignore` entry stays
  (pinned by `release-files.test.ts`). Nothing in `scripts/release/` needs a
  change: it only asserts the reader is private.
- `apps/sync-server/test/release-files.test.ts:513` pins the reader at
  `0.1.0` with no `CHANGELOG.md`: it must change with the bump.
- `apps/sync-server/test/repo-hygiene.test.ts` checks labels, `LICENSE`,
  digest pins, `USER node` and credential-free `ARG`/`ENV` for the **server**
  Dockerfile only; it is extended to the reader's.
- The server Dockerfile has static OCI labels and `COPY LICENSE ./LICENSE` in
  the runtime stage (ADR 0017); the reader's has neither. The reference
  applies.
- `origin/main` moved (ff5984d): PR #73 merged and **#27 is closed**; **#28
  is open**. The gate still lists both. The engineer merges `origin/main`
  into the branch before chunk 1 (`chore: merge main into ...`, the existing
  pattern), no rebase.

## Approach

1. Accept ADR 0023 and record it in `docs/conventions.md`.
2. `/health` returns `{"status":"ok","version":READER_VERSION}` as JSON;
   the body is built once in `createHandler` from a new `version` option
   that `run.ts` passes (`READER_VERSION`).
3. Reader Dockerfile: the server's static OCI labels (reader title and
   description) and `COPY LICENSE ./LICENSE` in the runtime stage; no
   `version`/`revision` label in the file (added by the release command).
   The hygiene tests run over both Dockerfiles.
4. Bump the reader to `1.0.0` (package.json, `READER_VERSION`) and add a
   hand-written `apps/reader/CHANGELOG.md` with a `## 1.0.0` entry.
5. Docs: a "Public image" section in `apps/reader/README.md`, a pointer from
   the operator guide, the reader's versioning rules in `docs/versioning.md`.
6. `RELEASING.md`: one self-contained "Reader image release" section at the
   end of Phase B (before "Dry run (QA)"), plus one pointer line in the
   intro. Server steps are not rewritten. Load-bearing lines get tests.
7. `docs/roadmap.md`: #77's own line under "Parked follow-ups".

Alternatives rejected: a new `readReaderVersion()` from `/app/package.json`
like the server's `version.ts` (more code, a new startup error and a size
cap, while a test-pinned constant already exists); building the reader image
inside the release container with the host Docker socket (rejected for the
server in ADR 0017 A2); reusing step 1 to tag the reader (it checks the four
group manifests and creates `v$V`).

## Files to create / modify

| Path | Change |
| --- | --- |
| `docs/decisions/0023-reader-version-tag-and-image.md` | New ADR (this plan, `Proposed`); chunk 1 sets `Accepted` with the user's choices |
| `docs/conventions.md` | "Packages, license and release" table: rows for reader version/tag and reader image (ADR 0023); "Private" stays |
| `apps/reader/server/handler.ts` | `HandlerOptions.version: string`; `/health` sends the JSON body (`application/json`, `no-store`, security headers), built once; doc comment updated |
| `apps/reader/server/run.ts` | Passes `version: READER_VERSION` to `createHandler` |
| `apps/reader/test/server-handler.node.test.ts` | `/health` test: 200, `application/json`, body equals `{"status":"ok","version":READER_VERSION}`, `HEAD` has no body, security headers |
| `apps/reader/Dockerfile` | Runtime stage: `COPY LICENSE ./LICENSE`, `LABEL` with `source`, `licenses`, `title="sync-system-reader"`, `description`; header comment points to ADR 0023 |
| `apps/sync-server/test/repo-hygiene.test.ts` | Run "image license and labels", "pins every base image by digest" and "runs as node" over both Dockerfiles (`describe.each`/`it.each`); reader: never copies the repo root |
| `apps/reader/package.json` | `version` `0.1.0` → `1.0.0` (still `private: true`) |
| `apps/reader/src/config/version.ts` | `READER_VERSION = '1.0.0'`; comment mentions `/health` |
| `apps/reader/CHANGELOG.md` | New, hand-written: `# @mosherw/sync-system-reader`, `## 1.0.0` (first public image; `/health` now JSON with `version`; links to README) |
| `apps/sync-server/test/release-files.test.ts` | Reader test: private, at `READER_VERSION`'s version `1.0.0`, `CHANGELOG.md` with `## 1.0.0`, outside the group; later (chunk 6) reader `RELEASING.md` load-bearing lines |
| `apps/reader/README.md` | New "Public image" section; `/health` row in "Pages" updated to the JSON body |
| `docs/operator-guide.md` | One short paragraph/pointer to the reader's "Public image" section, near the existing reader mention (line ~125) |
| `docs/versioning.md` | Replace "private and has no public version" with a "The reading app" section: own version, tag `reader-vX.Y.Z`, image names, never on npm, what is breaking for the reader |
| `RELEASING.md` | One pointer line in the intro; new "Reader image release" section (below) |
| `docs/roadmap.md` | Only #77's own line in "Parked follow-ups" |
| `docs/issues/77/STATE.md` | Updated by each agent |

Unchanged on purpose: `.changeset/config.json`, `scripts/release/*`,
`compose.yaml`, `apps/sync-server/Dockerfile`, every server step of
`RELEASING.md`.

## Contracts

### Reader `GET /health` (and `HEAD /health`)

- Status `200` while the process serves HTTP (liveness only; no `/ready`,
  Q25 of #36 stands).
- Headers: the reader's security headers (unchanged),
  `Content-Type: application/json`, `Cache-Control: no-store`,
  `Content-Length`.
- Body (GET): exactly `{"status":"ok","version":"<READER_VERSION>"}`, no
  newline, nothing else: no config, no sync URL, no API key, no host data.
  `HEAD`: no body.
- `version` is the build's `READER_VERSION`, never `READER_SYNC_APP_VERSION`.
- Change from `ok\n`: the reader was never released, so not a breaking
  change of a published contract; noted in `apps/reader/CHANGELOG.md`. The
  Dockerfile and compose HEALTHCHECKs only read `r.ok`: unchanged.

### Image contract (documented in the README, listed as breaking-if-changed in `docs/versioning.md`)

- Names: `ghcr.io/mosherw/sync-system-reader` (canonical),
  `docker.io/moshewin/sync-system-reader` (mirror); tags `X.Y.Z`, `X.Y`,
  `X`, `latest`; `linux/amd64`, `linux/arm64`.
- Port `8080` (`PORT`), user `node`, `/health`, config only from the
  `READER_*` env variables (README table), nothing secret in the image.
- Labels: static `source`, `licenses`, `title`, `description`; `version`
  and `revision` added at release.

### Git tag

`reader-vX.Y.Z`, annotated, on a commit of `origin/main` whose
`apps/reader/package.json` and `READER_VERSION` equal `X.Y.Z` (ADR 0023 A1).

## `RELEASING.md` reader section (content the engineer writes)

Heading `## Reader image release` placed after Phase B step 8 and before
`## Dry run (QA)`. Its own subheadings use an `R` prefix so they never match
the existing `### N. ...` lookups in `release-files.test.ts`. Variables
`RV` (reader version) and `RM` (reader commit) so they never mix with the
package release's `V` and `M`. Every block is one `( set -euo pipefail ... )`
subshell, starts with `export MSYS_NO_PATHCONV=1`, converts host paths with
`cygpath -m`, as the existing blocks.

- Intro: standalone release with its own version (ADR 0023); maintainer
  only; agents never tag/push; same "rule" table (host for tag and image,
  build container with no credential).
  **Blocked**: "Do not release the reader image until #27 and #28 are
  closed"; the R1 block enforces it.
- **R0. First reader release only**: Docker Hub repository
  `moshewin/sync-system-reader` exists and is public; never push to the
  placeholder namespace `mosherw` on Docker Hub; GHCR namespace check.
- **R1. Tag on the host**: checks `RV` matches `^[0-9]+\.[0-9]+\.[0-9]+$`;
  `RM` is a 40-hex commit and an ancestor of `origin/main`;
  `git show "$RM:apps/reader/package.json"` has `"version": "$RV"` and
  `"private": true`; `git show "$RM:apps/reader/src/config/version.ts"`
  has `'$RV'`; `git show "$RM:apps/reader/CHANGELOG.md"` has `## $RV`;
  for each of `BLOCKERS="27 28"`,
  `gh issue view "$n" --json state --jq .state` is `CLOSED`, else exit,
  and `RM`'s committer date is not older than that issue's `closedAt`
  (`--json closedAt`), so the tag cannot land on a commit from before the
  fixes; `reader-v$RV` does not exist locally or on origin; then
  `git tag -a "reader-v$RV" "$RM" -m "reader-v$RV"` and push that tag only.
- **R2. Checks in the build container**: run the existing step 2 block
  unchanged with `export REF="reader-v$RV" M="$RM" MODE=dry-run` and a fresh
  `REL="$(mktemp -d)"` (full lint, typecheck, test with Redis, build, smoke;
  the npm dry run needs no token); it must finish green; ignore the printed
  integrity lines; `unset REF M MODE` afterwards. (No edit to step 2.)
- **R3. Check the image (no credential)**: `IMG="$(mktemp -d)"`; fresh
  `git clone --branch "reader-v$RV" --depth 1` (`SRC_URL`/`REF` overridable
  for the dry run); `HEAD` = `RM`, clean tree; `docker buildx build
  --platform linux/amd64 --load -f apps/reader/Dockerfile --label
  org.opencontainers.image.version=$RV --label
  org.opencontainers.image.revision=$RM -t sync-reader-check:$RV`; `trap`
  removes the check container; run it with no env (`-e`-free; defaults
  start the library); poll `/health` with `docker exec ... node -e fetch`;
  `grep -q "\"version\":\"$RV\""`; `[ "$(docker exec ... id -u)" != 0 ]`
  (non-root); print the labels; then
  `docker buildx build --platform linux/arm64 -f ... "$D/src"` (build only,
  no push, no load) to prove the arm64 build. Note when to run
  `docker buildx create --use --name sync-release` (as step 6).
- **R4. Push**: identical structure to step 6's push block (temporary
  `DOCKER_CONFIG`, `trap` with both logouts and `rm -rf` set before the
  first login, `read -rs`, `--password-stdin`, `unset T`, `-u mosherw` for
  GHCR, `-u moshewin` for Docker Hub), one `docker buildx build --platform
  linux/amd64,linux/arm64 --push` of `apps/reader/Dockerfile` with the
  version/revision labels and the four tags in each registry
  (`ghcr.io/mosherw/sync-system-reader:{RV,MAJOR.MINOR,MAJOR,latest}`,
  `docker.io/moshewin/sync-system-reader:{...}`), then `imagetools inspect`
  of both `:$RV`. Then the credential-helper check and token revocation
  text (may link to step 6's paragraph instead of copying it).
- **R5. GitHub release**: notes = the `## $RV` section of
  `apps/reader/CHANGELOG.md` + the manifest-list digest;
  `gh release create "reader-v$RV" --title "Reader $RV" --latest=false
  --notes-file notes.md`.
- **R6. After the release (checklist)**:
  - [ ] First release: set the GHCR package `sync-system-reader` public.
  - [ ] Anonymous pull by tag works from both registries:
        `( export DOCKER_CONFIG="$(mktemp -d)"; docker pull
        ghcr.io/mosherw/sync-system-reader:$RV; docker pull
        docker.io/moshewin/sync-system-reader:$RV; rm -rf "$DOCKER_CONFIG" )`
        and the digests equal R4's.
  - [ ] Both registry tokens revoked; no login left in the credential
        helper; `rm -rf "$IMG" "$REL"`.
- **Reader dry run (QA)**: R3 from the local clone
  (`SRC_URL="file://..."`, `REF=<branch>`, `RM="$(git rev-parse HEAD)"`,
  `RV` = the branch's reader version), never R1, R4, R5.
- **Pointer** in the intro (one line): "The reading app's image has its own
  standalone release: see [Reader image release](#reader-image-release)."

Tests in `release-files.test.ts` (new `describe`, section sliced from
`## Reader image release` to the next `## `): contains `reader-v$RV`,
`BLOCKERS="27 28"` and `gh issue view`, `--json state`, `CLOSED`;
`--platform linux/amd64,linux/arm64`, `--push`, all eight image refs;
`export DOCKER_CONFIG=`, the `trap 'docker logout ghcr.io` set before the
first `docker login`, `--password-stdin`, `read -rs`, no `docker login -p`;
`write:packages`; `/health` and `"version":"$RV"`; `id -u`;
`--latest=false`; never `docker push` to `docker.io/mosherw/`; and the
existing ban list (`npm login`, `--otp`, ...) still holds for the whole file.

## Docker impact

`apps/reader/Dockerfile` runtime stage gains `COPY LICENSE ./LICENSE` (one
file, never a directory or the context root) and static `LABEL`s. No new
`ARG`/`ENV`, base image digest unchanged, still `USER node`, `EXPOSE 8080`,
HEALTHCHECK on `/health` unchanged. `compose.yaml` unchanged
(`docker compose config` must still pass). Check `.dockerignore` lets
`LICENSE` in (it does for the server).

## Docs impact

`apps/reader/README.md`, `apps/reader/CHANGELOG.md` (new),
`docs/operator-guide.md` (pointer), `docs/versioning.md`,
`docs/conventions.md`, `RELEASING.md` (reader section + pointer),
`docs/roadmap.md` (#77 line), ADR 0023.

Reader README "Public image" section contents (link to the existing tables
instead of duplicating them):

- `docker run` example for each registry, pinned to `1.0.0`, hardened like
  compose: `-p 127.0.0.1:8081:8080 --read-only --cap-drop ALL
  --security-opt no-new-privileges`, `-e READER_*`; production: pin
  `X.Y.Z` or a digest; floating tags move.
- Every env variable: links to "Configuration" and "Sync settings" tables
  (which list all of them with defaults and examples), plus `PORT`/`HOST`.
- Pointing at a sync server: `READER_SYNC_URL=wss://...`,
  `READER_SYNC_API_KEY` = the reader's own registration in the server's apps
  file; the browser connects to that URL (not the container), so it must be
  the public `wss:` address; HTTPS required (link "HTTPS is required").
- **No secret in or baked into the image**: none of the reader's settings is
  a secret; the image holds only the built app, the server and zod; config
  is env only, injected into the page at startup.
- **The API key is public by design** (security M1 of #24): it ships in
  every page; give the reader its own registration with tight per-app
  limits and put **per-IP connection and message rate limits at the reverse
  proxy**.
- **`?src` stays off on public deployments**: off by default
  (`READER_SRC_ORIGINS` empty); turning it on lets any link make visitors'
  browsers fetch from the listed origins, with the ADR 0006 risks (link to
  ADR 0006 and the "Fetched content" section).
- Port `8080`, `/health` only (liveness, JSON with `version`, no `/ready`),
  used by the HEALTHCHECK and the release check; the version is visible to
  anyone who reaches it, deny `/health` at the proxy if that matters.
- Release status: the first image (`1.0.0`) is published after #27 and #28
  are closed; until then build locally (compose).

## Risks / edge cases

- **Parallel edits.** A sibling session (`claude/releasing-fixes-c95a57`,
  not pushed yet) edits `RELEASING.md` and `docs/roadmap.md`. Mitigation:
  `RELEASING.md` and roadmap chunks come last; before them the engineer runs
  `git fetch origin` and `gh pr list --state all --search "releasing" --json
  number,title,headRefName,state` (and checks `origin/main` for its merge).
  If its PR is merged, merge `origin/main` first; if it is open, keep the
  reader section self-contained (new section + one intro line only) and note
  the expected trivial conflict in STATE.md "Deviations". The sibling may
  also touch `apps/sync-server/test/release-files.test.ts`: same check.
- A maintainer runs R1 with `RM` pointing at a commit before the #27/#28
  fixes: the gate checks issue state, not commit content. Mitigation: R1
  text says to use the current `origin/main` head after both are closed, and
  the R1 block refuses when `RM`'s committer date (`git log -1
  --format=%cI`) is older than either issue's `closedAt`. A heuristic, not
  proof: the security plan review may ask for more (e.g. naming the fix
  PRs' merge commits and checking they are ancestors of `RM`).
- Floating `latest` for the reader is a different image than the server's
  `latest`: the README says to pin.
- arm64 build via QEMU is slow (Vite build under emulation); documented.
- `READER_SYNC_APP_VERSION` default changes to `1.0.0`: higher than any
  `minAppVersion` in use (`0.0.0` in `apps.dev.json`), so nothing is refused.
- `test/helpers/app.tsx` uses a fixture `appVersion: '0.1.0'`: a fixture,
  not the build version; leave it (or switch to `READER_VERSION`), no
  behaviour depends on it.
- GitHub release "Latest" flag: `--latest=false` keeps `v1.0.0` latest.

## Security-sensitive areas

Security-sensitive: yes

- **Release / supply chain**: the new `RELEASING.md` reader section (tag
  creation on the host, fresh clone and commit/clean-tree checks, buildx
  push to two public registries), registry credentials (temporary
  `DOCKER_CONFIG`, `trap` logout, `read -rs` + `--password-stdin`, GHCR
  classic PAT `write:packages` only, Docker Hub "Read & Write", revocation),
  the #27/#28 gate in R1.
- **Image contents**: `apps/reader/Dockerfile` (`LICENSE` one file only,
  static labels, no credential `ARG`/`ENV`, digest-pinned base, non-root,
  no repo root or `config/` copied); hygiene tests extended to it.
- **HTTP endpoint**: `/health` body changes (version disclosure, no other
  data; fixed body built once, no input reflected).
- **npm exposure**: the reader must stay `private: true` (version bump must
  not drop it; `pack:check` and tests enforce it).
- **Operator docs**: public API key (M1) and per-IP proxy limits, `?src`
  risk (ADR 0006) and keeping it off, no secret in the image.
- No new or upgraded dependencies, no schema, no auth/crypto change.

## Implementer model

Implementer model: opus
Reason: security-sensitive release procedure with an open ADR, a changed
HTTP contract, and ~13 files across code, tests and release docs.

## Test plan

All checks run locally (GitHub Actions is billing-blocked, ADR 0018). CI
equivalent: in Docker, the pinned `node:24@sha256:9d26...7496` image (the
`NODE_IMAGE` of `RELEASING.md`), the repo **copied in** with `.git`
(`docker cp`, no bind mount), a Redis sidecar (`redis:7.2.17-alpine` pinned,
`--requirepass`, own network), `CI=true` and
`SYNC_TEST_REDIS_URL=redis://:<pw>@<sidecar>:6379`; run
`corepack enable && pnpm install --frozen-lockfile && pnpm audit
--audit-level=high && pnpm lint && pnpm typecheck && pnpm test && pnpm build
&& pnpm smoke`. Note #67 (12 pnpmfile tests fail in the node:24 container)
is pre-existing on `main`: compare against `main`, report, don't fix.

| AC | Check |
| --- | --- |
| RELEASING.md reader procedure | New `release-files.test.ts` describe (load-bearing lines above); `pnpm docs:links`; manual read-through against step 6 / ADR 0017 |
| Build verified (amd64 + arm64, non-root, `/health` version) | QA runs the **reader dry run** (R3 from the local clone of the branch): amd64 `--load` build, `/health` `"version":"1.0.0"`, `id -u` ≠ 0, arm64 build-only succeeds (docker-container builder) |
| OCI labels + `version`/`revision` at build | `repo-hygiene.test.ts` over both Dockerfiles; R3 prints `docker inspect` labels with `version=1.0.0` and `revision=<sha>` |
| Own version 1.0.0, outside the group, agrees | `release-files.test.ts` reader test (1.0.0, private, `ignore` unchanged, CHANGELOG `## 1.0.0`); `sync-config.node.test.ts` (READER_VERSION = package.json); `pnpm pack:check` (reader still private) |
| Tag `reader-vX.Y.Z` used in docs | `release-files.test.ts`; grep `docs/versioning.md` and `RELEASING.md` |
| Blocked on #27 and #28 stated | `release-files.test.ts` (`BLOCKERS="27 28"`, `CLOSED`); text in README and RELEASING |
| README + operator-guide pointer | Manual review; `check-links` |
| API key public, per-IP limits, `?src` off on public | Manual review of README "Public image" |
| `/health` only | `server-handler.node.test.ts` (JSON body, `HEAD`, 404 for `/ready`); HEALTHCHECK unchanged; `docker compose up --build reader` shows `(healthy)` |
| ADR added | ADR 0023 `Accepted` after Gate 2, conventions rows |
| Release checklist reader line | `release-files.test.ts` (anonymous pull, GHCR public); manual |
| Roadmap line | Manual (only #77's line added) |
| Nothing pushed/tagged/published | `git ls-remote --tags origin 'reader-v*'` empty; no registry login performed |
| Repo checks pass | The local Docker CI run above, plus `docker compose config` |

## Implementation chunks

Before chunk 1: `git fetch origin && git merge origin/main` into the branch
if `main` moved (commit `chore: merge main into feat/77-reader-image-release`).

1. `docs(adr): accept 0023 reader version tag and image`
   ADR 0023 → `Accepted` with the user's Gate 2 choices; `docs/conventions.md`
   rows.
2. `feat(reader): report the reader version on /health`
   `handler.ts`, `run.ts`, `server-handler.node.test.ts`.
3. `build(reader): add oci labels and the license file to the reader image`
   `apps/reader/Dockerfile`, `repo-hygiene.test.ts`.
4. `chore(release): set the reader version to 1.0.0`
   `apps/reader/package.json`, `src/config/version.ts`, new
   `apps/reader/CHANGELOG.md`, reader test in `release-files.test.ts`.
5. `docs(reader): document running the public reader image`
   `apps/reader/README.md`, `docs/operator-guide.md` pointer,
   `docs/versioning.md`.
6. `docs(release): add the standalone reader image release`
   **First** `git fetch origin` and check for a releasing-fixes PR / merge
   (see Risks). `RELEASING.md` reader section + intro pointer, reader
   load-bearing tests in `release-files.test.ts`.
7. `docs(roadmap): record the reader image issue #77`
   Same fetch check first. Only #77's line in "Parked follow-ups", e.g.
   "#77 `feat(release): publish the reader as a public docker image`: in
   progress (PR #<M>); the image release is blocked on #27 and #28."

Every commit: `Refs: #77`, staged by explicit path.

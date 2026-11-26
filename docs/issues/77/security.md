# Security review (plan): #77 publish the reader as a public docker image

Mode: plan. Inputs: [`spec.md`](spec.md), [`architecture.md`](architecture.md),
[ADR 0023](../../decisions/0023-reader-version-tag-and-image.md) (Proposed),
[ADR 0017](../../decisions/0017-server-image-publishing.md),
`RELEASING.md` steps 1, 2, 6-8, `apps/reader/Dockerfile`, `.dockerignore`,
`apps/reader/server/{handler,run,headers}.ts`, `apps/reader/package.json`,
`apps/reader/tsconfig.server.json`, `apps/reader/vite.config.ts`.

**Verdict: PASS.** No critical or high finding. 3 medium, 7 low. The plan
reuses the reviewed ADR 0017 procedure; the gaps below are cheap to close
and are listed as required controls so they land in this PR.

## Assets and trust boundaries

| Asset | Where it lives | Boundary |
| --- | --- | --- |
| GHCR classic PAT, Docker Hub PAT | Maintainer host, minutes only (temporary `DOCKER_CONFIG` / OS credential helper, BuildKit session) | Host only; never a build arg, env or container |
| Public images `ghcr.io/mosherw/sync-system-reader`, `docker.io/moshewin/sync-system-reader` (4 tags, 2 platforms) | Registries | Anything pushed is world-readable and pulled by operators; `latest`/`X`/`X.Y` float |
| Git tag `reader-vX.Y.Z`, GitHub release | origin | Public; release must not become "Latest" over `v1.0.0` |
| npm scope `@mosherw` | npmjs.com | The reader must never be published (`private: true`) |
| Reader runtime config (`READER_*`) | Container env, **injected into every page** | Everything in it is public to every visitor |
| `/health` body | Reader HTTP | Unauthenticated, internet-facing |

## Threats (STRIDE, short)

- **Spoofing:** a look-alike image name (`docker.io/mosherw/...`, the
  placeholder namespace) or a tag moved on origin between tag and build.
- **Tampering:** pushing an image built from a clone that failed (or never
  ran) the checks; a compromised/unpinned BuildKit image during the push
  build; `gh release create` silently creating the tag on `main` HEAD.
- **Repudiation:** image not traceable to a commit (mitigated: `revision`
  label, `/health` version, digest in release notes).
- **Information disclosure:** registry token with broader scope than
  intended (`repo`); a secret placed in `READER_*` by an operator and then
  served to every browser; source maps, `.env`, dev deps in the image;
  version on `/health`.
- **Denial of service:** the public API key lets anyone open sync
  connections (M1 of #24): per-app and per-IP limits.
- **Elevation of privilege:** container running as root; repo write via an
  over-scoped PAT.

## What the plan already gets right

- Credential handling copies step 6 exactly: temporary `DOCKER_CONFIG`,
  `trap` with both logouts set before the first login, `read -rs`,
  `printf | --password-stdin` (builtin, no token in argv), `unset T`,
  shortest-expiry tokens, revocation, post-run credential-helper check.
- Fresh `git clone --branch reader-vRV --depth 1` into `mktemp -d`, `HEAD`
  == `RM`, clean tree; build only from that clone.
- `private: true` kept and Changesets `ignore` unchanged (B1): npm cannot
  publish it by construction; the publish container only takes the three
  checked tarballs. R1 re-checks `"private": true` at `RM`.
- Tag `reader-vX.Y.Z` never matches `v$V` or `v*`; `--latest=false`.
- Runtime stage copies only `package.json`, `node_modules` (`deploy --prod`:
  zod only), `dist`, `dist-server`; Vite `sourcemap: false`, server
  `sourceMap: false`; `.dockerignore` drops `.env*`, `config/`, `.git`;
  base image digest-pinned (same index digest as the multi-arch server
  image); files root-owned; `USER node`; R3 checks `id -u` != 0.
- `/health` body is a constant built once from the build's `READER_VERSION`,
  never from env or the request; security headers (CSP, `nosniff`) kept.
- Never pushing to `docker.io/mosherw/` is pinned by a test.

## Findings

| # | Severity | Location | Issue / attack scenario | Fix |
| --- | --- | --- | --- | --- |
| M1 | Medium | architecture.md "R4. Push" (also existing step 6) | R4 builds and pushes whatever is in `$IMG/src` without re-checking it. If R3 failed (wrong `HEAD` because the tag was moved on origin, dirty tree, `/health` mismatch) or was never run, and the maintainer pastes R4 anyway, an unchecked build goes public under `latest` with a `revision` label claiming `RM`. | R3 writes `$IMG/checked` (outside `src`) containing `RM` as its **last** line, only after every check passed. R4 refuses unless that file equals `RM`, and re-checks `git -C "$D/src" rev-parse HEAD` == `RM` and an empty `git status --porcelain` before the first login. |
| M2 | Medium | architecture.md R4 / ADR 0023 D1 ("GHCR classic PAT with only `write:packages`") | GitHub's classic-token form **auto-ticks `repo`** when `write:packages` is ticked. A maintainer following "only write:packages" can end up with a full `repo` token on the host; a host compromise in that window can push code and move tags (`v1.0.0`, `reader-v*`). | Tell the maintainer to create it from `https://github.com/settings/tokens/new?scopes=write:packages` (pre-selects only that scope), and check the token page lists only `write:packages` (and implied `read:packages`) before using it; if `repo` is ticked, untick it. Same text applies to step 6: note it as a follow-up for the server section (out of this PR's edit scope). |
| M3 | Medium (advisory) | architecture.md R3 note "`docker buildx create --use --name sync-release`" (as step 6) | The docker-container builder runs the unpinned `moby/buildkit:buildx-stable-1` image, which performs the push with the registry auth handed over by the client session; a compromised tag on Docker Hub would sit in the middle of the release. | Pin it: `docker buildx create --use --name sync-release --driver-opt image=moby/buildkit:<version>@sha256:<digest>`, bumped deliberately like `NODE_IMAGE`. Can be a follow-up shared with step 6. |
| L1 | Low | architecture.md "R1" blocker gate, Risks bullet 2 | The "`RM`'s committer date not older than `closedAt`" rule is wrong both ways. Evidence: #27's fix merge `3fcf1a9` was committed 16:09:36Z, #27 `closedAt` 16:09:38Z: the gate would refuse the very fix commit. If #28 is closed last with no later commit on `main`, no valid `RM` exists. And a date says nothing about content. (Release correctness, not a security hole.) | Replace the date rule. For each blocker: `state` is `CLOSED` and `stateReason` is `COMPLETED` (print it; refuse `NOT_PLANNED` unless the maintainer re-runs with an explicit override); for every PR in `gh issue view "$n" --json closedByPullRequestsReferences`, its `mergeCommit.oid` must satisfy `git merge-base --is-ancestor "$merge" "$RM"`. A blocker closed with no PR prints a line asking for a manual confirmation (`read -r -p 'type yes'`). Also default `RM` to `git rev-parse origin/main` after `git fetch`. |
| L2 | Low | architecture.md "R5" | `gh release create "reader-v$RV"` creates the tag on the default branch HEAD when the tag does not exist on origin (typo, failed push), producing a public reader release on an unchecked commit. | Add `--verify-tag` (with `--latest=false`). Test both flags. |
| L3 | Low | ADR 0023 C1, architecture.md `/health` contract | `/health` discloses the exact version to anyone. Low value to an attacker (version is public in tags and the source); accepted with the documented "deny `/health` at the proxy" option. | Keep as planned: constant body from `READER_VERSION`, never `READER_SYNC_APP_VERSION` or request data; test the exact body. |
| L4 | Low | architecture.md "R6" anonymous pull snippet | `export DOCKER_CONFIG="$(mktemp -d)"` without `cygpath -m`, outside a `( set -euo pipefail ... )` subshell and `trap`: on Git Bash the path may not be what `docker.exe` sees, and the variable leaks into the shell if a pull fails (later blocks then use an empty config). | Same pattern as the other blocks: subshell, `MSYS_NO_PATHCONV=1`, `cygpath -m`, `trap 'rm -rf "$DOCKER_CONFIG"' EXIT`; print both digests and compare with R4's. |
| L5 | Low (advisory) | architecture.md R1 → R2/R3 order | The public tag is pushed before the build checks run; a failing R2/R3 leaves a public `reader-vX.Y.Z` on a broken commit (moving a public tag is worse). Same order as the server. | Optional: run the reader dry run (R3 from the local clone at `RM`) before R1. |
| L6 | Low (advisory) | RELEASING.md "Residual risk" | Docker Hub PATs are account-wide: the reader-release token can also push `moshewin/sync-system-server`. | Accept; say so in the reader section's residual risk line (shortest expiry, revoke within minutes). |
| L7 | Low (advisory) | architecture.md R3 | No vulnerability check of the image before it goes public; the pinned `node:24-alpine` digest ages. | Optional: if `docker scout` (or another scanner) is installed, run `docker scout cves --only-severity critical,high sync-reader-check:$RV` in R3 and record the result; the base-image bump policy stays as is. |

(L8, hygiene, parity with the server and not required: the tag is annotated,
not signed; `git tag -s` would let users verify it.)

## Required controls (part of the plan the engineer must implement)

1. **npm stays shut.** `apps/reader/package.json` keeps `"private": true` at
   `1.0.0`; `.changeset/config.json` and `scripts/release/*` unchanged;
   `release-files.test.ts` pins private + `1.0.0` + Changesets `ignore`;
   `pnpm pack:check` still passes. R1 checks `"private": true` at `RM`.
2. **Image contents.** Reader runtime stage: `COPY` only
   `/out/package.json`, `/out/node_modules`, `/out/dist`, `/out/dist-server`
   and `LICENSE` (one file); no `ARG`/`ENV` with a credential-like name;
   both `FROM` digest-pinned; `USER node` before `CMD`. Extend
   `repo-hygiene.test.ts` to the reader as planned, **plus** assert the
   reader runtime stage's `COPY` set is exactly that allow-list, and that
   `vite.config.ts` has `sourcemap: false` and `tsconfig.server.json`
   `"sourceMap": false`.
3. **`/health`.** Exactly `{"status":"ok","version":"<READER_VERSION>"}`,
   built once from the constant, `application/json`, `no-store`, all
   security headers, `HEAD` without body; never env or request data. Tests
   as planned.
4. **R1 tag block.** `RV` regex; `RM` 40-hex, ancestor of `origin/main`
   (default `RM=$(git rev-parse origin/main)`); version, `private`,
   `READER_VERSION`, `CHANGELOG` checks at `RM`; the blocker gate as fixed
   in L1 (state + `stateReason` + closing PRs' merge commits are ancestors
   of `RM`; manual confirmation when no PR), not the committer-date rule;
   tag absent locally **and** on origin
   (`git ls-remote --exit-code --tags origin "refs/tags/reader-v$RV"` must
   fail); push only `refs/tags/reader-v$RV`.
5. **R3 check.** Fresh clone, `HEAD` == `RM`, clean tree; container gets no
   env secrets, no host mounts, no credential; `/health` version check;
   `id -u` != 0; labels printed; arm64 build-only; on success only, write
   `$IMG/checked` = `RM` (M1).
6. **R4 push.** Step 6's credential pattern unchanged (temp
   `DOCKER_CONFIG`, `trap` before first login, `read -rs`,
   `--password-stdin`, `unset T`, no `-p`, no `set -x`); refuses without
   `$IMG/checked` == `RM` and re-checks `HEAD`/clean tree (M1); exact eight
   refs, none under `docker.io/mosherw/`; then the credential-helper check
   and token revocation (copied or linked to step 6).
7. **Tokens.** GHCR classic PAT created via
   `https://github.com/settings/tokens/new?scopes=write:packages`, scope list
   checked (no `repo`) (M2); Docker Hub PAT "Read & Write" (not Delete);
   shortest expiry; both revoked after R4.
8. **R5 release.** `gh release create "reader-v$RV" --verify-tag
   --latest=false --title "Reader $RV" --notes-file ...`; notes carry the
   manifest-list digest (L2).
9. **R6.** Anonymous pull in a subshell with a `cygpath`-converted temporary
   `DOCKER_CONFIG` and `trap` (L4); digests equal R4's; GHCR package public.
10. **Operator docs (`apps/reader/README.md` "Public image") must say:**
    - Every `READER_*` value is sent to every visitor's browser (it is
      injected into the page). Never put a secret there; never reuse the
      sync server's or another app's API key. Give the reader its **own**
      app registration with tight per-app limits (M1 of #24: the key is
      public by design).
    - Put per-IP connection and message rate limits at the reverse proxy.
    - Keep `?src` off (`READER_SRC_ORIGINS` empty) on public deployments;
      link ADR 0006 and the "Fetched content" section for the risk.
    - Run behind a TLS proxy, publish on loopback
      (`-p 127.0.0.1:8081:8080`), `wss://` sync URL, plus
      `--read-only --cap-drop ALL --security-opt no-new-privileges`.
    - Pin `X.Y.Z` or a digest in production; check the digest against the
      GitHub release notes; floating tags move.
    - The only official names are `ghcr.io/mosherw/sync-system-reader` and
      `docker.io/moshewin/sync-system-reader`; anything else (for example
      `docker.io/mosherw/...`) is not this project.
    - `/health` shows the version; deny it at the proxy except from
      monitoring if that matters.
11. **Tests (`release-files.test.ts`)**, in addition to the planned list:
    `--verify-tag`, the `$IMG/checked` marker written in R3 and required in
    R4, `scopes=write:packages`, `closedByPullRequestsReferences` and
    `merge-base --is-ancestor` in R1, and the absence of a committer-date
    comparison.

## Advisories for Gate 2 (do not block)

- M3: pin the BuildKit builder image (shared with step 6; follow-up issue).
- M2 also applies to the server's step 6 text: follow-up, since this PR does
  not edit server steps.
- L5 (dry-run before tagging), L6 (account-wide Docker Hub PAT), L7 (image
  CVE scan if a scanner is installed), L8 (signed tags).

## What I will check in code mode

- gitleaks over the PR commits, semgrep on changed files, `npm audit`
  (no dependency change expected).
- Every required control above, line by line, in `RELEASING.md`, the
  Dockerfile, `handler.ts`/`run.ts` and the tests.
- `private: true` and the Changesets config untouched; no new `ARG`/`ENV`;
  no `docker login -p`, `set -x`, `echo $T`, or push to `docker.io/mosherw/`
  anywhere in the file.
- The README "Public image" section has every point in control 10.
- No tag `reader-v*` on origin, no image pushed, nothing published
  (`git ls-remote --tags origin 'reader-v*'` empty).

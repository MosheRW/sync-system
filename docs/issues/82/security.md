# Security review (plan): #82 GHCR token scope and BuildKit pin

Reviewed: [architecture.md](architecture.md) against [spec.md](spec.md) and
findings M2/M3 in [docs/issues/77/security.md](../77/security.md).
Mode: plan. Reviewer: Security Engineer (Opus).

**Verdict: PASS** (critical 0, high 0, medium 1, low 3).
M-1 is a correction of the plan's claim, not a new hole. It should be
settled at Gate 2 (see "Required controls" C5).

## Assets and trust boundaries
- **GHCR classic token** (`ghp_...`): typed into the step 6 push block on the
  maintainer's host. Over-scoped (`repo`), it could push code and move the
  `v*` / `reader-v*` tags while it is alive.
- **Registry credentials in the push session**: buildx hands the client's
  registry auth to the BuildKit daemon that builds and pushes.
- **The BuildKit daemon image** (`moby/buildkit`): third-party code pulled
  from Docker Hub that runs in a privileged container and produces the
  published server and reader images.
- Boundaries: GitHub token form → maintainer host; Docker Hub → host's
  builder container; builder → GHCR / Docker Hub.

## Threats (STRIDE, brief)
| Threat | Who / how | Covered by |
|---|---|---|
| Elevation via over-scoped token | Maintainer follows "only `write:packages`", the form ticks `repo`; a host compromise during the window gets repo write | Scoped URL + scope check (M2 fix), short expiry, mandatory revoke |
| Tampering in the build path | A re-pushed or compromised `moby/buildkit` tag runs as the builder and alters the pushed image or steals the session's push auth | Digest pin (M3 fix), **but see M-1** |
| Stale builder | An existing `sync-release` builder from earlier keeps an unpinned BuildKit | `buildx rm` + `inspect` check in the plan |
| Ageing pin | The pinned BuildKit misses later security fixes | Bump note |

## Independent verification of the pin
`moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c`
re-checked on 2026-11-26, independently of the architect's run:
- `docker buildx imagetools inspect moby/buildkit:v0.35.1` (Docker 29.2.0):
  `MediaType: application/vnd.oci.image.index.v1+json`, `Digest:` equals
  the pin; platform manifests include `linux/arm64`
  `sha256:dcd3c9ec...cca26` (matches the plan) with `attestation-manifest`
  entries.
- Registry API (anonymous pull token, `HEAD /v2/moby/buildkit/manifests/v0.35.1`,
  OCI index accept): `docker-content-digest` equals the pin.
- Provenance (`--format '{{json .Provenance}}'`): built from
  `refs/tags/v0.35.1` of the moby/buildkit repo.

The digest is correct. Re-checking it before committing (as the plan says)
stays required.

## Findings
| # | Severity | Location | Issue / attack scenario | Fix |
|---|---|---|---|---|
| M-1 | Medium | architecture.md Approach 2 (step 6 create line + "verify" sentence), Risks bullet 1; RELEASING.md step 6 push block (`export DOCKER_CONFIG="$CFG"`, line ~549) and R4 (~844) | The push blocks set a **fresh temporary `DOCKER_CONFIG`**. buildx keeps its builder list and current builder under `$DOCKER_CONFIG/buildx` (unless `BUILDX_CONFIG` is set), so inside the push block the `sync-release` builder does not exist and the **default `docker` builder** (Docker's embedded BuildKit) does the push. Verified on this host: `DOCKER_CONFIG=<empty tmp> docker buildx ls` lists only `default*`. Result: the pin never reaches the credentialed push; the plan's `docker inspect ... buildx_buildkit_sync-release0` check passes and gives false assurance that "the image that performs the push" is pinned. And step 6's advice "create `sync-release` and repeat the block" cannot work: a maintainer whose default builder can't build two platforms gets the same failure again and may improvise around the temp-config control (e.g. log in with the real config, leaving the GHCR token in the credential store). The R3 create line *does* work (R3's check block uses the host config), but R3 builds without credentials. | Pick one at Gate 2 (C5): **(a, preferred)** make the push use the pinned builder: in both push blocks, before `export DOCKER_CONFIG="$CFG"`, export a persistent `BUILDX_CONFIG` derived from the host config (e.g. `BX="${BUILDX_CONFIG:-${DOCKER_CONFIG:-$HOME/.docker}/buildx}"`, `cygpath -m` on Git Bash, then `export BUILDX_CONFIG="$BX"`), pass `--builder sync-release` to the push `docker buildx build`, and print `docker buildx inspect sync-release` before the first login. Coordinate with #90, which edits the same blocks. **(b, docs-only)** keep the push block unchanged but say plainly that the push runs on Docker's embedded BuildKit (the default builder in the temporary config) and the `sync-release` pin covers only builds run with the host config (R3); replace step 6's "create and repeat" advice with something that works for the push (Docker Desktop: enable the containerd image store so the default builder can build multi-platform). Either way, the docs must not claim the pin protects the push unless (a) is done. |
| L-1 | Low | architecture.md Approach 1 (scope check is visual only) | The scope check is a look at the form before generating. A maintainer who misses it still ends up with a `repo` token; nothing machine-checks it. Mitigated by the scoped URL, short expiry and mandatory revoke. | Optional (fits #90, which touches the push block): after reading `T`, check `X-OAuth-Scopes` from `https://api.github.com/user` and refuse anything other than `write:packages, read:packages` (in any order). Pass the header via stdin (`curl -H @-`), never as an argument, so the token stays out of the process list. |
| L-2 | Low | architecture.md Approach 2 | `docker buildx create --use` leaves `sync-release` as the host's **current builder** after the release. Later unrelated builds keep running on a pinned BuildKit that ages. | After the release (step 8 / R6 or the end of step 6), `docker buildx use default`, or `docker buildx rm sync-release` (the bump note already rms it before the next release). |
| L-3 | Low | architecture.md Approach 3 (bump note) | The note covers how to bump, not when. A BuildKit CVE (there have been container-escape ones) would not trigger a bump. | Add one line: check the moby/buildkit security advisories (GitHub GHSA list) when starting each release, and bump in its own PR if the pinned version is affected. |

No finding on the M2 text itself: the planned wording (scoped URL, check
before generating, untick `repo`, only `write:packages` and
`read:packages`) matches R4 and the M2 fix. No finding on the rejected
`BUILDKIT_IMAGE=` variable: rejecting it is correct (an unset variable
would give `image=` and silently fall back to the unpinned default).

## Required controls (part of the plan)
- **C1 (M2)** Step 6 creates the classic token from
  `https://github.com/settings/tokens/new?scopes=write:packages`, and checks
  the scope list *before generating*: only `write:packages` and
  `read:packages`; if `repo` is ticked, untick it. Both appear before the
  push block. The existing `ghp_` prefix check, fine-grained warning,
  shortest expiry and mandatory revoke stay.
- **C2 (M3)** Every `docker buildx create` in `RELEASING.md` is exactly
  `docker buildx create --use --name sync-release --driver docker-container --driver-opt image=moby/buildkit:v0.35.1@sha256:baf6138eb8c37644800c7c913fba051e840ebb9ba13eaf92d92ef9a1712d0b4c`
  (tag **and** digest, one line, identical copies). No shell variable for
  the reference. Re-run `docker buildx imagetools inspect` before
  committing; stop (`BLOCKED`) if the digest differs.
- **C3** Stale builder: `docker buildx rm sync-release` when one exists,
  then `docker buildx inspect --bootstrap sync-release` and
  `docker inspect -f '{{.Config.Image}}' buildx_buildkit_sync-release0`
  must print the pinned reference.
- **C4** Bump note in "Before you start": release tag only (never `latest`,
  `buildx-stable-1`, `master`, `nightly`, rc); index digest with
  `attestation-manifest` entries; provenance from
  `moby/buildkit.git#refs/tags/<vX.Y.Z>`; replace every create line; record
  old/new digests in the PR; own reviewed PR.
- **C5 (M-1)** The docs state truthfully which builder performs the push.
  Either (a) the push blocks select the pinned `sync-release` builder
  (persistent `BUILDX_CONFIG` + `--builder sync-release`), or (b) the doc
  says the push uses Docker's embedded BuildKit and the pin covers only the
  host-config builds, and step 6's "create and repeat the block" advice is
  replaced by one that works with the temporary `DOCKER_CONFIG`. User
  decision at Gate 2; (a) touches the push blocks, so sequence it with #90.
- **C6** Tests as planned (scoped URL and scope check in step 6 before the
  push block; every create line pinned and identical; at least one in step
  6 and one in R3; every `moby/buildkit` occurrence pinned except the
  `<vX.Y.Z>` placeholder; `buildx rm` and `buildx_buildkit_sync-release0`
  in step 6; bump note with the same reference). Plus, for C5: with (a),
  both push blocks export `BUILDX_CONFIG` before `DOCKER_CONFIG` and pass
  `--builder sync-release`; with (b), step 6 no longer says to create
  `sync-release` and "repeat the block" for the push.

## What I will check in code mode
- C1-C6 in the diff, and the digest re-verified against the registry.
- No token value, `ghp_` example or real token in docs or tests; no `-x`.
- The push blocks still set the `trap` before the first login and still
  use a temporary `DOCKER_CONFIG`; if (a) is chosen, `BUILDX_CONFIG` never
  points into the temporary config and no credentials land in it.
- No change to `scripts/release/*` or `docs/roadmap.md`; reader section
  changes limited to the create line.
- gitleaks on the PR commits; semgrep on changed files; `npm audit`
  (high/critical).

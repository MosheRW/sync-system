# 0017. Server image build, tags and push

- Status: Accepted (Gate 2, 2026-11-23: user chose the recommended A1, B1,
  C1, D1)
- Date: 2026-11-23
- Issue: #37

## Context

AC52 and Q17: the sync server ships as a Docker image tagged with its semver
in two registries, `ghcr.io/mosherw/sync-system-server` (canonical) and
`docker.io/mosherw/sync-system-server` (mirror), with the same tags in both.
The image's `/health` `version` must equal the tag. Q-D: everything is pushed
by hand, credentials passed at run time only and never stored. AC54: the npm
part runs in a `node:24` container; building an image needs a Docker daemon.

Open here: where the image is built, which tags are pushed, which CPU
architectures, and how registry credentials are handled.

## Options

### A. Where the image is built

1. **On the maintainer's host with `docker buildx`, from a fresh
   `git clone --branch vX.Y.Z --depth 1` into a temporary directory.**
   Pros: the context is exactly the tag; no Docker socket inside the npm
   release container. Cons: two places (container for npm, host for the
   image), both documented step by step.
2. Inside the `node:24` release container with the host Docker socket
   mounted. Cons: the socket gives the container root on the host, and the
   npm session would share a container with it; needs the Docker CLI
   installed in the container.
3. `docker build <git-url>#vX.Y.Z` (remote git context). Pros: no clone.
   Cons: needs the repo public or a token in the URL; harder to dry-run
   before the repo is public.

### B. Tags

1. **`X.Y.Z`, `X.Y`, `X` and `latest`, the same four in both registries.**
   Pros: operators can pin exactly or follow a minor or major line; `latest`
   for quick starts. Cons: floating tags move on each release (documented:
   production should pin `X.Y.Z` or a digest).
2. `X.Y.Z` only. Cons: every patch needs a compose edit; operators fall
   behind on fixes.

### C. Architectures

1. **`linux/amd64` and `linux/arm64` in one multi-platform push**
   (`docker buildx build --platform linux/amd64,linux/arm64` with
   `-t <ghcr tags>`, `-t <docker.io tags>` and `--push`). Pros: runs on ARM servers and Apple
   Silicon; one build pushes identical manifests (same digest) to both
   registries. The server has no native modules, so QEMU emulation only
   slows the build. Cons: needs a buildx builder with the
   `docker-container` driver and QEMU
   (`docker run --privileged --rm tonistiigi/binfmt --install arm64`,
   pinned by digest in `RELEASING.md`).
2. `linux/amd64` only. Cons: ARM users must build from source.

### D. Credentials

1. **A temporary `DOCKER_CONFIG` directory per release**
   (`export DOCKER_CONFIG="$(mktemp -d)"`) and, **before the first login**,
   `trap 'docker logout ghcr.io || true; docker logout docker.io || true; rm -rf "$DOCKER_CONFIG"' EXIT`,
   all inside one subshell block so the trap
   fires when the block ends (security advisory L9). Then `docker login ghcr.io` with a GitHub classic
   token scoped `write:packages` only and `docker login docker.io` with a
   Docker Hub personal access token limited to the one repository if
   available (else "Read & Write"), each read with `read -rs T`, passed as
   `printf '%s' "$T" | docker login -u mosherw --password-stdin <registry>`
   and `unset` (never echoed, never a command-line argument). Both tokens
   get the shortest expiry and are **revoked after the release**.
   The `trap` matters on Docker Desktop: with an empty `DOCKER_CONFIG` the
   CLI still picks the platform credential helper, so the tokens land in the
   OS keychain and only `docker logout` removes them, also when the push
   fails (security plan review M2).
   After the block, the platform credential helper
   (`docker-credential-wincred list`, or `-desktop`/`-osxkeychain`) and
   `~/.docker/config.json`
   are checked for leftover `ghcr.io`/`index.docker.io` entries (L9).
   Pros: nothing remains in `~/.docker/config.json`, the keychain or shell
   history. Cons: two tokens to create and revoke per release.
2. Logging in to the default Docker config. Cons: credentials stay on disk
   (or in a credential helper) after the release.

## Decision

A1, B1, C1 and D1 (accepted at Gate 2, 2026-11-23). The clone is made
into a `mktemp -d` directory outside the working copy (L11), from the
host-created tag (ADR 0016
D1) and the release asserts `HEAD` equals the verified merge commit and a
clean tree before building. The Dockerfile gains static OCI labels
(`org.opencontainers.image.source=https://github.com/MosheRW/sync-system`,
`.licenses=GPL-3.0-only`, `.title`, `.description`) and copies the single
file `LICENSE` into `/app` in the runtime stage only (never a directory or
the context root; no credential `ARG`/`ENV`); the release command adds only
`.version` and `.revision` with `--label`. Before the push, the dry run builds `linux/amd64` with `--load`
and checks that `/health` returns the tag's version.

## Consequences

- The GHCR package is private on first push: the maintainer sets it public
  once and the `source` label links it to the repo.
- The Docker Hub repository `mosherw/sync-system-server` must exist (created
  by hand, public) before the first push.
- Floating tags (`X.Y`, `X`, `latest`) are documented as moving; the
  operator guide recommends pinning `X.Y.Z` (or a digest) in production.
- No image signing or SBOM attestation in 1.0.0 (no CI identity); noted as a
  known limit next to npm provenance.

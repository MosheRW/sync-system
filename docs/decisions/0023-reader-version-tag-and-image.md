# 0023. Reader version, git tag and image publishing

- Status: Proposed
- Date: 2026-11-25
- Issue: #77

## Context

The reading app `apps/reader` (`@mosherw/sync-system-reader`) was left out
of the 1.0.0 release (2026-11-24, tag `v1.0.0`). #77 publishes it as a
public Docker image, `ghcr.io/mosherw/sync-system-reader` (canonical) and
`docker.io/moshewin/sync-system-reader` (mirror), by hand, because GitHub
Actions is blocked (ADR 0018).

Gate 1 of #77 decided: the reader gets its **own** version, first public
release `1.0.0`, outside the Changesets fixed group (ADR 0016), released on
its own, not with the next package/server release. It must never be
published to npm. The image is not released until #27 and #28 are closed.

Constraints from the code as it is:

- `apps/reader/package.json` is `private: true` at `0.1.0`; `pack:check`
  (`scripts/release/lib.ts` `PRIVATE_DIRS`) and
  `apps/sync-server/test/release-files.test.ts` require `private: true`.
- `.changeset/config.json` lists the reader in `ignore`, and a test pins
  that list.
- The reader already has its version as a constant,
  `apps/reader/src/config/version.ts` `READER_VERSION`, used as the sync
  client's default `appVersion`; a test keeps it equal to `package.json`.
- The reader's `/health` answers `ok\n` (text) today, with no version. The
  spec requires `/health` to report a version equal to the image tag.
- `v1.0.0` already exists; ADR 0016 D1 reserves `vX.Y.Z` for the fixed
  group, and `RELEASING.md` step 1 matches `v$V`.

Open here: the reader's git tag name (A), how its version is set (B), the
`/health` body (C), and the image build, tags and credentials (D).

## Options

### A. Git tag name

1. **`reader-vX.Y.Z`** (first: `reader-v1.0.0`). Pros: never collides
   with `vX.Y.Z` and does not match `v*` globs (step 1's `v$V`,
   `git describe --match 'v*'`); readable in GitHub release URLs; a plain
   ref name, no `/` or `@`. Cons: a project-specific prefix to document.
2. `reader/vX.Y.Z` (Go-module style). Pros: groups under `refs/tags/reader/`.
   Cons: the `/` must be URL-encoded in some GitHub links and confuses tools
   that treat the tag as a path; no real gain over A1.
3. `@mosherw/sync-system-reader@X.Y.Z` (Changesets style). Cons: ADR 0016
   rejected per-package tags; `@` and `/` need quoting in shell and URLs;
   suggests an npm package that does not exist.

### B. Version source and bump

1. **Hand bump in a reviewed PR; the reader stays `private: true` and in
   the Changesets `ignore` list.** A reader release bumps
   `apps/reader/package.json` `version`, `READER_VERSION` and a hand-written
   `apps/reader/CHANGELOG.md` together (the existing test keeps the first
   two equal). The first bump, to `1.0.0`, is made in #77, so `main` says
   what will be tagged once the blockers close. Pros: no change to the
   accepted Changesets config or its tests; `private: true` keeps npm out
   (pnpm and Changesets never publish a private package, `pack:check`
   enforces it). Cons: the reader's changelog is maintained by hand; between
   the #77 merge and the tag, `main` already says `1.0.0` (the same as the
   server between a release PR merge and its tag).
2. Take the reader out of `ignore` and let `pnpm changeset version` bump it
   as its own non-fixed private package (`privatePackages.version: true`
   already allows it). Pros: generated changelog. Cons: changes an accepted
   ADR 0016 setting and its tests; every reader PR then needs a changeset;
   a release PR for the packages would also bump the reader whenever a
   reader changeset is pending, which ties the two releases together
   (Gate 1 said standalone).
3. As B1, but keep `0.1.0` in #77 and bump in a later reader release PR,
   after #27 and #28. Pros: `main` never says `1.0.0` before it is ready.
   Cons: one more PR; the #77 acceptance criterion (package.json, Changesets
   config and docs agree on `1.0.0`) is not met in #77.

### C. `/health` body

1. **JSON `{"status":"ok","version":"<READER_VERSION>"}`**,
   `Content-Type: application/json`, built once at startup, same status,
   headers and `Cache-Control: no-store` as today. Pros: the same shape as
   the server's `/health` (`status`, `version`); the release check is the
   same `grep '"version":"X.Y.Z"'`; the HEALTHCHECK only reads `r.ok`, so
   it is unchanged. Cons: a changed body (the reader was never released, so
   no published contract breaks); the exact version is visible to anyone who
   reaches the reader, which is public by nature (see Consequences).
2. Text `ok <version>`. Pros: smallest change. Cons: a second, ad-hoc
   format next to the server's JSON; harder to extend.
3. Keep `ok` and check the version from `/app/package.json` in the image.
   Cons: does not meet the spec (`/health` must report the version); the
   running container cannot be traced from outside.

### D. Image build, tags, platforms and credentials

1. **The same as ADR 0017 (A1, B1, C1, D1) with the reader's names:**
   built on the maintainer's host with `docker buildx` from a fresh
   `git clone --branch reader-vX.Y.Z --depth 1` into a `mktemp -d`
   directory, `HEAD` and a clean tree checked against the tagged commit;
   tags `X.Y.Z`, `X.Y`, `X` and `latest`, the same four in both
   registries; `linux/amd64` and `linux/arm64` in one push; a temporary
   `DOCKER_CONFIG` with the `trap` logout set before the first login,
   tokens read with `read -rs` and `--password-stdin` (GHCR classic PAT
   with only `write:packages`, Docker Hub PAT "Read & Write"), revoked
   after the release. The Dockerfile gets the same static OCI labels and
   `LICENSE` file as the server's; the release adds only `.version` and
   `.revision` with `--label`. Pros: one procedure shape for both images,
   already security-reviewed (#37, #65). Cons: two more tokens per reader
   release (the reader is released on its own).
2. `X.Y.Z` only. Cons: operators cannot follow a minor line; different from
   the server.

### E. Release gate (#27, #28)

The reader tag block refuses to tag unless every listed blocker issue is
`CLOSED` (`gh issue view <n> --json state`), with `27 28` listed for
`1.0.0`. This is not an option set: Gate 1 decided it; it is recorded here so
the procedure can point to it.

## Decision

Recommended: **A1, B1, C1, D1** (and E as decided at Gate 1).

- A1 because it cannot collide with `vX.Y.Z`, is safe in shell and URLs,
  and the server's step 1 regex never matches it.
- B1 because it keeps ADR 0016's accepted config, keeps npm out by
  construction, keeps the reader release standalone, and meets the #77
  acceptance criteria in this PR.
- C1 because it matches the server's `/health` shape and makes the
  release check identical.
- D1 because it reuses a reviewed procedure.

## Consequences

- `RELEASING.md` gets a self-contained "Reader image release" section with
  its own variables (`RV`, `RM`), tag block, image check and push blocks,
  and a reader dry run; the package/server steps are unchanged.
- The reader's GitHub release is created with `--latest=false`, so the
  packages' release stays "Latest".
- The Docker Hub repository `moshewin/sync-system-reader` must exist
  (created by hand, public) before the first push; the GHCR package is
  private on first push and the maintainer sets it public once.
- `/health` shows the reader's exact version. The version is public anyway
  (image tags, source); operators who don't want it served can deny
  `/health` at the proxy except from monitoring. Documented in the reader
  README.
- `READER_SYNC_APP_VERSION`'s default (the reader's own version) becomes
  `1.0.0`; `/health` always reports the build's version, never the
  override.
- What counts as breaking for the reader (env variables, the image contract:
  port 8080, the `node` user, `/health`, URLs) is written in
  `docs/versioning.md`.
- No image signing or SBOM, as for the server (no CI identity).

# Spec: #77 feat(release): publish the reader as a public docker image

Issue: https://github.com/MosheRW/sync-system/issues/77

## Problem / motivation
The reading app `apps/reader` (`@mosherw/sync-system-reader`, `private: true`, version `0.1.0`, outside the Changesets fixed group) has an `apps/reader/Dockerfile` with a `/health` HEALTHCHECK, but no public image. 1.0.0 (protocol, client, react and the server image) was released by hand on 2026-11-24 and the reader was deliberately left out. Operators who run the sync server cannot run the reference reader the same way. This issue publishes the reader as a public Docker image like the server: canonical `ghcr.io/mosherw/sync-system-reader`, mirror `docker.io/moshewin/sync-system-reader`. GitHub Actions is billing-blocked (ADR 0018), so the release stays manual, done by the maintainer.

## User stories
- As an operator, I want to `docker pull` a public reader image from GHCR or Docker Hub, so that I can host the reader next to my sync server without building it.
- As an operator, I want clear docs on the image's configuration, so that I can point it at my sync server and know nothing secret lives in the image.
- As the maintainer, I want a documented, repeatable manual procedure for the reader image (same safety as the server image), so that the release is verifiable and I never push an unchecked build.
- As a consumer, I want the image tag and `/health` version to match the released version, so that I can trace the image to the source commit.

## Acceptance criteria
- [ ] `RELEASING.md` documents the reader image release (build from a fresh clone of the tag, clean-tree and commit check, `/health` check on the built image, multi-platform buildx push of the same tags to both registries, temporary `DOCKER_CONFIG`, classic GHCR PAT with `write:packages`), consistent with step 6 / ADR 0017 for the server. Edits are limited to a reader section so as not to conflict with parallel edits.
- [ ] The reader image build is verified: from a fresh clone, `docker buildx build` of `apps/reader/Dockerfile` succeeds for linux/amd64 and linux/arm64 (same platforms as the server), the container runs as non-root, and `GET /health` returns 200 with a `version` equal to the release version (check scripted in the procedure).
- [ ] The reader image carries the same static OCI labels (`org.opencontainers.image.source`, etc.) in `apps/reader/Dockerfile` as the server image, plus `version` and `revision` labels passed at build time; the server Dockerfile's labels are the reference (currently the reader has none). Inapplicable only if the architect shows the server Dockerfile has none.
- [ ] The reader has its own independent version, first public release `1.0.0`, outside the Changesets fixed group. `apps/reader/package.json`, the Changesets config and `docs/versioning.md` agree, and the version the reader reports on `/health` equals the image tag.
- [ ] The reader's git tag name does not collide with the existing `v1.0.0` tag (the architect decides the name, e.g. `reader-v1.0.0`, via ADR), and `RELEASING.md` and `docs/versioning.md` use it.
- [ ] The release procedure and checklist state that the reader image is not released until both #27 (Hebrew header bidi, PR #73) and #28 (native-speaker review of Hebrew strings) are closed. This issue's PR does not fix them; they stay their own issues. The docs, Dockerfile and procedure work proceeds now.
- [ ] `apps/reader/README.md` (and a pointer from `docs/operator-guide.md`) documents running the public image: `docker run` example with both registries, every env variable, how to point it at a sync server, the exposed port and `/health`, and states that no secret belongs in or is baked into the image.
- [ ] The operator docs state that the reader API key is public by design (security finding M1) and recommend per-IP rate limits at the proxy. `?src` remote content fetching is documented with the ADR 0006 risk, is off by default, and is marked to be kept off on public deployments.
- [ ] The image keeps `/health` only (no `/ready`, Q25 from #36 stands); the HEALTHCHECK and the release check both use `/health`, and the docs say so.
- [ ] Any ADR needed (reader version scheme and git tag name, image publishing for the reader) is added under `docs/decisions/` and accepted at Gate 2.
- [ ] The release checklist has a reader line: pull-by-tag from both registries works anonymously (verified after the maintainer's push), and the GHCR package is set public.
- [ ] `docs/roadmap.md` records this issue (decided after checking the roadmap convention; it is updated on merge, and the parallel session is also editing it, so only this issue's own line is added).
- [ ] No image is pushed, no tag created, and nothing is published by this issue's agents; the maintainer performs the push by hand. The PR body says so.
- [ ] Repo checks (lint, typecheck, tests, build, docs checks) pass.

## Out of scope
- Publishing or pushing images, tagging, or running the release (maintainer, manual).
- Re-enabling CI/Actions or automated image publishing (ADR 0018).
- Image signing, SBOM or provenance attestation (as for the server in 1.0.0).
- Fixing reader bugs #27 and #28. They block the reader image release (see acceptance criteria) but stay their own issues.
- Adding a `/ready` endpoint to the reader.
- Tying the reader release to the next server/package release (it is standalone).
- Changes to reader features, content, or the sync protocol.
- Re-releasing 1.0.0 packages or the server image.

## Decisions (Gate 1, 2026-11-25)
- **Version scheme and timing (Q1, Q3).** The reader gets its own independent version, first public release `1.0.0`, outside the Changesets fixed group. It is a standalone reader release, not tied to the next server/package release. The git tag name must not collide with `v1.0.0`; the architect decides it via ADR (e.g. `reader-v1.0.0`).
- **Blockers (Q2).** The reader image is blocked on both #27 (PR #73) and #28. The docs, Dockerfile and procedure work in this issue proceeds now; the release procedure and checklist state that the image is not released until both are closed. This PR does not fix them.
- **Runtime docs (Q4).** Document that the reader API key is public by design (M1) and recommend per-IP proxy limits. Document `?src` with the ADR 0006 risk and mark it to be kept off on public deployments. Also cover env vars, pointing at a sync server, and that no secret is in the image.
- **Readiness (Q5).** Keep `/health` only (Q25 from #36 stands). HEALTHCHECK and release check use `/health`.

## Open questions
None.

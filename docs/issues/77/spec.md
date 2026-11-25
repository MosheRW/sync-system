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
- [ ] If the server image does, the reader image carries the same static OCI labels (`org.opencontainers.image.source`, etc.) in `apps/reader/Dockerfile`, plus `version` and `revision` labels passed at build time; the server Dockerfile's labels are the reference (currently the reader has none).
- [ ] The reader version scheme from the Gate 1 decision (Q1) is applied: `apps/reader/package.json`, Changesets config, and `docs/versioning.md` agree, and the version the reader reports on `/health` equals the image tag.
- [ ] `apps/reader/README.md` (and a pointer from `docs/operator-guide.md`) documents running the public image: `docker run` example with both registries, every env variable, how to point it at a sync server, the exposed port and `/health`, and states that no secret belongs in or is baked into the image (Q4).
- [ ] The docs state that the reader API key is public by design (security finding M1) and that `?src` remote content fetching is off by default (ADR 0006), with how to enable it and the risk.
- [ ] The release docs state the image's readiness behavior per the Q5 decision (`/health` only, or a `/ready` added with tests).
- [ ] Any ADR needed (version scheme, image publishing for the reader) is added under `docs/decisions/` and accepted at Gate 2.
- [ ] The release checklist has a reader line: pull-by-tag from both registries works anonymously (verified after the maintainer's push), and the GHCR package is set public.
- [ ] `docs/roadmap.md` records this issue (decided after checking the roadmap convention; it is updated on merge, and the parallel session is also editing it, so only this issue's own line is added).
- [ ] No image is pushed, no tag created, and nothing is published by this issue's agents; the maintainer performs the push by hand. The PR body says so.
- [ ] Repo checks (lint, typecheck, tests, build, docs checks) pass.

## Out of scope
- Publishing or pushing images, tagging, or running the release (maintainer, manual).
- Re-enabling CI/Actions or automated image publishing (ADR 0018).
- Image signing, SBOM or provenance attestation (as for the server in 1.0.0).
- Fixing reader bugs #27 and #28 (unless Gate 1 Q2 makes them blockers, then they stay their own issues).
- Changes to reader features, content, or the sync protocol.
- Re-releasing 1.0.0 packages or the server image.

## Open questions (for Gate 1; PM does not decide)
1. **Reader version scheme.**
   a) Join the Changesets fixed group at the next server version (one version everywhere, consistent with Q-F in #37; reader jumps from 0.1.0).
   b) Independent version, first release 1.0.0 (own cadence, stable-API signal).
   c) Independent version, first release 0.x (signals the reader is still maturing, e.g. Hebrew strings unreviewed).
   Recommendation: (a) at the next release if shipping together (Q3a), else (b) 1.0.0 independent. Fewer moving parts, and tag/`/health` match the other artifacts.
2. **Must open reader bugs be fixed first?** #27 (Hebrew header bidi, PR #73 open) and #28 (native-speaker review of Hebrew strings) are open; #44 is already closed (PR #70).
   a) Block on neither; document them as known limits.
   b) Block on #27 (PR #73 merged), ship with #28 as a known limit.
   c) Block on both.
   Recommendation: (b). #27 is a visible defect and its fix is in review; #28 needs an external reviewer and would delay indefinitely.
3. **Release timing.**
   a) Ship with the next regular release (all artifacts together, one release run).
   b) Standalone reader release now.
   Recommendation: (b) if Q1 is independent (nothing to wait for), (a) if the reader joins the fixed group.
4. **Runtime configuration docs.** The operator docs must cover env vars, pointing at a sync server, no secrets in the image, public API key (M1), `?src` off by default (ADR 0006). Open points: should the docs also recommend per-IP proxy limits and a separate registration for the reader key (M1 follow-up, `docs/issues/24/`), and should enabling `?src` be documented or discouraged for public deployments?
   Recommendation: document the key as public and recommend proxy limits; document `?src` with the ADR 0006 risk but mark it off for public deployments.
5. **Readiness.** The reader has `/health` but no `/ready` (Q25 in #36).
   a) Keep `/health` only (it serves static files and holds no state; nothing to be unready for).
   b) Add `/ready`.
   Recommendation: (a), keeping Q25; the image HEALTHCHECK and the release check both use `/health`.

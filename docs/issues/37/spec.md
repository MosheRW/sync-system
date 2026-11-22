# Spec: #37 feat: public docs, changelog and first semver release (PRD item 9c)

Issue: https://github.com/MosheRW/sync-system/issues/37
Branch: `feat/37-docs-changelog-release`
Path: full. Part of #35 (PRD item 9). Source spec: `docs/issues/35/spec.md` (section "9c", AC43-AC56, and its Gate 1 decisions of 2026-11-12). Numbering is kept so other documents' AC references stay valid.

## Problem / motivation

The server, protocol, client and React packages work (items 1-9b), but nothing is releasable. There are no public docs beyond the READMEs, and there is no `LICENSE`, no changelog, no versioning policy and no release process. Every package is `private: true` at `0.1.0` under the placeholder scope `@sync-system/*`, and the repo is private. 9c turns the project into something an app developer can install, depend on and upgrade, and that the maintainer can release from their own machine.

UI impact: none. This item is Markdown, package metadata, tooling and CI. No reader UI changes, so there is no designer phase (confirm at Gate 1).

## Current state (checked on `origin/main` 0d1dba3)

| Area          | State                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages      | `@sync-system/protocol`, `/client`, `/react` at 0.1.0, all `private: true`, no `license`, `repository`, `publishConfig`; `files: ["dist"]`. `@sync-system/server` and `@sync-system/reader` are `private: true`, 0.1.0. Root `sync-system` is private.                                                                                                                                       |
| Rename cost   | The scope `@sync-system/` appears in about 214 files outside `docs/issues` (imports, workspace deps, the `@sync-system/source` custom export condition in `tsconfig.base.json` and every package, Dockerfiles, READMEs). The rename to `@mosherw/sync-system-<name>` is a real chunk of work for the architect, not a metadata edit. The server and reader names are not fixed by Q4/Q16 (Q-C). |
| Files missing | No `LICENSE`, no `CHANGELOG`, no `.changeset/`, no `RELEASING.md`, no release scripts in the root `package.json` (only lint, typecheck, test, build, format, audit).                                                                                                                                                                                                                          |
| READMEs       | Root `README.md` (964 lines: server, env reference, Redis, several instances, joining, upgrading, protocol in brief, deployment security, reading app), `packages/client/README.md` (711), `packages/react/README.md` (444), `apps/reader/README.md` (582). `packages/protocol` has no README.                                                                                               |
| Docs dir      | `docs/conventions.md`, `docs/decisions/0001-0015`, `docs/startup-errors.md`, `docs/roadmap.md`, the PRD. No operator guide, protocol reference or integration guide as standalone docs.                                                                                                                                                                                                      |
| Dockerfiles   | `apps/sync-server/Dockerfile` (node:24-alpine pinned by digest, `pnpm deploy --prod`, non-root, `package.json` next to `dist/`) and `apps/reader/Dockerfile`. No version tagging or push logic.                                                                                                                                                                                              |
| Compose       | `compose.yaml`, `compose.redis.yaml`, `compose.multi.yaml`.                                                                                                                                                                                                                                                                                                                                  |
| CI            | `.github/workflows/ci.yml` (one `check` job, SHA-pinned actions). Actions is blocked by billing, so CI runs locally in Docker (AC56).                                                                                                                                                                                                                                                        |
| Repo          | `MosheRW/sync-system`, currently PRIVATE.                                                                                                                                                                                                                                                                                                                                                    |

## Already delivered by 9a and 9b (9c must not redo it)

- `docs/startup-errors.md`: the list of every startup error the server and the reader print, with the fix for each, checked in both directions by tests. This was AC40, moved from 9c to 9b (#36). 9c links to it from the operator guide.
- README sections added by 9a and 9b: Health and readiness (`/health`, `GET /ready`), Storage (Redis), Several instances, Upgrading (including the 9b "unknown look-alike variables stop startup" note and the 9a "stop every instance" upgrade note), Deployment security, and an environment-variable reference.
- ADR 0015 (unknown environment variables fail startup).
- Server `/health` already returns `version` (read from `package.json` at runtime) and `storage`.

9c reorganises and completes these into the public docs (links, one operator guide) and adds a test that keeps the env reference equal to the code (AC45). It does not re-derive the startup-error list.

## Dependencies and blockers

Decided at Gate 1 of #35 (Q15): #32, #12 and #21 are fixed as their own issues before 9c. State on 2026-11-18, all three are still OPEN:

| Issue | Title                                                                       | State |
| ----- | --------------------------------------------------------------------------- | ----- |
| #32   | fix(server): offer take-back only after a handoff loss (follow-up to #25)   | OPEN  |
| #12   | fix(server): limit group creation and live groups per app (follow-up to #10) | OPEN  |
| #21   | fix(reader): enforce trusted types in the csp (follow-up to #19)            | OPEN  |

These block 9c: they change behaviour the docs and the 1.0.0 changelog must describe (the take-back rule, new per-app limits and their env variables, the reader CSP). Decided at Gate 1 (Q-A): fix them first; 9c is paused until all three are merged. Not blockers: #9, #27, #28, #41, #42, #44 (Q15). #41 (join-attempt limits shared across instances) and #42 (just-started instance as successor) are known limits of 1.0.0, and the docs must state them if still open at release.

## User stories

- As an **app developer**, I want public docs for the server, the protocol and the packages, with the reading app as a working example, so that I can integrate without reading the source.
- As an **app developer**, I want installable versioned packages with a changelog, so that I can depend on them and upgrade safely.
- As an **operator**, I want one guide for installing, configuring, scaling and securing the server, and a server image tagged with its version, so that I can run it in production.
- As the **maintainer**, I want a written release process that runs on my machine in Docker, so that I can release without GitHub Actions.

## Acceptance criteria

Docs

- [ ] AC43. Public docs in Markdown in the repo cover:
  - an operator guide: install with Docker Compose, the apps config file, every env variable, Redis, several instances, health and readiness, upgrading, deployment security (linking `docs/startup-errors.md` rather than copying it)
  - the wire protocol v1 reference
  - the client API and the React API
  - an integration guide that walks through the reading app as the worked example
  - Every relative link in these docs and in the READMEs resolves (a check fails on a broken link).
- AC44. Withdrawn (2026-11-12, Q19): no GitHub wiki for now. The numbering is kept so other documents' AC references stay valid. The repo Markdown is the only docs location; a wiki may be reconsidered later.
- [ ] AC45. The env reference lists every server env variable with its default, minimum and maximum. A test fails if a variable in the code is missing from the reference or its values differ. (The reader's variables are listed too; the test covers the server, and the reader if the code makes it cheap.)
- [ ] AC46. The PRD open question on default values and env ceilings is answered by the documented v1 defaults and ceilings. The phone-lock question is closed with the #24 Gate 2 answer (a 30 s lock works when `disconnectGraceSeconds` is 45 or more). The PRD and `docs/roadmap.md` record both (Q14).

Versioning and changelog

- [ ] AC47. A written versioning policy:
  - semver per published package
  - what counts as breaking for the protocol, the client API, the React API, and the server's config and env
  - how `PROTOCOL_VERSION` and `MIN_CLIENT_PROTOCOL_VERSION` move
  - which package versions work with which server
- [ ] AC48. The first release is 1.0.0 for the three packages and the server, all sharing one version number (Q-F), and ships protocol version 1 with minimum 1 (no bump, since nothing was released before; Q7). The changelog states this. The reader stays private, outside the version group; the private server and reader packages are renamed `@mosherw/sync-system-server` and `@mosherw/sync-system-reader` (Q-C).
- [ ] AC49. A changelog made with Changesets (Q6), with the protocol, client and React packages in one fixed version group. The first entry summarises v1 and includes notes for anyone who ran pre-release builds: the removal of join by group ID (#10), token format 2 (#13) and the `MAX_BUFFERED_BYTES` minimum. It also says that storage can now be Redis, that upgrading from the 9a PR 1 build means stopping every instance, and that unknown look-alike env variables now stop startup (#36).

Packages, license and release

- [ ] AC50. The protocol, client and React packages are published under the `@mosherw` npm scope (three packages: `@mosherw/sync-system-protocol`, `@mosherw/sync-system-client` and `@mosherw/sync-system-react`; Q16 decided 2026-11-12). They are no longer `private`, and carry the license, repository and public-access fields. Their published contents are only the build output, README, changelog and license (a check runs `pnpm pack` and lists the tarball contents). The workspace, including the private server and reader packages, is renamed consistently to the `@mosherw` scope (imports, workspace dependencies, the custom export condition, Dockerfiles, docs), and install, lint, typecheck, test and build still pass. Each published package has its own README (the protocol package gets one).
- [ ] AC51. A smoke test installs the packed tarballs into a clean temporary project, then imports each package (ESM), type-checks against its types, and renders the React provider on the server (SSR safety, #15).
- [ ] AC52. The server ships as a Docker image tagged with its semver, in both registries (Q17): `ghcr.io/mosherw/sync-system-server` (canonical) and `docker.io/mosherw/sync-system-server` (mirror), with the same tags pushed to both. The docs list both. The reader and the server stay `private` on npm. The image's `/health` `version` equals the tag.
- [ ] AC53. The license is GPL-3.0 with SPDX identifier `GPL-3.0-only` (Q3):
  - The full text is in a root `LICENSE` file and in each published package.
  - Every `package.json` has `"license": "GPL-3.0-only"`.
  - The docs state that the GPL also covers the client and React packages. An app that bundles them and ships that bundle (including browser bundles) is bound by the GPL's terms.
- [ ] AC54. A release process document (for example `RELEASING.md`) gives the steps to release from a clean clone inside a `node:24` Docker container, without GitHub Actions: checks, version bump, changelog, tag, `pnpm publish`, image push to both registries (with both credentials passed at run time only, never stored), and GitHub release notes. A dry run of those steps (no publish, no push) succeeds, and QA runs it. The publish path (Q-D): the maintainer publishes by hand from the release container, `pnpm publish --access public` without provenance, `docker push` to both registries, and a hand-created GitHub release. The document states the missing provenance as a known limit and how to adopt an Actions workflow later.
- [ ] AC55. Agents never publish packages, push images or create releases. The plan ends at a release candidate on the branch, and the human runs or approves each outward step after the merge.
- [ ] AC56. CI as in AC31, with the pack and smoke checks added to `ci.yml`. GitHub Actions is blocked by billing, so QA runs the `ci.yml` jobs locally in Docker as for #31, #35 and #36: `node:24`, a pinned `redis:7.2.17-alpine` container on the same Docker network, no bind mounts, from a fresh clone (git bundle), Test before Build, with the Redis-backed tests not silently skipped.

## Out of scope

- Any reader UI change (no designer phase).
- A hosted offering, self-service app registration, a docs-site generator, and a GitHub wiki (Q13, Q19).
- Persisting anything beyond a group's life (PRD), session history, analytics.
- Redis Cluster or Sentinel topologies: a single Redis endpoint only (Q5).
- Global connection or rate limits across instances (Q12; #41).
- GitHub Actions release automation and npm provenance (Actions is blocked, provenance needs CI OIDC), (Q-D decided: everything by hand, the limit is documented).
- Re-doing `docs/startup-errors.md` or the 9a/9b README sections.
- The parked follow-ups #9, #27, #28, #41, #42, #44 (Q15). #32, #12 and #21 are prerequisites, not part of this item.
- Re-licensing to MIT, a contributor agreement.
- A GitHub organization, splitting the monorepo into submodules or separate repos (Q18).

## Gate 1 decisions (2026-11-22)

- Q-A. Fix #32, #12 and #21 first, each as its own fast-path issue, then start 9c architecture. 9c stays paused (Phase: grooming) until all three are merged.
- Q17. The server image is published to both registries: GitHub Container Registry (`ghcr.io/mosherw/sync-system-server`, canonical) and Docker Hub (`docker.io/mosherw/sync-system-server`, mirror). The same tags are pushed to both on every release. The docs list both. The release procedure covers both pushes and both credentials, passed at run time only and never stored.
- Q18. The repo becomes public at the first release (a human action after merge). It stays a monorepo (no submodules, no separate repos). The owner stays MosheRW and the npm scope stays `@mosherw` (no GitHub organization for now).
- Q-C. The private workspace packages are renamed `@mosherw/sync-system-server` and `@mosherw/sync-system-reader`. No `@sync-system/` scope remains.
- Q-D. Everything is released by hand. The maintainer publishes from the release Docker container with tokens passed at run time, `pnpm publish --access public` without provenance, `docker push` to both registries, and a hand-created GitHub release. The release document states the missing provenance as a known limit and how to adopt an Actions workflow later. The human-only rule (AC55) applies.
- Q-F. The server and the three packages share one version number.
- Q-G. Docs layout: `docs/operator-guide.md`, `docs/protocol.md`, `docs/integration-guide.md`. The client API and the React API stay in the package READMEs. The root README is trimmed to an overview that links to them.

## Open questions

- Q-E. Package `repository`, `homepage` and `bugs` URLs, and npm 2FA. Deferred to Gate 2 (the user said it is too early); the architect proposes it. It follows from Q18: the repo stays `MosheRW/sync-system` unless changed. Recommended: `https://github.com/MosheRW/sync-system` with a per-package `directory`, publishing with 2FA on writes.

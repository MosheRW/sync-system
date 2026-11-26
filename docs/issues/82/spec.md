# Spec: #82 fix(release): narrow the ghcr token scope and pin buildkit in the server image step

Issue: https://github.com/MosheRW/sync-system/issues/82
Path: fast | Security-sensitive: yes

## Problem
Findings M2 and M3 in `docs/issues/77/security.md`. The sequencing note is satisfied: #77 (PR #79) and the releasing-fixes PR #84 are merged.

- M2 (medium): `RELEASING.md` step 6 (server image, ~lines 510-575) tells the maintainer to create a classic GHCR token with only `write:packages`. It has no scoped token URL and no scope check, so GitHub's form can auto-tick `repo`. The reader section (~lines 800-850) already has both.
- M3 (medium, advisory): every `docker buildx create` (server step 6 and the reader section) runs an unpinned `moby/buildkit` image that performs the push.

## Acceptance criteria
- [ ] `RELEASING.md` step 6 links `https://github.com/settings/tokens/new?scopes=write:packages` for creating the token.
- [ ] Step 6 includes a step to verify the token's scopes before use (only `write:packages` and implied `read:packages`; untick `repo`), matching the reader section.
- [ ] Every `docker buildx create` in `RELEASING.md` (server step and reader section) pins buildkit by digest: `--driver-opt image=moby/buildkit:<ver>@sha256:...`.
- [ ] `RELEASING.md` has a short note on how to bump the pinned buildkit digest.
- [ ] The release-files tests assert both the scoped token URL and the digest pin in every `buildx create`.

## Out of scope
- REL/IMG guards in steps 6 and 8 (issue #90, runs after this one).
- `scripts/release` dry-run (#92).
- `docs/roadmap.md`.
- Changes to the reader section beyond the buildkit pin.

## Open questions
- None.

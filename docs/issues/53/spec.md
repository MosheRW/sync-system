# Spec: chore(release): investigate react tarball hash differences across node:24 images

Issue: https://github.com/MosheRW/sync-system/issues/53 (follow-up to #37 / PR #50; source QA A3)

Path: fast

## Problem
The react package tarball sha512 differs between builds of the same commit on
different `node:24` images (unpinned tag versus pinned digest). The protocol
and client tarballs are identical. Not blocking, because the release compares
hashes within one build.

## Acceptance criteria
- [ ] The cause of the react tarball difference is identified and written down.
- [ ] Either the build is made reproducible across the two images, or the limit is documented in `RELEASING.md`.
- [ ] If the base image is pinned, the pin and its update procedure are documented.

## Out of scope
- Provenance or signing (security advisory L7).

## Notes for the architect
This is an investigation first: the cause must be found before choosing a fix.
Likely suspects: differing npm/pnpm/corepack versions, file mtimes or modes,
tar/gzip implementation, or something react-specific in the pack step. The user
may need to choose between making the build reproducible across images and
documenting the limit (and pinning the base image).

## Open questions
- Reproducible build versus documented limit (and base-image pin): to be decided after the cause is known.

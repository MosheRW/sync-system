Issue: https://github.com/MosheRW/sync-system/issues/65

## Problem
Found during the RELEASING.md step 0 first-release checklist before 1.0.0:
1. The Docker Hub namespace is wrong. The real repo is `moshewin/sync-system-server`, but docs reference `docker.io/mosherw/sync-system-server`.
2. RELEASING.md step 0 says `npm whoami` prints `mosherw`. The npm user is actually `moshe-winberg`, owner of the npm org `mosherw` (which owns the `@mosherw` scope).
3. `gitleaks git --redact` over full history (zricethezav/gitleaks:v8.24.0, 727 commits) reports 16 `generic-api-key` false positives: 15 test fixture constants in apps/sync-server/test/* and packages/client/test/*, and `TOKEN_HEADER_SEGMENT` in apps/sync-server/src/tokens/jwt.ts:10 (public base64 of the JWT header). Step 0 requires a clean scan.

## Acceptance criteria
- [ ] No Docker Hub reference to `mosherw` remains (all `docker.io/mosherw/...` become `docker.io/moshewin/sync-system-server`), except historical records under docs/issues/ (architect decides whether to touch those; default leave).
- [ ] Known files updated: README.md, RELEASING.md, SECURITY.md, docs/operator-guide.md, docs/conventions.md, docs/decisions/0017-server-image-publishing.md, docs/roadmap.md, CHANGELOGs of apps/sync-server, packages/client, packages/protocol, packages/react.
- [ ] GHCR (`ghcr.io/mosherw/sync-system-server`) and npm (`@mosherw/...`) references are unchanged.
- [ ] ADR 0017 gets an amendment note (not a rewrite).
- [ ] RELEASING.md step 0 npm wording is corrected (`npm whoami` prints your user; `npm org ls mosherw` shows you as owner); similar wording elsewhere fixed.
- [ ] A committed `.gitleaksignore` lists the 16 fingerprints; the scan over full history with the pinned image reports no leaks.
- [ ] RELEASING.md step 0 documents the exact scan command with the pinned image (v8.24.0).
- [ ] Existing tests/checks that cover release files still pass.

## Out of scope
- Changing the npm scope, GHCR namespace, or GitHub account.
- Rewriting historical docs/issues records (unless the architect decides otherwise).
- Changing code behavior (jwt.ts and tests are not edited to dodge the scanner).

## Open questions
- None blocking. Architect decides on historical docs/issues/35 and /37, and obtains fingerprints by running the scan.

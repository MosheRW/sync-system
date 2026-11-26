# Spec: #9 fix(client): harden forgetAllGroups cut-off against clock skew

Issue: https://github.com/MosheRW/sync-system/issues/9 (follow-up to #7, advisory L-e from PR #8)
Path: fast

## Problem
In `packages/client/src/token-store.ts` (around line 365), when `forgetAllGroups()` can neither delete nor read storage, the store keeps a cut-off taken from the device clock (seconds) and compares it with each token's server-issued `iat`.

- If the device clock is behind the server, a token stored by another tab up to that many seconds before the doubly failed call survives the forget.
- If the clock jumps backward, a second doubly failed call overwrites the cut-off with a lower value.

Severity is low: needs broken storage plus clock skew, local device only, and the README already documents the clock caveat.

## Acceptance criteria
- [ ] A repeated doubly failed `forgetAllGroups()` never lowers an existing cut-off. A test with a mocked clock moving backward covers this.
- [ ] If a skew margin is added: a token issued within the margin before the forget is dropped (covered by a test), and the README states the margin.
- [ ] R5 from `docs/issues/7/security.md` still holds: a failed read never changes the marks or the cut-off.
- [ ] Lint, typecheck, test and build pass. No new dependencies.

## Out of scope
- Any change to server-side token issuance or `iat` semantics.
- Detecting or correcting device clock skew in general.
- Other storage-failure handling in the token store beyond the cut-off.

## Open questions
- Should we add a skew margin, and if so, how large? (Architect recommends; user decides at Gate 2. Not decided here.)

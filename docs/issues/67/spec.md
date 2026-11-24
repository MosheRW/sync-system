# Spec: #67 fix(release): 12 pnpmfile tests fail in the node:24 CI container

Issue: https://github.com/MosheRW/sync-system/issues/67

Part of #65 (sub-issue; QA of PR #66 found it).

## Problem
During QA of #65 (PR #66), `node --test scripts/release/*.test.ts` passed 91 of 103 in the CI container (`node:24` image, repo copied in including `.git`, no bind mounts). The 12 failures are the pnpmfile tests added by #63 (PR #64, ADR 0021, `docs/decisions/0021-pack-with-pnpmfiles-ignored.md`, tests in `scripts/release/pack-check.test.ts`). They fail identically on `main` in that container, so they are pre-existing and may be environmental. These checks are part of the release procedure (`RELEASING.md`), so they must pass before the first 1.0.0 release.

## Acceptance criteria
- [ ] The cause of the 12 failures is identified and recorded in the PR (environment difference vs real bug in the tests or in `pack-check.ts`), with the failing test names and the first error message.
- [ ] The fix is made in the test or code (or the test's assumptions about its environment are made explicit and hold in the container); no test is deleted or skipped to get green.
- [ ] `node --test scripts/release/*.test.ts` passes 104 of 104 in the CI container (pinned `node:24`, repo copied in including `.git`, no bind mounts, `CI=true`).
- [ ] On the developer host (Windows), a full pass through `pnpm test` counts as passing 104 of 104; bare `node --test` on Windows keeps skipping the two pnpm suites, as #63 designed.
- [ ] If the cause is an environment difference, the difference is documented where the release procedure or tests rely on it, and the test fails with a clear message when it is missing.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` still pass.
- [ ] The guard behaviour that #63 and ADR 0021 intend (pnpmfile routes cannot alter the packed tarballs) is not weakened; a mutation check shows the pnpmfile tests still fail when the guard is removed.

## Out of scope
- Changing the release procedure itself or the ADR 0021 decision (unless the cause is a real bug in the guard; then an ADR amendment goes to the architect).
- Other failing or flaky tests outside `scripts/release/`.
- Doing the 1.0.0 release.

## Open questions
- none (cause unknown by design: investigation is part of this issue; if it needs a design decision, escalate to the architect).

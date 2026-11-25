# State: #77 feat(release): publish the reader as a public docker image
- Path: full
- Phase: implementation
- Branch: feat/77-reader-image-release
- PR: #79
- Plan approved by user: yes (Gate 2, 2026-11-25: ADR 0023 A1, B1, C1, D1)
- Security-sensitive: yes
- Review rounds: 0
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- pm gate-1 update: sonnet (default) → DONE
- architect plan: opus (NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (Implementer model line) → DONE
## Gate 2 decisions (user, 2026-11-25)
- A: git tag `reader-vX.Y.Z` (first `reader-v1.0.0`).
- B: reader bumped by hand to 1.0.0 in this PR (package.json, `READER_VERSION`, new `apps/reader/CHANGELOG.md`); stays `private: true` and Changesets-ignored.
- C: `/health` returns `{"status":"ok","version":"X.Y.Z"}` built from `READER_VERSION` only.
- D: image tags `X.Y.Z`, `X.Y`, `X`, `latest` on `ghcr.io/mosherw/sync-system-reader` and `docker.io/moshewin/sync-system-reader`.
## Implementation
- Security controls 1-11 of `security.md` are built in: R1 blocker gate per L1 (state + `stateReason` COMPLETED, closing PRs' merge commits ancestors of `RM`, typed confirmation without a PR, `ACCEPT_UNFIXED` override, `RM` defaults to `origin/main`, tag absent locally and on origin, push only that tag); R3 writes `$IMG/checked` last, R4 refuses without it and re-checks HEAD and clean tree (M1); GHCR token link `?scopes=write:packages` with scope check (M2); `--verify-tag --latest=false` (L2); R6 subshell/cygpath/trap (L4); Docker Hub account-wide token note (L6); optional `docker scout` (L7); optional reader dry run before R1 (L5); Dockerfile runtime COPY allow-list and source-map tests; README "Public image" control-10 points.
- R1's blocker logic was exercised read-only against GitHub (tag/push lines removed): #27 passes with PR #73's merge commit in `origin/main`; #28 open refuses; an `RM` before PR #73's merge refuses.
- Checks at 4052640: host `pnpm lint` (eslint, prettier, check-links), `pnpm typecheck`, `pnpm build` pass. Local CI in Docker (ADR 0018: pinned `node:24@sha256:9d26...7496`, clone copied in with `.git`, pinned Redis sidecar with `--requirepass`, `CI=true`, `SYNC_TEST_REDIS_URL`): `install --frozen-lockfile`, `audit --audit-level=high`, `typecheck`, `test` (all suites incl. Redis, 0 failures: #67's pnpmfile tests pass after the merge of `main`), `build`, `smoke` pass. `pnpm lint` in the container dies of memory (heap OOM by default, killed with 137 at `--max-old-space-size=4096`); `main` fails the same way in the same container, so it is the Docker VM's memory limit, not this PR.
- Not verified here: the reader image build. The host's Docker daemon fails every Docker Hub pull (`401 incorrect username or password` from Docker Desktop's stored login, also with an empty `DOCKER_CONFIG`), so `node:24-alpine` and the dockerfile frontend can't be pulled. QA's reader dry run (R3 from the local clone) needs a working Docker Hub pull (log out or fix the Docker Desktop login first).
## Open questions
- none
## Deviations from plan
- Extra commit `fix(reader): name the placeholder docker hub namespace without its full path`: the existing `release-files.test.ts` (#65) bans the literal placeholder mirror path in every tracked file, so the README names it in words.
- `release-files.test.ts`: the existing "tags only on the host" test counted one `git tag -a` in the whole file; it now expects two (packages + reader R1) and exactly one in step 1.
- R1 adds an `ACCEPT_UNFIXED` override for blockers closed as not completed (security L1 asked for "an explicit override"; the name is mine).
- R3 also checks the `revision` label equals `RM` and that `/app/dist*` has no `.map` file (security control 2 at runtime).
- The sibling releasing-fixes PR #84 (`fix/81-releasing-procedure-lessons`) is open and so far only adds `docs/issues/81/`; the reader section is one self-contained `## Reader image release` section plus one intro line, so a conflict with its later `RELEASING.md` edits should be trivial.

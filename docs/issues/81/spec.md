# Spec: RELEASING.md lessons from the 1.0.0 release

Issue: https://github.com/MosheRW/sync-system/issues/81

## Problem
RELEASING.md was followed by hand for the real 1.0.0 release (2026-11-24, succeeded). Several steps misled or failed in practice:
- the maintainer's terminal is PowerShell, and pasting a Bash block fails with `ParserError: Missing closing ')'`;
- Step 4 `verify` gave up after 6x10 s, but brand-new npm packages under a new scope took ~2-3 min to appear (404), so it printed a false "INCIDENT";
- a fine-grained token fails the GHCR push with "The token provided does not match expected scopes";
- Steps 2/4/6 share `V`, `REL`, `M`, `IMG`, which a new terminal loses (`mktemp` folders);
- Phase A assumes a separate "version packages" release PR, but for 1.0.0 the versions were already 1.0.0 on `main` and the tag went on the merge commit of the last merged PR (#68, `d37f1b3`);
- the "no `index.docker.io` login may remain" check trips on Docker Desktop's own sign-in, which always appears in `docker-credential-desktop list`.

## Acceptance criteria
- [ ] AC1 RELEASING.md says the blocks are Bash, not PowerShell/cmd, with an "On Windows" note: run blocks from Git Bash, or save a block as a script and run `& "C:\Program Files\Git\bin\bash.exe" script.sh` (what worked).
- [ ] AC2 The registry verify waits about 5 minutes, treats "not visible yet" (E404 or empty; new scope packages took ~2-3 min) as not an incident, and prints INCIDENT only when the registry shows a `dist.integrity` that differs from the checked tarball.
- [ ] AC3 Step 6 says GHCR needs a **classic** PAT with `write:packages` (a fine-grained token fails with "The token provided does not match expected scopes") and the push block refuses a token that is not `ghp_...`.
- [ ] AC4 Phase B uses a fixed per-version folder `$HOME/sync-release-$V` (image clone under `$REL/image`) instead of `mktemp`, so any terminal can resume; a resume section says how to set the variables again, including `M`.
- [ ] AC5 Phase B says which PR number to use when there is no separate release PR (versions already final on `main`; use the last merged PR, e.g. #68 / `d37f1b3` for 1.0.0).
- [ ] AC6 The post-push credential check no longer tells the maintainer to sign Docker Desktop out of its own `index.docker.io` sign-in (that entry does not count).
- [ ] AC7 Every existing security property (two-container split, token handling, traps, image clone outside the working copy, registry `DOCKER_CONFIG` as `mktemp -d`) still holds and is pinned by `apps/sync-server/test/release-files.test.ts`, which also covers the new wording.
- [ ] AC8 (separate commits) `docs/roadmap.md` records 1.0.0 released 2026-11-24: tag `v1.0.0` -> `d37f1b3`; npm `@mosherw/sync-system-{protocol,client,react}@1.0.0`; image `ghcr.io/mosherw/sync-system-server` + `docker.io/moshewin/sync-system-server` tags 1.0.0/1.0/1/latest, index digest `sha256:fd7ae722efadb118cf8e6a4b92be03054071fc61ca3ed6ea716a257acf5b24c2`; GitHub release v1.0.0; and #67 merged via PR #68 on 2026-11-24 as `d37f1b3`. Only those lines are edited. `docs/issues/67/STATE.md` Phase is `merged`.
- [ ] AC9 lint, typecheck, test, build pass (local Docker run, ADR 0018: GitHub Actions is billing-blocked).

## Out of scope
- Automating the release; changing release architecture, registries or ADR 0017.
- Roadmap edits beyond the lines in AC8.

## Open questions
None.

# Architecture: #81 RELEASING.md lessons from the 1.0.0 release

Path: fast. Change type: fix (docs/release). Branch
`fix/81-releasing-procedure-lessons`.

> **Spec mismatch (must be fixed before Gate 2).** The issue body of #81 and
> the committed `docs/issues/81/spec.md` hold the text of #80 (load-sensitive
> tests), not the release lessons. This plan is written from the
> orchestrator's brief and the 1.0.0 release notes (lessons recorded on
> 2026-11-24). The acceptance criteria below (AC1-AC9) are proposed; `pm`
> must replace the issue body and `spec.md` with them so QA validates the
> right thing.

## Proposed acceptance criteria

- AC1 RELEASING.md says the blocks are bash, never PowerShell/cmd, and how to
  run them from a PowerShell terminal.
- AC2 The registry verify waits about 5 minutes, treats "not visible yet"
  (E404 or empty) as not an incident, and says INCIDENT only when the
  registry shows a `dist.integrity` that differs from the checked tarball.
- AC3 Step 6 says GHCR needs a **classic** PAT with `write:packages` (a
  fine-grained token cannot push to GHCR) and the push block refuses a
  token that is not `ghp_...`.
- AC4 Phase B uses a fixed per-version folder `$HOME/sync-release-$V` (and
  `$REL/image` for the image clone), so any terminal can resume; a resume
  section says how to set the variables again, including `M`.
- AC5 Phase B says which PR number to use when there is no separate release
  PR.
- AC6 The post-push credential check no longer tells the maintainer to log
  Docker Desktop out of its own `index.docker.io` sign-in.
- AC7 Every security property listed below still holds and is pinned by
  `release-files.test.ts`.
- AC8 `docs/roadmap.md` records the 1.0.0 release and #67 as done;
  `docs/issues/67/STATE.md` Phase is `merged`.
- AC9 lint, typecheck, test, build pass (local Docker run, ADR 0018).

## Repo layout

`single` (pnpm workspace monorepo, no submodules). Affected: root
`RELEASING.md`, `apps/sync-server` (test only), `docs/`. Checks:
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` at the root.
No other repo is involved.

Decisions: none open. No ADR. ADR 0017 says the image clone goes into "a
`mktemp -d` directory outside the working copy (L11)"; the property (outside
the working copy) is kept, only the mechanism changes, so ADR 0017 is not
amended (accepted ADRs are history). The registry `DOCKER_CONFIG` stays
`mktemp -d` exactly as ADR 0017 says.

## Files to change

| File | Change |
|---|---|
| `RELEASING.md` | The six fixes below |
| `apps/sync-server/test/release-files.test.ts` | Replace the `mktemp` L11 assertions; add assertions for each fix and for the kept properties |
| `docs/roadmap.md` | Item 9 row: 1.0.0 released; #67 line done; "#67 is open" in the #65 line |
| `docs/issues/67/STATE.md` | Phase `validation` → `merged`, PR #68 merge recorded |
| `docs/issues/81/STATE.md` | Phase updates (every agent) |

## The six RELEASING.md fixes (exact behaviour)

### F1 Windows / PowerShell (Before you start)

Replace the "On Windows use Git Bash" sentence with a bullet that says:

- The blocks are **bash**. On Windows run them in Git Bash, **never in
  PowerShell or cmd** (`( set -euo pipefail`, `$V`, `read -rs` mean
  something else or nothing there).
- From a PowerShell terminal, first start bash in it:
  `& "C:\Program Files\Git\bin\bash.exe" -l` (the prompt changes to `$`),
  then paste the Phase B setup and the blocks there.
- Alternative: save one block to a `.sh` file **outside the repo** and run
  `& "C:\Program Files\Git\bin\bash.exe" <file>`. A script does not see
  variables exported in another shell, so the file starts with the Phase B
  setup lines (F4). Never write a token into such a file: blocks read
  tokens only at their prompt.
- Keep the existing `MSYS_NO_PATHCONV=1` / `cygpath -m` sentence.

### F2 Verify waits ~5 minutes and only a real mismatch is an INCIDENT (step 4)

Move `verify` out of the publish block into its **own block** after the
`docker ps -a` check, titled "Then verify (anonymous, re-run any time)".
The publish block ends after `npm logout` and `rm -f /root/.npmrc` (the
token is already gone before any verify today, so exposure does not
change). The verify block:

- sets the pinned `NODE_IMAGE`, checks `V`, converts `REL` with `cygpath -m`;
- per package, takes `want` from `"$H/out/INTEGRITY.txt"` with the literal
  file name; empty `want` → `echo "no line for $2 in INTEGRITY.txt"` and
  fail (a local problem, **not** an incident);
- polls with a fresh credential-less container per attempt:
  `docker run --rm "$NODE_IMAGE" npm view "$1@$V" dist.integrity --prefer-online`
  (no `-e`, no `-i`, no volume, no token), **30 attempts × 10 s ≈ 5 min**;
- classifies each answer:
  - exit 0 and output equal to `want` → `"$1@$V dist.integrity ok"`;
  - exit 0 and non-empty output different from `want` → the **only**
    INCIDENT line: `"$1@$V: dist.integrity differs from the checked tarball: INCIDENT (deprecate, revoke, report)"`, fail at once (no more waiting);
  - exit 0 with empty output, or non-zero with `E404` in the output →
    not visible yet, keep waiting;
  - any other non-zero (network) → keep waiting;
- after 5 min without an answer: `"$1@$V is not visible on the registry yet (not an incident): run this block again in a few minutes"` and fail;
- the prose says: new scope packages took about 2-3 minutes to appear at
  1.0.0; run this block before step 5; re-running it is safe (read-only,
  no credential).

`--prefer-online` is needed so a cached 404 from the first attempt is not
served again.

### F3 GHCR needs a classic PAT (step 6)

- Prose: GitHub, Settings, Developer settings, Personal access tokens,
  **Tokens (classic)**; scope **only** `write:packages` (it adds
  `read:packages`; if the form also ticks `repo`, untick it). Fine-grained
  tokens (`github_pat_...`) cannot push to GHCR. Shortest expiry offered.
- Push block: prompt becomes `'GHCR classic token (write:packages): '`;
  right after the read and before `docker login`:
  `case "$T" in ghp_*) ;; *) echo 'not a classic GitHub token (ghp_...): GHCR needs a classic token with write:packages'; exit 1 ;; esac`
  The message never includes the token; the trap still runs on this exit.

### F4 Fixed resume folder (Phase B setup, steps 2, 4, 6, 8, dry run)

Phase B setup becomes:

```sh
export V=1.0.0                          # the version on main
export PR=0                             # see "Which PR" below
export REL="$HOME/sync-release-$V"      # outside the repo; same in every terminal
export IMG="$REL/image"                 # the step 6 clone
( set -euo pipefail
  [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'set V=X.Y.Z'; exit 1; }
  [ ! -L "$REL" ] || { echo "$REL is a symlink"; exit 1; }
  mkdir -p "$REL" && chmod 700 "$REL"
)
```

New subsection "Resume in another terminal": run the setup lines again with
the same `V` and `PR`; after step 1 also
`export M="$(git rev-parse "refs/tags/v$V^{commit}")"` (the tag step 1
created from the verified merge commit) and compare it with the `M` noted
in the release notes draft. Nothing in `$REL` is secret; tokens never
survive a block, so a resume always starts the credential step again
(step 3 / the step 6 push block) with a new token.

Other changes for the fixed folder:
- Step 6 check block: drop `export IMG="$(mktemp -d)"`; add
  `[ -n "${IMG:-}" ] || { echo 'set IMG (Phase B setup)'; exit 1; }` and
  `rm -rf "$D/src"` before `git clone` (a re-run must not fail on, or
  reuse, an old clone).
- Step 6 push block: before the build, re-check the clone as the check
  block does: `[ "$(git -C "$D/src" rev-parse HEAD)" = "$M" ]` and
  `[ -z "$(git -C "$D/src" status --porcelain)" ]` (a resumed terminal
  must not push a stale clone).
- `CFG="$(mktemp -d)"` for `DOCKER_CONFIG` stays **unchanged**: it is the
  only folder that ever holds a credential and it must stay unique and
  trap-removed. It is never under `$REL`.
- Step 8: `rm -rf "$REL"` (the image clone is inside it); keep the token
  list checks.
- Dry run: keeps `REL="$(mktemp -d)"` (it must not collide with a real
  release folder of the same `V`) and sets `IMG="$REL/image"`; its step 3
  line no longer creates `IMG` with `mktemp`.

### F5 Which PR when there is no separate release PR (Phase B setup)

Under the setup: `PR` is the **merged PR whose merge commit you release**.
Normally that is the release PR of Phase A. If the versions reached `main`
through another PR, or other PRs were merged after it, use the newest
merged PR on `main` (1.0.0 was the merge of #68, not of the version PR
#50). List candidates with:

```sh
gh pr list --state merged --base main --limit 10 --json number,title,mergedAt,mergeCommit \
  --jq '.[] | "\(.number) \(.mergedAt) \(.mergeCommit.oid[0:7]) \(.title)"'
```

Step 1 still refuses a merge commit that is not on `origin/main` or where
any of the four `package.json` files is not at `V`, so a wrong pick stops
there.

### F6 Docker Desktop's own `index.docker.io` credential (step 6)

Replace the "neither may show `ghcr.io` or `index.docker.io`" paragraph:

- **Before** the push block, run the credential helper's `list` (it prints
  registry URLs and user names, no secrets) and note what it shows.
- **After** the block: `ghcr.io` must not be listed. An
  `index.docker.io` (`https://index.docker.io/v1/`) entry that was already
  there before is Docker Desktop's own sign-in: leave it, and do not run
  `docker logout docker.io` against it (that signs Docker Desktop out).
  Any entry that is new since the "before" list: `docker logout <registry>`.
- If Docker Desktop shows you signed out of Docker Hub after the release
  (the block's logout can reach the shared credential helper), sign in
  again from Docker Desktop; that is its own credential, not the release
  token.
- Either way the next step, **revoke both registry tokens**, makes any copy
  of a release token useless. Keep that sentence.

## Security

Security-sensitive: yes. Areas: the release procedure, npm token handling
(step 3-4), registry token handling (step 6), the on-disk release folder,
and the credential-store check.

Properties that must still hold (and are pinned by tests):

1. **Three places**: build container has no credential; publish container
   runs no project code and gets only the tarballs, `INTEGRITY.txt` and the
   npm token over stdin into a mode-600 `/root/.npmrc`. F2 moves verify out
   of the publish container into fresh credential-less `docker run --rm`
   containers: strictly less exposure.
2. **Token handling**: `read -rs`, `printf` builtin, `unset`, never in
   argv, env, a file or history; no `set -x`; checks before the token
   exists; npm token prefix check. F3 adds a GHCR prefix check that echoes
   no token.
3. **Traps**: every credential block keeps its `trap ... EXIT`, set before
   the first credential, every `docker` command `|| true`. The verify
   block holds no credential and starts only `--rm` containers, so it
   needs no trap.
4. **Registry config**: `DOCKER_CONFIG` stays a `mktemp -d` folder removed
   by the trap; logouts of both registries stay in the trap.
5. **L11 outside the repo**: `$HOME/sync-release-$V` is outside the working
   copy as long as the repo is not checked out at `$HOME` itself (the
   prose says so; the test asserts the literal setup line, not `mktemp`).

Risks of the fixed folder vs `mktemp -d` and their handling:

- **Permissions**: `mktemp -d` makes a 700 folder; `mkdir` follows the
  umask (often 755). The setup runs `chmod 700 "$REL"`. On Windows the
  user profile ACL already keeps other users out. The folder holds only
  public code and the checked tarballs; the integrity anchor is the three
  lines the maintainer kept from step 2 (pasted into the release notes
  draft), which step 4 asks for.
- **Predictable path / symlink**: the path is under `$HOME`, not a shared
  `/tmp`, so no other user can plant it; the setup still refuses a symlink.
- **Leftover secrets**: none can be left in `$REL`: no token is ever
  written to the host (npm token only in the publish container; registry
  logins only in the `mktemp` `DOCKER_CONFIG`). The test pins that
  `DOCKER_CONFIG` is not under `$REL` and still `mktemp -d`.
- **Stale contents on resume**: step 2 already deletes `out/` and the
  bundle; the step 6 check deletes the old clone; the push block re-checks
  the clone against `M`; step 4 re-checks every tarball. A leftover
  `integrity-run1.txt` or `recomputed.txt` is not a secret.
- **Cleanup**: step 8 `rm -rf "$REL"`, unchanged in intent.
- **Resuming `M`** from the local tag: the tag is the one step 1 made from
  the verified merge commit, and every later step checks against `M`.

## Approach / rejected alternatives

- Docs-and-test change only; no product code.
- Rejected: force a file-only credential store in the temp `DOCKER_CONFIG`
  (a placeholder `auths` entry) to keep Docker Desktop's sign-in untouched.
  It relies on undocumented docker CLI behaviour; revocation already
  covers the risk. Can be a follow-up.
- Rejected: keep verify inside the publish block. A timeout then needs the
  whole credential block again; a separate anonymous block is re-runnable.
- Rejected: fixed folder for the dry run (collides with a real release).

## Contracts / data / Docker

No API, message, schema or dependency change. Docker impact: none (only the
documented `docker run` lines of the procedure change).

## Docs impact

`RELEASING.md` (the change itself), `docs/roadmap.md`,
`docs/issues/67/STATE.md`. No README, operator guide or ADR change.
`docs/conventions.md`: none.

## Risks / edge cases

- PR #79 (#77, reader image) will add a reader section to `RELEASING.md`;
  whichever merges second resolves a text conflict. Keep edits inside the
  sections named above.
- A sibling session edits `docs/roadmap.md` for its own line: touch only
  the item 9 row, the #65 line's "#67 is open" phrase and the #67 line.
- `npm view` output for a missing version (exit 0, empty) differs by npm
  version; the classification treats empty as "not yet", so either shape
  is safe.

## Test plan

Automated (`apps/sync-server/test/release-files.test.ts`, reads files
only, starts nothing):
- L11: replace the two `mktemp` assertions with: setup contains
  `export REL="$HOME/sync-release-$V"` and `export IMG="$REL/image"` and
  `chmod 700 "$REL"` and the symlink check; no `export IMG="$(mktemp -d)"`;
  the push block still has `CFG="$(mktemp -d)"` and no `DOCKER_CONFIG`
  under `$REL`; step 8 has `rm -rf "$REL"`. (AC4, AC7)
- Resume section exists and contains `refs/tags/v$V^{commit}`. (AC4)
- F1: Before you start mentions `PowerShell` and
  `C:\Program Files\Git\bin\bash.exe`. (AC1)
- F2: the verify block exists after the publish block; uses
  `docker run --rm` with no `-e`/`-i`/`-v`; `--prefer-online`; `E404`;
  30 attempts; `INCIDENT` occurs exactly once in the doc's shell code, on
  the mismatch branch; the not-visible message contains `not an incident`;
  the publish block itself no longer runs `npm view ... dist.integrity`
  after publishing (the "already published" check stays). Update the
  existing L8 test so `dist.integrity` is looked for in step 4's text. (AC2)
- F3: step 6 contains `Tokens (classic)`, `fine-grained`, and
  `case "$T" in ghp_*)` before the first `docker login ghcr.io`; no
  `echo` line expands `$T`. (AC3)
- F5: Phase B mentions `mergeCommit` in a `gh pr list --state merged`
  line and "no separate release PR"/newest merged PR wording. (AC5)
- F6: step 6 mentions `Docker Desktop`, `index.docker.io`, "before the push
  block", and still `docker-credential-` and "revoke both registry
  tokens". (AC6)
- All existing assertions keep passing (traps ≥ 4 and failure-tolerant,
  token over stdin, digest pins, `docker ps -a` check, etc.). (AC7)

Manual (engineer, recorded in the PR):
- `bash -n` on every extracted ```` ```sh ```` block of `RELEASING.md`.
- Run the new verify block against the published 1.0.0 packages with a
  temp `REL` whose `out/INTEGRITY.txt` holds the three lines from the
  v1.0.0 release notes → three `ok`; with one value altered → one
  INCIDENT and an immediate stop; with `V=9.9.9` and a temporarily
  shortened attempt count (not committed) → the not-visible message, no
  INCIDENT. Read-only, anonymous; no token involved.
- Full CI locally in Docker (GitHub Actions is billing-blocked, ADR 0018):
  node:24 pinned image + `redis:7.2.17-alpine` sidecar, repo copied in
  including `.git`, no bind mount, `CI=true` with `SYNC_TEST_REDIS_URL` and
  the CI password: `pnpm install --frozen-lockfile && pnpm lint &&
  pnpm typecheck && pnpm test && pnpm build` (or the step 2 block with
  `MODE=dry-run` from this branch). (AC9)

Agents never run the real publish or push blocks.

Implementer model: opus
Reason: security-sensitive release procedure with token-handling shell
blocks and nuanced verify classification; the hard rule forbids Sonnet for
`Security-sensitive: yes`.

## Implementation chunks

1. `fix(release): apply the 1.0.0 lessons to RELEASING.md` (RELEASING.md
   F1-F6 + `release-files.test.ts` updates, one commit so the test and doc
   never disagree)
2. `docs(roadmap): record the 1.0.0 release and #67 as done`
3. `docs(issues): mark #67 merged in its state file`

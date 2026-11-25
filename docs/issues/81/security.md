# Security review (plan): #81 RELEASING.md lessons from the 1.0.0 release

Mode: plan. Reviewed: `docs/issues/81/architecture.md` (F1-F6) against
`docs/issues/81/spec.md` (AC1-AC9), the current `RELEASING.md`, and
ADR 0017 (D1, L9, L11) / ADR 0018.

**Verdict: PASS** (critical 0, high 0, medium 4, low 6).

The plan keeps every existing security property: the three-place split,
token over `read -rs` / `printf` builtin / stdin only, `unset`, no `set -x`,
traps set before the first credential and failure-tolerant, registry
`DOCKER_CONFIG` as `mktemp -d` removed by the trap, and the image clone
outside the working copy. F2 (verify in fresh tokenless containers) strictly
reduces exposure. The new fixed folder holds no secret. The findings below
are advisories plus the required controls the engineer must implement.

## Assets and trust boundaries

| Asset | Where it lives | Boundary |
|---|---|---|
| npm granular token (bypass 2FA) | npmjs.com page, clipboard, one host shell variable, publish container `/root/.npmrc` | host terminal → publish container (stdin) |
| GHCR classic PAT (`write:packages`) | GitHub page, clipboard, host shell variable, OS credential store (see M1) | host → `docker login` → credential helper |
| Docker Hub PAT | same as GHCR; shares the `https://index.docker.io/v1/` key with Docker Desktop's own sign-in | same |
| Integrity anchor | the three `sha512-` lines kept from step 2 (release notes draft) | human check in step 4 |
| Release commit `M` | step 1 output; local tag `v$V` | host git |
| Release folder `$HOME/sync-release-$V` | host user profile | same-user only |

## Threats (STRIDE, short)

- **Information disclosure**: a token echoed by an error message, left in a
  credential store, pasted into a shell prompt (history file), written to a
  helper script, or sent to the wrong registry.
- **Tampering**: stale or swapped tarballs / image clone used on a resume;
  a symlinked release folder; a wrong `M` after resume.
- **Spoofing / repudiation**: a false "INCIDENT" or a false "ok" from verify.
- **Elevation**: an over-scoped GitHub classic PAT (`repo` ticked).
- **DoS**: not relevant (manual, one-off procedure).

## Review of the specific questions

1. **Fixed folder instead of `mktemp`.** Acceptable. `$HOME` is not shared,
   so the classic `/tmp` symlink race does not apply; anything that can plant
   a symlink in `$HOME` already runs as the maintainer. Nothing secret is
   ever written there (the npm token only in the publish container, registry
   logins only via `DOCKER_CONFIG` / OS store). `chmod 700` is effectively a
   no-op on Git for Windows (noacl mounts); the profile ACL is what protects
   it (L1). Stale content is handled by step 2's `rm -rf out`, the check
   block's `rm -rf "$D/src"`, the push block's re-check against `M`, and the
   step 4 human anchor. Residual gaps: L2, L3, L4.
2. **`ghp_` prefix check.** The planned message is static and does not
   expand `$T`; the trap is set before the `read`, and the subshell exit
   discards `T`. Good. Classic PATs are broad: `write:packages` on a classic
   PAT covers every package the account can write, and the GitHub UI ticks
   `repo` automatically when `write:packages` is selected. Short expiry,
   no `repo`, and revocation right after the push are adequate for a token
   that lives minutes, provided the `repo` untick is verified (control R3).
   The Docker Hub prompt has no prefix check, so the GitHub PAT can still be
   pasted there and sent to Docker Hub (M3).
3. **Verify in tokenless containers.** Correct direction: no `-e`, `-i`,
   `-v`, pinned `NODE_IMAGE`, fresh `--rm` container. Classification is
   fail-closed for a mismatch (immediate INCIDENT) and treats every other
   outcome as "not verified" with a non-zero exit. The ordering "run before
   step 5" lengthens the npm token's life by up to ~5 minutes per attempt
   (M2).
4. **Windows script-file alternative.** Safe as planned (no token in the
   file, file outside the repo, tokens only at the prompt). New risk: a
   token pasted when the block has already exited lands at the PowerShell
   prompt, and PSReadLine writes it to its history file immediately (M4).
5. **Docker Desktop `index.docker.io` before/after comparison.** Yes, it
   can mask a real leftover. ADR 0017 records that with a temp
   `DOCKER_CONFIG` the CLI still uses the platform credential helper, so
   the release `docker login docker.io` writes the release PAT under the
   **same key** (`https://index.docker.io/v1/`, very likely the same user
   `moshewin`) as Docker Desktop's sign-in, overwriting it. If the trap's
   `docker logout docker.io` fails (it is `|| true`), the "after" list looks
   identical to "before" while it holds the release PAT. Revocation
   neutralises it, so this is advisory (M1), but the prose must not call
   that entry harmless.

## Findings

| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| M1 | Medium | architecture.md F6; RELEASING.md step 6 "After the block" | Before/after comparison by URL cannot tell Docker Desktop's sign-in from a leftover release PAT under the same `https://index.docker.io/v1/` key; a failed trap logout is masked. Weakens ADR 0017 L9's leftover check for Docker Hub. | Prose per R6: state the entry cannot be told apart, so revoking the Docker Hub PAT is **mandatory** and is the control; if Docker Desktop still shows you signed in and you did not sign in again, treat the entry as possibly the release token (revoke, then sign out/in from Docker Desktop to overwrite it). Keep the `ghcr.io` check strict. Follow-up issue for the placeholder-`auths` temp config (the rejected alternative), which would isolate logins in `$DOCKER_CONFIG` and remove this ambiguity. |
| M2 | Medium | architecture.md F2 ("run this block before step 5") | Verify now waits up to ~5 min (and may be re-run); putting it before step 5 extends the live npm bypass-2FA token for no benefit, since verify needs no token and an incident response (`npm deprecate`) needs a new token anyway. Contradicts "Revoke within minutes" / step 5 "now". | Order: publish block → `docker ps -a` check → **step 5 revoke** → verify block (may run before or after step 5, must print three `ok` before step 7). Say so in the verify prose. |
| M3 | Medium | RELEASING.md step 6 push block, Docker Hub `read` | No prefix check on the Docker Hub prompt: pasting the GitHub classic PAT (or the npm token) there sends a GitHub credential to Docker Hub. | Add `case "$T" in dckr_pat_*) ;; *) echo 'not a Docker Hub personal access token (dckr_pat_...)'; exit 1 ;; esac` right after that `read`, static message, before `docker login docker.io`. (If the engineer cannot confirm the `dckr_pat_` prefix from Docker docs, note it and skip; do not guess a prefix that would block a valid token.) |
| M4 | Medium | architecture.md F1 (PowerShell guidance) | If a block exits early (failed check, Ctrl-C) while the maintainer pastes a token, the paste lands at the PowerShell (or bash) prompt; PSReadLine persists it to `ConsoleHost_history.txt` at once. | F1 prose: "If a token is ever pasted at a shell prompt (PowerShell or bash), revoke it now and create a new one; remove the line from the history file (PowerShell: `(Get-PSReadLineOption).HistorySavePath`; bash: `history -d`, `~/.bash_history`)." Also: paste a token only right after the `token:` prompt is visible. |
| L1 | Low | F4 setup `chmod 700 "$REL"`; architecture "Permissions" | `chmod 700` is a no-op on Git for Windows; doc must not imply it protects there. | One phrase: on Windows the user-profile ACL is what keeps others out. Keep the `chmod` for Linux/macOS. |
| L2 | Low | F4 push-block re-check | `git status --porcelain` hides ignored files, so files added to a long-lived `$REL/image/src` between check and push are not detected. | Use `git -C "$D/src" status --porcelain --ignored` in both the check and push re-check (fresh clone has none). |
| L3 | Low | F4 step 6 check `rm -rf "$D/src"`; step 8 `rm -rf "$REL"` | `IMG`/`REL` are only checked for non-empty before `rm -rf`. | Guard: `[ "$IMG" = "$REL/image" ]` before the clone/rm, and in step 8 `[[ "$REL" == "$HOME"/sync-release-* ]]` (or `mktemp` dry-run path) before `rm -rf "$REL"`. |
| L4 | Low | F4 Phase B setup / resume | `REF`, `MODE`, `SRC_URL` exported by a dry run in the same terminal silently change steps 2 and 6 (and now the output persists in the fixed folder). The step 4 human anchor and `M` checks catch it, but late. | Phase B setup and the resume section start with `unset REF MODE SRC_URL`. |
| L5 | Low | F4 resume `M` | Resumed `M` comes from the local tag; the plan compares it with the noted `M`. | Make the resume line also check `[[ "$M" =~ ^[0-9a-f]{40}$ ]]` and `git merge-base --is-ancestor "$M" origin/main` after `git fetch origin`, and stop if it differs from the `M` in the release notes draft. |
| L6 | Low | F2 verify `want` lookup | `grep "^$2 "` treats the dots in the file name as regex. Harmless (anchored, fixed names) but imprecise. | `awk -v f="$2" '$1==f {print $2}' "$H/out/INTEGRITY.txt"`. Also print the `want` values so the maintainer can compare them with the release notes draft lines. |

No critical or high findings.

## Required controls (part of the plan; QA and security code mode check them)

R1. **Existing properties unchanged** (AC7): three-place split table and
rule text; `read -rs`, `printf` builtin, `--password-stdin`, `unset`, npm
`npm_*` prefix check; no `set -x` anywhere; every credential block keeps its
`trap ... EXIT` set before the first credential with each `docker` command
`|| true`; `CFG="$(mktemp -d)"` / `DOCKER_CONFIG` never under `$REL`; both
registry logouts and `rm -rf "$DOCKER_CONFIG"` in the trap. Pinned by
`release-files.test.ts`.

R2. **GHCR prefix check** exactly after `read -rs ... T` and before the
first `docker login ghcr.io`, static message, no `$T` in any `echo`/
`printf` other than the `printf '%s' "$T" | docker login` pipe. Test: no
line in the doc's shell code expands `$T` except that pipe.

R3. **Classic PAT scope**: prose says Tokens (classic), only
`write:packages`, **untick `repo`** (GitHub ticks it automatically), and
check the token's scope list shows only `write:packages`/`read:packages`
before copying; custom expiry of the next day, never "No expiration"; revoke
right after the push. Fine-grained tokens are not an alternative.

R4. **Verify block holds no credential**: `docker run --rm "$NODE_IMAGE"`
with the pinned digest, no `-e`, `-i`, `-v`, `--env-file`, no
`DOCKER_CONFIG` use; `--prefer-online`; INCIDENT only on exit 0 + non-empty
+ different; every other terminal state exits non-zero with the "not an
incident, run again" message. The publish block no longer contains the
verify loop, and its trap and `npm logout` / `rm -f /root/.npmrc` stay.

R5. **Fixed folder**: setup refuses a symlinked `$REL`, `mkdir -p` + `chmod
700`; nothing credential-bearing is ever written under `$REL` (test pins
`DOCKER_CONFIG` not under `$REL`); prose says `$REL` must be outside the
repo (repo not checked out at `$HOME`). Step 6 check deletes the old clone
before cloning; the push block re-checks `HEAD = M` and a clean tree before
building. Step 8 removes `$REL`. Dry run keeps `mktemp -d`.

R6. **Credential-store check (M1)**: the ghcr.io rule stays strict; the
`index.docker.io` text says the entry is shared with Docker Desktop and
cannot be told apart from a leftover release login, so **revoking both
registry tokens is mandatory** and is the control; never instruct the user
to keep a release token. ("revoke both registry tokens" stays pinned by the
test.)

R7. **Windows script file (F1)**: never contains a token, lives outside the
repo, is deleted after the release; blocks read tokens only at their
prompt.

R8. Implement M2 (revoke before verify) and M4 (token pasted at a prompt
→ revoke) prose; they are cheap and directly protect the token lifetime.

## What I will check in code mode

- Every R1-R8 item in the diff of `RELEASING.md`, and that
  `release-files.test.ts` pins R1, R2, R4, R5, R6.
- `bash -n` cleanliness reported by the engineer; no `set -x`, no `$T` /
  `$NPM_TOKEN` expansion in output; trap order unchanged.
- The verify classification branches (mismatch → INCIDENT once, fail fast;
  E404/empty/other → wait; timeout → non-zero, "not an incident").
- No token, PAT prefix example with a real value, or credential in the
  roadmap / STATE edits; gitleaks over the PR range; `npm audit` (no
  dependency change expected).
- Medium/low items above: implemented or listed as accepted advisories.

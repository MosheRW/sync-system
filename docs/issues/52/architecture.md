# Architecture: #52 move the docker ps check in RELEASING.md step 4 to its own block

Path: fast

## Repo layout
Single repo, pnpm workspace (`apps/*`, `packages/*`), no submodules. Only the
root file `RELEASING.md` changes. Checks: root `pnpm lint` (prettier covers the
markdown), `pnpm test` (runs `apps/sync-server` vitest, including the release
marker test).

Decisions: none open. Docker impact: none.

## Approach
In `RELEASING.md` step 4, the last line of the publish code block
(`docker ps -a --filter name=sync-release-publish   # must list no container`)
sits after the closing `)` of the subshell, so a paste without bracketed paste
feeds it to the "Type yes" `read`. Move it to its own `sh` block placed after
the publish block, preceded by one sentence telling the operator to run it as a
separate step, after the publish block has finished (not pasted together).
The publish block itself is unchanged (spec: out of scope). Rejected: moving
the check inside the subshell; that changes the procedure and the check is
meant to run after the trap's cleanup.

## Files to modify
- `RELEASING.md`: remove the `docker ps` line from the publish block; add the
  sentence and a new `sh` block (the same command and its comment) after it,
  before the "`npm publish <tarball>` publishes the bytes ..." paragraph.
  Keep the "Paste only this block" wording valid: it still refers to the
  publish block.

No other file changes.

## Tests: needs no change
The only test that parses RELEASING.md is
`apps/sync-server/test/release-files.test.ts` (describe "RELEASING.md
load-bearing lines"); `scripts/release/*` has no reference to it. Impact:
- `publishBlock = step('4. Publish container')` is the whole section up to the
  next heading, so `toContain('docker ps -a --filter name=sync-release-publish')`
  (test "removes the publish container on every exit path") still holds with
  the line in a second block of the same step.
- "checks the pasted token ..." slices from the first ```` ```sh ```` to
  `read -rs`: unaffected (the new block comes after).
- `shell` (all `sh` blocks joined) feeds the `npm publish`, `node:24@sha256`
  and trap tests: the new block adds none of those, so they are unaffected.
- The trap test counts `trap '...' EXIT` only; the new block has none.
Not adding a new assertion: out of scope for the spec (a test that the line
is outside the subshell would be optional; not planned).

## Security-sensitive: no
Step 4 handles the npm publish token, but the change only moves a read-only
`docker ps` listing from inside the token-handling paste to a separate block
after it. No token, credential, or command that touches one changes; the
`trap`, `read -rs`, `.npmrc` and `npm publish` lines stay as they are, and the
marker tests that guard them (above) are untouched. If anything the change
lowers risk: the "Type yes" prompt can no longer swallow an unrelated line.
No dependencies, endpoints, schema or config.

Implementer model: sonnet
One-line reason: a one-file docs move following the existing block style in
the same file, no contracts, schema, dependencies or open decisions.

## Test plan (local Docker CI)
GitHub Actions is billing-blocked, so run the checks locally in Docker:
`node:24` plus a `redis:7.2.17-alpine` service, the repo copied in **including
`.git`** (the test calls `git ls-files`), no bind mounts. Inside: `pnpm install
--frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
Mapped to the acceptance criteria:
- AC1 and AC2 (own block after the publish block; text says run separately):
  manual check of the diff in `RELEASING.md`.
- AC3 (release marker test passes): `pnpm --filter @mosherw/sync-system-server
  test release-files` (full `pnpm test` also run).
- Prettier (`pnpm lint`) passes on the edited markdown.

## Docs impact
`RELEASING.md` itself (the change). No README, ADR or conventions updates.

## Risks / edge cases
- Prettier reflow of the new sentence: run `pnpm lint`.
- Keep the file's line endings (the test regexes accept `\r?\n`); do not
  convert.

## Implementation chunks
1. `docs(release): run the docker ps check as a separate step in step 4`
   (the only chunk; it is the docs change, so no extra docs chunk).

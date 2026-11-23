# Architecture: #54 repo-hygiene CI trigger test blocks `pnpm test` in the release procedure

Path: fast. Branch: `fix/54-repo-hygiene-ci-trigger`.

## Cause (verified)

- `80ec2c7 Update ci.yml` (2026-11-22, committed directly to `main` from the
  GitHub web editor, no PR) replaced `on: push / pull_request` with
  `workflow_dispatch:` and commented out `# push:` and `# pull_request:`,
  because Actions is billing-blocked.
- `apps/sync-server/test/repo-hygiene.test.ts:260` asserts
  `/^on:\n {2}push:\n {2}pull_request:/m`. It is the only failure:
  `vitest run test/repo-hygiene.test.ts` gives 1 failed, 34 passed. It has
  failed on every branch since (#12, #21, #37 QA notes).
- `RELEASING.md` step 2 runs `pnpm test` under `set -euo pipefail`, so the
  build container stops there in both the real release and the dry run.
- Not a line-ending problem: `.gitattributes` is `* text=auto eol=lf`.

## Repo layout

Monorepo (pnpm workspaces, no submodules). Touched: the root
(`.github/workflows/ci.yml`, `RELEASING.md`, `docs/`) and `apps/sync-server`
(test only). Checks: root `pnpm lint`, `pnpm typecheck`, `pnpm test`. No
other repo is involved.

## Decisions

- [ADR 0018](../../decisions/0018-ci-workflow-while-actions-is-blocked.md)
  (Proposed): CI workflow triggers while Actions is blocked. Options A
  (restore triggers), B (explicit, marked pause that the test accepts), C
  (env flag, rejected), D (repo-variable job gate, rejected).
  **Recommendation: B.**

## Approach (option B)

1. `.github/workflows/ci.yml`: add a fixed marker comment directly above
   `on:`; the triggers stay as they are:

   ```yaml
   # CI paused (#54): GitHub Actions is billing-blocked, so push and
   # pull_request are commented out and the checks run locally in Docker
   # (RELEASING.md step 2). To resume: uncomment both and delete this comment.
   on:
     workflow_dispatch:
     # push:
     # pull_request:
   ```

2. `repo-hygiene.test.ts`, `describe('CI workflow (AC28, L1, L8)')`: replace
   the trigger regex with a small parser of the `on:` block (the lines after
   `^on:$` up to the next line that does not start with two spaces):
   - `keys` = active lines matching `^ {2}([a-z_]+):`;
     `commented` = lines matching `^ {2}# ([a-z_]+):`;
     `paused` = the workflow contains the marker `# CI paused (#54):`.
   - Every key is in the allowlist `push`, `pull_request`,
     `workflow_dispatch` (so `pull_request_target`, `workflow_run`,
     `schedule` etc. fail in both states).
   - Active: `keys` contains `push` and `pull_request`, and the marker is
     absent.
   - Paused: `keys` is exactly `[workflow_dispatch]`, `commented` contains
     `push` and `pull_request`, and the marker is present.
   - Exactly one of the two holds; the failure message names the state it
     expected.
   - Keep, unchanged: `not.toContain('pull_request_target')`,
     `permissions: contents: read`, `not.toContain('secrets.')`, and every
     other test in the block.
   - Rename the test to "runs on push and pull_request, or is explicitly
     paused (#54), with a read-only token and no secrets".
   Put the parser in the test file (a local function, like `isIgnored`); no
   new dependency, no YAML library.
3. `RELEASING.md` step 2, in the paragraph after the block: one or two
   sentences saying `pnpm test` includes the workflow check, which accepts
   the paused state of ADR 0018, and that while `ci.yml` is paused the step 2
   build container is the only full CI run of the release commit (so it must
   finish green; there is no GitHub check to fall back on).
4. `docs/conventions.md`: CI row (or a line below the table) notes the
   paused state and links ADR 0018 once accepted.

### If the user picks A instead

- `ci.yml`: restore the triggers in this order, so the existing regex
  matches: `on:` / `push:` / `pull_request:` / `workflow_dispatch:` (just
  uncommenting would put `workflow_dispatch` first and still fail).
- `repo-hygiene.test.ts`: no change needed. Optional: same allowlist check
  without the paused state.
- `RELEASING.md`: no change required; add one sentence under "Known
  limits" that GitHub checks are red while Actions is billing-blocked and the
  step 2 container is the CI of record.
- Chunks: 1 `docs(adr): accept 0018 ...`, 2 `ci: restore push and
  pull_request triggers`, 3 docs chunk.

### Alternatives rejected

C (env flag) depends on who runs the test and is a silent skip (AC1). D
(`if: vars.CI_ENABLED`) changes workflow behaviour, adds security surface,
is unverified under a billing lock, and turns "CI off" into a green-looking
"skipped". Details in ADR 0018.

## Files to change (option B)

| File | Change |
| --- | --- |
| `docs/decisions/0018-ci-workflow-while-actions-is-blocked.md` | Status to Accepted with the user's choice (chunk 1) |
| `docs/conventions.md` | CI row: paused state, link ADR 0018 (chunk 1) |
| `.github/workflows/ci.yml` | Marker comment above `on:`; nothing else |
| `apps/sync-server/test/repo-hygiene.test.ts` | Trigger assertion becomes the two-state allowlist check |
| `RELEASING.md` | Step 2 note on the paused workflow |

## Contracts, data model, Docker

- Data model changes: none. Contracts: none.
- Docker impact: none (the release and CI containers are unchanged).
- No changeset: no published package changes.

## Docs impact

`RELEASING.md` (step 2 note), `docs/conventions.md` (CI row), ADR 0018.

## Risks / edge cases

- The parser must stop at the end of the `on:` block, so `push:` or
  `# push:` elsewhere (step names, comments) cannot satisfy it. Stop at the
  first line that is non-empty and does not start with two spaces.
- Marker drift: a resume that leaves the marker fails (active + marker), and
  a pause without the marker fails. Both are wanted.
- Prettier checks YAML (`pnpm lint`); the comment must stay as formatted.
- Resuming later is a one-commit change to `ci.yml` only; the test needs no
  edit then.

## Security-sensitive areas

Security-sensitive: no

The workflow change is a comment only: triggers, permissions, secrets usage
and pinned actions are unchanged. The test keeps every security assertion of
the CI block (no `pull_request_target`, `contents: read`, no `secrets.`,
SHA-pinned actions) and tightens the trigger check to an allowlist. No
endpoint, data, dependency or credential is touched. If the user picks D,
this becomes `yes` (new `vars` context and changed job behaviour).

## Implementer model

Implementer model: opus
Reason: an ADR is open at plan time (rule); once the user decides, the work
is three small files following the existing pattern in
`apps/sync-server/test/repo-hygiene.test.ts`, so Sonnet would also suffice.

## Test plan

| AC | Check |
| --- | --- |
| AC1 `pnpm test` passes on main | Full `pnpm test` in local Docker CI: node:24 + redis:7.2.17-alpine on a private network, a fresh clone with `.git` copied in, no bind mounts, `CI=true` and `SYNC_TEST_REDIS_URL` set; repo-hygiene 35/35 |
| AC2 restored triggers pass | Temporarily, in the container only (not committed): uncomment `push:`/`pull_request:` and remove the marker in `ci.yml`, run `vitest run test/repo-hygiene.test.ts`: passes |
| AC3 still guards the workflow | Same temporary edits, each must fail the test: add `pull_request_target:`; add `schedule:`; paused triggers without the marker; active triggers with the marker left in; `workflow_dispatch` only with `# push:` removed; `contents: write`; a `secrets.` reference |
| AC4 dry run of steps 1-2 | `RELEASING.md` "Dry run (QA)" setup plus the step 2 block with `MODE=dry-run` on the branch: completes, prints the three integrity lines (step 1 is not run in a dry run: no tag) |
| Regressions | `pnpm lint` (Prettier on `ci.yml` and docs, link check), `pnpm typecheck` |

GitHub Actions stays unavailable, so there is no CI check on the PR; QA runs
the above locally.

## Implementation chunks

1. `docs(adr): accept 0018 ci workflow while actions is blocked` (ADR status
   and the user's choice, `docs/conventions.md` CI row)
2. `ci: mark the paused workflow triggers for #54` (`ci.yml` marker only;
   the trigger test still fails on this commit, exactly as on `main`)
3. `test(server): accept the documented ci pause in the workflow check`
   (`repo-hygiene.test.ts`; `pnpm test` is green from this commit on)
4. `docs(release): note the paused ci workflow at step 2` (`RELEASING.md`)

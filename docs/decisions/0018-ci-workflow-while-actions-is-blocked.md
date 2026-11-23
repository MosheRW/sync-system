# 0018. CI workflow triggers while GitHub Actions is blocked

- Status: Accepted (Gate 2, 2026-11-23: user chose the recommended B)
- Date: 2026-11-23
- Issue: #54

## Context

GitHub Actions is billing-blocked for this repository: runs fail in about
three seconds because no job is ever started. On 2026-11-22 the maintainer
committed `80ec2c7 Update ci.yml` directly to `main` (GitHub web editor, no
PR), which changed the workflow's triggers from

```yaml
on:
  push:
  pull_request:
```

to

```yaml
on:
  workflow_dispatch:
  # push:
  # pull_request:
```

`apps/sync-server/test/repo-hygiene.test.ts`, test "runs on push and
pull_request with a read-only token and no secrets" (`CI workflow (AC28, L1,
L8)`), asserts `/^on:\n {2}push:\n {2}pull_request:/m` and has failed on
every branch since. It is the only failing assertion (34 of 35 tests in the
file pass). Because `RELEASING.md` step 2 runs `pnpm test` under
`set -euo pipefail`, the build container stops there, so the 1.0.0 release
and its dry run cannot complete as written.

CI is meanwhile run by hand in local Docker (node:24, pinned
redis:7.2.17-alpine on a private network, a fresh clone with `.git`, no bind
mounts); the `RELEASING.md` step 2 block is the same kind of run.

Constraints: the test must keep guarding the workflow (spec AC3: no
`pull_request_target`, read-only token, no secrets, pinned actions, every
check); nothing may be silently skipped (AC1); billing itself is out of
scope.

## Options

### A. Restore the `push` and `pull_request` triggers

Uncomment both lines (keeping `workflow_dispatch:` after them); the test
stays as it is.

- Pros: one-line change; the test and the workflow return to their
  original, simplest form; CI starts working again the moment billing is
  fixed, with nothing to remember.
- Cons: until billing is fixed, every push and every PR queues runs that
  fail in seconds, so every PR and every commit on `main` shows a red check.
  Red becomes "normal", which hides a real failure once Actions works again,
  and it reverses a change the maintainer made deliberately. Reviewers
  (QA, the user) must keep reading "red = billing" from STATE.md notes.

### B. Keep the pause, make it an explicit, documented state the test accepts (recommended)

The workflow keeps `workflow_dispatch:` with the two commented lines and
gains a fixed header comment that marks the pause, names #54 and says how to
resume. The test accepts exactly two trigger states and nothing else:

1. **Active:** the `on:` block's keys are `push` and `pull_request`, plus
   optionally `workflow_dispatch`; the pause marker is absent.
2. **Paused:** the only key is `workflow_dispatch`, the block also contains
   `# push:` and `# pull_request:` (so resuming is uncommenting), and the
   pause marker is present.

Any other key (`pull_request_target`, `workflow_run`, `schedule`, ...) fails
in both states. The other assertions (read-only token, no secrets, pinned
SHAs, Redis, compose, step order) run unchanged in both states.
`RELEASING.md` says, at step 2, that while the workflow is paused the step 2
build container is the only full CI run of the release commit.

- Pros: `pnpm test` passes on `main` today and after resuming, with no
  environment flag; the state is visible in the repo and in the diff that
  changes it; no red checks; the guard is stricter than today (an explicit
  allowlist of trigger keys instead of a prefix match); a stale marker after
  resuming fails the test.
- Cons: a small amount of extra test logic; someone has to remember to
  resume CI after billing is fixed (the marker and the RELEASING note are
  the reminder, and the test forces the marker to go when the triggers
  return).

### C. Gate the trigger assertion behind an environment variable

For example `SYNC_CI_PAUSED=1` skips the trigger assertion, and
`RELEASING.md` step 2 sets it.

- Pros: smallest test change.
- Cons: the pass depends on who runs the test, not on the repo; the flag
  would stay in the release block after CI resumes; a skipped assertion is
  exactly the "silently skipped" case AC1 rules out. Rejected.

### D. Restore the triggers, gate the jobs on a repository variable

`push` and `pull_request` come back and each job gets
`if: vars.CI_ENABLED == 'true'`; resuming means setting the variable in the
repo settings, without a commit.

- Pros: no commit needed to resume; skipped jobs show grey, not red.
- Cons: changes the workflow's behaviour (a new `vars` context, a new
  security review surface); it is not verified that a billing-locked account
  marks `if`-skipped jobs as skipped rather than failing the run; a "skipped"
  check looks like success, so CI could stay off unnoticed after billing is
  fixed, and the switch lives in settings, outside git and outside the test.
  Rejected.

## Decision

**B** (accepted at Gate 2, 2026-11-23, by the user). The workflow keeps
the pause and gains the `# CI paused (#54):` header comment; the test
accepts exactly the active or the marked paused state, with the trigger
allowlist; `RELEASING.md` step 2 notes the paused state.

Recommended at plan time: **B**. It makes `pnpm test` and `RELEASING.md` step 2 pass
without a workaround or a skip, records the pause where it actually is (in
the workflow file, checked by the test), keeps every security assertion of
the workflow and tightens the trigger check, and avoids weeks of red checks.
A is the better choice only if the user expects billing to be fixed within
days.

## Consequences

- `.github/workflows/ci.yml` gets a header comment (marker) and no other
  change; `repo-hygiene.test.ts` parses the `on:` block and accepts the two
  states; `RELEASING.md` step 2 notes the paused state.
- To resume CI: uncomment `push:` and `pull_request:` and delete the marker
  in one commit; the test then checks the active state.
- `docs/conventions.md` CI row records that GitHub CI may be paused and that
  the pause is the marked state from this ADR.

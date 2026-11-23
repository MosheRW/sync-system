# Spec: #51 fix(docs): operator guide passes TOKEN_SECRET with docker run -e

Issue: https://github.com/MosheRW/sync-system/issues/51 (follow-up to #37, PR #50; source: security code review, low finding 2). Path: fast.

## Problem

`docs/operator-guide.md:164` passes `TOKEN_SECRET` with `docker run -e`. The value is readable by anyone with Docker access through `docker inspect` and shows in shell history.

## Acceptance criteria

- [ ] The operator guide no longer shows `TOKEN_SECRET` passed with `-e VALUE` on the command line.
- [ ] The guide recommends `--env-file` (file mode 600) and a compose or Swarm secret as alternatives.
- [ ] The guide notes that `docker inspect` exposes `-e` values.
- [ ] Existing docs tests still pass.

## Out of scope

- Changing how the server reads its configuration.

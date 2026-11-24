# Spec: read secrets from files via `_FILE` variables (#58)

Issue: https://github.com/MosheRW/sync-system/issues/58 (follow-up to #51, PR #57)
Path: full. Type: feat. Security-sensitive: yes.

## Problem / motivation
The server reads `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS` and `REDIS_URL` from
environment variables only. `TOKEN_SECRET_FILE` and `REDIS_URL_FILE` are today
a Config error (unknown names in the `TOKEN_` / `REDIS_` families, ADR 0015).
A compose or Swarm secret therefore needs an `sh` wrapper that overrides the
image CMD and copies the file into the environment, where `docker exec` and the
process environment can see it again. This defeats the point of a secret file.

## User stories
- As an operator using compose or Swarm secrets, I want to point
  `TOKEN_SECRET_FILE` at `/run/secrets/...`, so that I need no wrapper and the
  secret never enters the process environment.
- As an operator rotating the token secret, I want `TOKEN_SECRET_PREVIOUS_FILE`,
  so that rotation works with secret files too.
- As an operator with a Redis password in the URL, I want `REDIS_URL_FILE`, so
  that the password stays out of `docker inspect` and `compose config`.
- As an operator who sets both forms by mistake, I want a clear startup error
  naming both variables, so that I never run on a secret I did not intend.

## Acceptance criteria
- [ ] AC1: `TOKEN_SECRET_FILE`, `TOKEN_SECRET_PREVIOUS_FILE` and `REDIS_URL_FILE`
  are known variables; each reads the value of `TOKEN_SECRET`,
  `TOKEN_SECRET_PREVIOUS` and `REDIS_URL` respectively from the file at the
  given path.
- [ ] AC2: A value read from a file goes through exactly the same validation as
  the same value from the environment (length, weakness, public example/dev
  secret rules, `PREVIOUS` must differ from current, Redis URL parsing).
- [ ] AC3: Setting both `X` and `X_FILE` (even if one is an empty string) is a
  Config error naming both variables, never a value; startup fails closed.
- [ ] AC4: A `_FILE` path that does not exist, is not readable, is a directory
  or not a regular file, or whose content is empty is a Config error naming the
  variable (and the path is allowed in the message; the content never is).
- [ ] AC5: An empty `X_FILE` variable (set to `""`) is a Config error, not
  treated as unset.
- [ ] AC6: Trailing-newline handling is defined (see Q1) and covered by tests:
  one single trailing line terminator is removed; no other whitespace
  (leading or trailing spaces, tabs, additional newlines) is trimmed, so the
  existing "must not start or end with whitespace" check still fires for them.
- [ ] AC7: A secret value, or any part of file content, never appears in logs,
  Config error messages, thrown error text or `toJSON`/`inspect` output.
  Tested with a sentinel value on every failure and success path.
- [ ] AC8: Error reporting stays "all problems in one run, exit 1", and the
  variable names in messages follow ADR 0015 rules (names only).
- [ ] AC9: When `TOKEN_SECRET_FILE` is used, the startup log source for the
  token secret is distinguishable from `env` only if that adds no new leak
  (see Q5); the existing `token_secret_previous_set` and random/dev warnings
  keep working.
- [ ] AC10: ADR 0015 is amended (its "Known variables / families" scope) or
  superseded by a new ADR, recording that the three `_FILE` names are known
  variables and that other unknown `_FILE` names (e.g. `MAX_X_FILE`) are still
  flagged. The known-variables list, the README environment table and the
  drift/coverage tests are updated accordingly.
- [ ] AC11: `docs/operator-guide.md` "Passing secrets to the container" and the
  compose secret-file example drop the `sh` wrapper and the "planned in #58"
  text, and use `_FILE` variables with `/run/secrets/<name>`. The env-variable
  table documents the three new variables, the both-set error and the newline
  rule. README environment table is updated if it lists these variables.
- [ ] AC12: Automated tests cover: each of the three variables read from a file;
  both-set conflict for each of the three; missing, unreadable, directory and
  empty file; empty `_FILE` value; newline rules (`\n` stripped, `\r\n` per Q1,
  interior and leading whitespace preserved/rejected); non-leak (AC7); at least
  one end-to-end test that spawns the server with `TOKEN_SECRET_FILE`.
- [ ] AC13: Behavior with only `X` set (no `_FILE`) is unchanged; all existing
  tests pass.

## Out of scope
- #59 operator-guide secret check in `repo-hygiene.test.ts`.
- #60 Swarm guidance.
- #56 repo-hygiene `ci.yml` checks.
- `docs/roadmap.md` updates.
- `_FILE` support for any variable other than the three listed (e.g. API keys,
  other apps' config), and for the reader app.
- Hot reload of secret files; files are read once at startup.
- Secret rotation tooling.

## Open questions
- Q1: Strip exactly one trailing `\n`, or also one trailing `\r\n`? (Proposed:
  strip a single trailing `\n` or `\r\n`, nothing else; tests for both.)
- Q2: If the file contains only a newline, it is empty after the strip: treat
  as the empty-file Config error? (Proposed: yes.)
- Q3: Maximum file size? (Proposed: cap at a small limit such as 4 KiB, and
  Config error above it, so a wrong path such as a large file or device cannot
  be read into memory.)
- Q4: Precedence is fixed as "both set is an error", per the issue. Confirm
  that a set-but-empty `X` plus `X_FILE` is also a conflict (AC3 assumes yes).
- Q5: Should the startup log or `TokenSecrets.source` expose `file` as a source
  value? (Proposed: add `file` only if it needs no extra log field; value never.)
- Q6: Should file paths appear in error messages? (Proposed: yes, paths are not
  secrets; content never.)
- Q7: Must the file be checked for permissions (e.g. warn on world-readable)?
  (Proposed: no, out of scope; the operator guide already gives mode 400.)
- Q8: ADR route: amend 0015 in place or write a new ADR superseding the
  relevant part? (Architect to recommend; user decides at Gate 2.)

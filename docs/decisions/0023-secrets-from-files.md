# 0023. Reading secrets from files (`_FILE` variables)

- Status: Accepted (Gate 2, 2026-11-25: user chose the recommended option 1,
  with the narrowed path rule below and the security controls C1–C11 of
  [`docs/issues/58/security.md`](../issues/58/security.md))
- Date: 2026-11-24
- Issue: #58

## Context

The sync server reads `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS` and `REDIS_URL`
from the environment only. Compose and Swarm secrets are files mounted at
`/run/secrets/<name>`, so today the operator guide needs an `sh` wrapper
that overrides the image `CMD` and copies the file back into the process
environment, where `docker exec` and `/proc/<pid>/environ` show it again.
Under [ADR 0015](0015-unknown-environment-variables.md),
`TOKEN_SECRET_FILE` and `REDIS_URL_FILE` are unknown names in the `TOKEN_`
and `REDIS_` families and stop startup.

The behaviour of the `_FILE` variables was fixed at Gate 1 of #58:

- `X_FILE` holds a path; the server reads the value of `X` from that file
  once, at startup. Three names only: `TOKEN_SECRET_FILE`,
  `TOKEN_SECRET_PREVIOUS_FILE`, `REDIS_URL_FILE`.
- Setting both `X` and `X_FILE` is a `Config error` naming both, even when
  either one is set to an empty string. Startup fails closed.
- `X_FILE=""` is a `Config error`, not "unset".
- Exactly one trailing line terminator (`\n` or `\r\n`) is removed; nothing
  else is trimmed. A file that is empty after that is a `Config error`.
- A file larger than 4 KiB is a `Config error`; it is never read whole.
- The value from the file goes through exactly the same checks as the same
  value from the environment.
- Messages name variables; file content is never printed. The path
  (sanitized, control characters replaced, cut at 64 characters) is printed
  only for an entry that exists: not for "does not exist" (`ENOENT`,
  `ENOTDIR`) and not for an unknown error, so a secret pasted into `X_FILE`
  by mistake is never echoed (Gate 2 narrowing of Gate 1 Q6).
  The token-secret source `file` may be logged; the value and path never.
- A value from `REDIS_URL_FILE` keeps the URL parser's lenient handling of
  leading and trailing whitespace, exactly like `REDIS_URL` from the
  environment (Gate 2).
- No permission check on the file (the operator guide gives mode 400).

What was left open at Gate 1 was only **how this is recorded** against ADR 0015 (Q8).
ADR 0015's rule is the family list; it is not changed by #58: no prefix is
added or removed, the three names simply become known variables, and
other unknown `_FILE` names in a family (for example `MAX_X_FILE`,
`REDIS_PASSWORD_FILE`) are still flagged. ADR 0015's own Consequences say
"Adding a variable means adding it here [`known-vars.ts`]; a new family
prefix means updating this ADR."

## Options

1. **New ADR 0023 for the `_FILE` mechanism; ADR 0015 unchanged except a
   "Related" link.**
   - Pros: ADR 0015 stays as accepted (the docs-conventions rule: never edit
     an accepted decision); the `_FILE` contract (conflict rule, newline
     rule, size cap, message and log rules) is a decision of its own and
     gets its own record, findable by name; `conventions.md` gets one new
     row pointing here.
   - Cons: two ADRs to read for "which env names are accepted"; the link
     line in 0015 is a (non-decision) edit of an accepted ADR.
2. **Amend ADR 0015 in place** (an "Amendment, #58" section listing the
   three names and the `_FILE` rules).
   - Pros: one place for every env-name rule.
   - Cons: edits an accepted ADR, against the docs-conventions rule; mixes
     two unrelated decisions (name families vs. reading secret files) in
     one record; the `_FILE` rules are not about unknown names at all.
3. **New ADR superseding ADR 0015** (restates the family rule plus the
   `_FILE` rules; 0015 becomes `Superseded by 0023`).
   - Pros: follows the convention strictly; one current record.
   - Cons: rewrites a rule that did not change; the reader also cites 0015
     (`READER_` family) and every link to 0015 in the docs and code comments
     would point at a superseded record; most churn for no change in rule.

## Decision

Option 1 (chosen by the user at Gate 2 of #58). The `_FILE`
behaviour above is the decision recorded here. ADR 0015's rule stays as it
is; only its known list in `apps/sync-server/src/config/known-vars.ts` grows
by three names, which 0015 already allows, and 0015 gets one line
`- Related: [0023](0023-secrets-from-files.md) (secret files, #58)` under its
header. Its Decision and Consequences are not edited.

## Consequences

- `apps/sync-server/src/config/secret-file.ts` is the only code that reads a
  secret file; token secrets and Redis settings both use it, so the rules
  hold identically for the three variables.
- The operator guide drops the `sh` wrapper: compose sets
  `TOKEN_SECRET_FILE: /run/secrets/<name>` and keeps the image `CMD`. The
  secret is no longer in the process environment, `docker inspect` or
  `docker compose config`; it stays readable in the mounted file by anyone
  who can `docker exec` as the `node` user or root.
- Upgrade note: deployments that use the wrapper keep working unchanged;
  `TOKEN_SECRET_FILE` / `TOKEN_SECRET_PREVIOUS_FILE` / `REDIS_URL_FILE` no
  longer stop startup as unknown names.
- Adding `_FILE` support to any other variable is a new decision (an
  amendment of this ADR's list, with its own issue).
- Files are read once at startup: a changed secret file needs a restart,
  exactly like a changed environment variable.

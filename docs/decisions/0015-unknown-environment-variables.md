# 0015. Which unknown environment variables stop startup

- Status: Accepted
- Date: 2026-11-15
- Issue: #36
- Related: [0023](0023-secrets-from-files.md) (secret files, #58)

## Context

Gate 1 of #36 (Q20, AC37a): a set environment variable that "looks like"
a sync server setting but is not one (the typo `MAX_GROUP_SIZE_CIELING`)
must be a `Config error` naming the variable, never its value, reported
with every other problem in one run, exit 1. There is no escape-hatch
switch (AC41). This ADR fixes what "looks like" means: the naming rule.

Constraints:

- The server's 30 variables have no common prefix. Most start with `MAX_`,
  `TOKEN_`, `REDIS_`, end in `_CEILING`, or are generic (`PORT`, `HOST`,
  `LOG_LEVEL`, `NODE_ENV`). Renaming them is out (AC41: every known
  variable keeps working).
- The rule must not flag anything set by the repo's compose files,
  Dockerfiles and CI, or by the runtime. Measured in the repo today:
  - compose (`compose*.yaml`, sync-server services): only known variables.
  - Dockerfiles: `NODE_ENV` only.
  - CI (`ci.yml`) and the local Docker CI: `CI`, `SYNC_TEST_REDIS_URL`,
    `SYNC_TEST_STORE`. Five server tests spawn the server with
    `...process.env`, so these reach the real check.
  - `node:24-alpine`: `NODE_VERSION`, `YARN_VERSION`, `PATH`, `HOME`,
    `HOSTNAME`. pnpm/npm: lower-case `npm_*`. Vitest: `VITEST*`, `TEST`.
  - Platforms the docs point at: Kubernetes injects service links for every
    service in the namespace (`REDIS_SERVICE_HOST`, `REDIS_SERVICE_PORT`,
    `REDIS_PORT`, `REDIS_PORT_6379_TCP`, `..._TCP_ADDR|PORT|PROTO`), and a
    service named `sync` gives `SYNC_PORT...`. Docker legacy `--link` gives
    `<ALIAS>_PORT...`, `<ALIAS>_NAME`, `<ALIAS>_ENV_*`.
- A message prints the variable's name only. Names are not secrets; values
  can be.

## Options

1. **Families of the server's own names, minus platform-shaped names.**
   A name is checked when it is upper or lower case `[A-Za-z][A-Za-z0-9_]*`
   and, compared in upper case, starts with one of `MAX_`, `TOKEN_`,
   `REDIS_`, `SYNC_`, `JOIN_`, `QR_`, `APPROVAL_`, `DISCONNECT_`,
   `KEEP_ALIVE_`, `INACTIVITY_`, or ends with `_CEILING`. It is never
   flagged when it is a known variable, starts with `SYNC_TEST_` (the
   repo's test harness), or ends like a platform link:
   `_SERVICE_HOST`, `_SERVICE_PORT`, `_SERVICE_PORT_*`, `_PORT`,
   `_PORT_<n>_TCP|UDP|SCTP` (optionally `_ADDR|_PORT|_PROTO`), `_NAME`,
   `_ENV_*`.
   - Pros: covers 26 of the 30 names (all but `PORT`, `HOST`, `LOG_LEVEL`,
     `NODE_ENV`), so it catches typos in every server-specific name and
     look-alikes such as
     `REDIS_PASSWORD` or `MAX_GROUP_SIZE` that the server would silently
     ignore; deterministic and easy to document; no false positive in any
     setup listed above.
   - Cons: a generic name (`PORT`, `HOST`, `LOG_LEVEL`) mistyped as
     `PROT` or `LOG_LEVLE` is not caught (no family); a platform-shaped
     typo (`REDIS_PORT`) is let through; an operator who keeps a helper
     variable such as `REDIS_PASSWORD` for Kubernetes `$(VAR)`
     interpolation must rename it outside the families (for example
     `PW_REDIS`).
2. **Option 1 narrowed to `MAX_`, `REDIS_`, `TOKEN_` and `_CEILING`.**
   - Pros: smallest surface, fewer surprises for operators.
   - Cons: covers 24 of the 30; misses typos of `SYNC_CONFIG_PATH` and
     `JOIN_METHODS_ALLOWED`, and of the five non-`MAX_` ceilings when the
     suffix is the mistyped part (`QR_TICKET_SECONDS_CEILNG`); little gain,
     since none of the extra prefixes collides with anything measured.
3. **Similarity to the known names (edit distance) over all variables.**
   - Pros: catches `PROT` and `LOG_LEVLE`.
   - Cons: false positives on unrelated runtime names (`HOME` is two edits
     from `HOST`); misses look-alikes with larger edits
     (`MAX_GROUP_SIZE`); the rule cannot be stated simply in the docs.

## Decision

Option 1, accepted by the user at Gate 2 of #36 (2026-11-15, Q-1). Each
flagged name gives one problem line:

- `<NAME> is not a sync server variable; did you mean <KNOWN>?` when a known
  name is within 2 edits (Damerau-Levenshtein, case-insensitive), else
- `<NAME> is not a sync server variable; remove it or fix the name (see "Environment variables" in README.md)`.

Names longer than 48 characters are cut to 48 plus `...` (the longest
known name has 36; the security plan review, L4, asked for a cut shorter
than the 64 first proposed). Lines are sorted by name, so the output is
stable.

The reader applies the same rule with the single family `READER_` and the
same platform-shaped exclusions (Gate 2 Q-2: accepted).

## Consequences

- One list of known server variables (`apps/sync-server/src/config/known-vars.ts`)
  feeds the parser, the check, a README drift test and the AC37 coverage test.
  Adding a variable means adding it there; a new family prefix means
  updating this ADR.
- Upgrade note: a deployment that sets an unknown name in a family now fails
  to start, with the name in the error. There is no switch to turn this off.
- Tests that spawn the server pass the parent environment through a helper
  that drops family names, so a developer's shell cannot break them.
- Not caught: typos of the generic names, and platform-shaped names. Both
  are listed in the startup-error docs.

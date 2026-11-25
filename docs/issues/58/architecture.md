# Architecture: read secrets from files via `_FILE` variables (#58)

Spec: [`spec.md`](spec.md). Path: full. Branch: `feat/58-secret-files`.
Gate 1 answers (user): Q1 strip exactly one `\n` or `\r\n`; Q2 a file with
only a terminator is "empty"; Q3 cap 4 KiB; Q4 set-but-empty `X` plus
`X_FILE` is a conflict; Q5 log `file` as the token-secret source; Q6 paths
may appear in messages, content never; Q7 no permission check; Q8 ADR route
is decided at Gate 2 (see Decisions).

## 1. Repo layout

- Layout: **monorepo** (pnpm workspaces `apps/*`, `packages/*`; no
  submodules, no `turbo`/`nx`).
- Touched package: `apps/sync-server` only (`pnpm --filter
  @mosherw/sync-system-server test | typecheck`), plus root docs
  (`docs/operator-guide.md`, `docs/startup-errors.md`, `docs/conventions.md`,
  `docs/decisions/`). Root checks: `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm format:check` if present (Prettier formats the Markdown
  tables).
- The reader app, the protocol package and other repos: not touched. No
  linked issue needed.
- README.md has no environment table (checked); nothing to update there.

## 2. Decisions

- **[ADR 0023](../../decisions/0023-secrets-from-files.md) (Proposed):
  how to record the `_FILE` rules against ADR 0015 (Q8).**
  Options: (1) new ADR 0023 for the `_FILE` mechanism, ADR 0015 unchanged
  except one "Related" link line; (2) amend ADR 0015 in place; (3) a new
  ADR superseding 0015. **Recommendation: option 1.** Trade-off: one more
  record to read vs. not editing an accepted decision and not churning
  every link to 0015 for a family rule that does not change.
- Refinement of Q6 for the user to confirm at Gate 2 (security, see 9.2):
  the path is printed only when it names an existing file system entry.

## 3. Approach

One small module, `src/config/secret-file.ts`, resolves a secret variable
from either source. The two existing collectors call it instead of reading
`env.X` directly:

```
collectTokenSecrets ──► resolveSecret(env, 'TOKEN_SECRET', problems)
                    └─► resolveSecret(env, 'TOKEN_SECRET_PREVIOUS', problems)
collectRedisSettings ─► resolveSecret(env, 'REDIS_URL', problems)
```

`resolveSecret` returns a discriminated union:

```ts
type SecretVariable = 'TOKEN_SECRET' | 'TOKEN_SECRET_PREVIOUS' | 'REDIS_URL';
type ResolvedSecret =
  | { kind: 'unset' }                       // neither X nor X_FILE set
  | { kind: 'invalid' }                     // a problem was pushed; never fall back
  | { kind: 'set'; value: string; from: 'env' | 'file'; label: string };
```

- `label` is what validation messages print: `X` for env, `X (from X_FILE)`
  for a file (e.g. `TOKEN_SECRET (from TOKEN_SECRET_FILE) must be at least
  32 bytes ...`). Names only.
- Order of checks (each stops at the first problem for that variable):
  1. `X !== undefined && X_FILE !== undefined` → conflict (Q4: even if
     either is `""`). The file is not opened.
  2. `X_FILE === ''` → `X_FILE must not be empty`.
  3. `X_FILE` set → read the file (3.1). `X` set → `{ from: 'env' }`
     exactly as today. Neither → `unset`.
- Since the collectors are the only consumers, `parseEnv`, `parseRedisSettings`,
  `parseTokenSecrets` and `loadConfig` get the behaviour for free; "all
  problems in one run, exit 1" is unchanged (problems go to the same array).
- `loadConfig` calls `collectEnv` (which calls `collectRedisSettings`) once,
  so each file is read once per startup.

### 3.1 Reading the file (`readSecretFile`)

Synchronous (startup is synchronous today), with an injectable `fs`
subset (`openSync`, `fstatSync`, `readSync`, `closeSync`) so errno mapping
is unit-testable on every OS:

1. `openSync(path, O_RDONLY | (O_NONBLOCK ?? 0))`. `O_NONBLOCK` keeps a
   FIFO from blocking startup; it is undefined on Windows, hence `?? 0`.
   Symlinks are followed (Kubernetes secret volumes are symlinks).
2. `fstatSync(fd)` on the open descriptor (no stat-then-open race):
   `!isFile()` → "not a regular file"; `size > MAX_SECRET_FILE_BYTES` →
   "larger than 4096 bytes".
3. Read into a buffer of `MAX + 1` bytes in a loop until EOF or full; more
   than `MAX` bytes → "larger" (size can lie, e.g. on special mounts).
4. `closeSync` in `finally`.
5. Decode with `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`:
   invalid UTF-8 → error; a BOM is kept (not silently stripped), so for a
   token secret the whitespace rule reports it (`trim()` removes U+FEFF).
6. A NUL character → error (an env value cannot contain NUL, so this keeps
   both sources' value domains identical).
7. `stripOneTerminator`: remove one trailing `\r\n`, else one trailing
   `\n`; nothing else (Q1). Empty result → "is empty" (Q2).
8. The buffer is `fill(0)`'d after decoding (best effort; the string copy
   lives on, like an env value).

Errno mapping: `ENOENT`, `ENOTDIR` → does not exist; `EACCES`, `EPERM` →
not readable; `EISDIR` → not a regular file; anything else → `cannot be
read (<code>)` with `<code>` only if it matches `/^E[A-Z0-9]+$/`, else
`unknown`. `err.message` (which contains the path) is never used.

### 3.2 Token secrets (`token-secret.ts`)

- `checkSecret(label, ...)` unchanged except it receives the label.
- `TokenSecrets.source`: `'env' | 'file' | 'dev' | 'random'`. `file` when
  `TOKEN_SECRET` came from `TOKEN_SECRET_FILE` and is not the dev secret.
- `random` only when `TOKEN_SECRET` is `unset` (never after `invalid`), so a
  bad `TOKEN_SECRET_FILE` in development fails closed, not silently random.
- `PREVIOUS must differ`: compares resolved values regardless of source;
  the message stays `TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET`.
- `warnAboutSecrets` (logger type gains `info`): new info line
  `{ event: 'token_secret_source', source }` with `source` one of
  `env | file | dev | random`, logged for every start (Q5). No path, no
  value, no length. Existing `token_secret_random`, `dev_token_secret`,
  `token_secret_previous_set` warnings are unchanged.

### 3.3 Redis (`redis.ts`)

- `collectRedisSettings` resolves `REDIS_URL` via `resolveSecret`.
- `parseUrl(raw, label, nodeEnv, errors)`: every message is built with the
  label (`REDIS_URL` or `REDIS_URL (from REDIS_URL_FILE)`), so env-only
  output is byte-identical to today (AC13).
- `REDIS_URL must not be empty` stays the env-only message; an empty file
  is the reader's "is empty".
- Known, unchanged behaviour (both sources): WHATWG `URL` drops leading /
  trailing C0 controls and spaces and inner tabs/newlines. Not changed here
  (AC2/AC13 parity); listed in Risks.

### 3.4 Known variables (`known-vars.ts`)

Add `TOKEN_SECRET_FILE`, `TOKEN_SECRET_PREVIOUS_FILE`, `REDIS_URL_FILE`
(37 names). Families unchanged; unknown `_FILE` names in a family
(`MAX_X_FILE`, `REDIS_PASSWORD_FILE`, `TOKEN_SECRET_FILES`) are still
flagged, `TOKEN_SECRET_FIEL` gets "did you mean TOKEN_SECRET_FILE?".
`_FILE` names outside the families (`PORT_FILE`) are not flagged (ADR 0015's
existing limit).

### Alternatives rejected

- **Pre-resolve into a copied env object** (`{ ...env, TOKEN_SECRET:
  fileValue }`) before `loadConfig`: smallest diff, but messages would name
  `TOKEN_SECRET` for a file value, the `file` source is lost, and the
  conflict check has to run before every other collector. Rejected.
- **Async `fs/promises` read**: `loadConfig` is synchronous and called from
  many tests; no benefit for three tiny files at startup. Rejected.
- **`readFileSync` + `statSync`**: stat-then-read race, reads unbounded
  data from a wrong path (`/dev/zero`), blocks on a FIFO. Rejected.
- **Generic `_FILE` for every variable**: out of scope (spec).

## 4. Files to create / modify

Product code (`apps/sync-server/src/config/`):

| File | Change |
|---|---|
| `secret-file.ts` (new) | `SECRET_FILE_VARIABLES`, `MAX_SECRET_FILE_BYTES = 4096`, `SECRET_FILE_MESSAGES` (message builders), `stripOneTerminator`, `readSecretFile`, `resolveSecret`. |
| `token-secret.ts` | Use `resolveSecret`; label in messages; `source` gains `file`; `random` only for `unset`; `warnAboutSecrets` logs `token_secret_source`. |
| `redis.ts` | Use `resolveSecret` for `REDIS_URL`; `parseUrl` takes the label. |
| `known-vars.ts` | Three new known names. |
| `config-error.ts` | Doc comment only: "file content" joins the never-printed list. |

Tests (`apps/sync-server/test/`):

| File | Change |
|---|---|
| `secret-file.test.ts` (new) | Unit tests of reader and resolver (section 8). |
| `token-secret.test.ts` | File source, `source: 'file'`, dev secret from file, fail-closed in dev, previous from file, mixed sources. |
| `redis-config.test.ts` | `REDIS_URL_FILE` valid/invalid, label in messages. |
| `config-cases.ts` | `ConfigCase.files?: Record<string, SecretFileSpec>` (content, `directory`, `missing`), written by `materialize` into the case dir and set as the variable's path; `<file>` placeholder in `problems`. ENV_CASES for each `_FILE` variable; `VALID_VALUES` entries (paths of valid files created at module load). |
| `config-matrix.test.ts` | Valid-values loop drops the base variable `X` when testing `X_FILE` (else it is a conflict). |
| `env-reference.test.ts` | Expected defaults: the three `_FILE` names `unset`. |
| `unknown-vars.test.ts` | Length 34 → 37; still-flagged `_FILE` look-alikes; "did you mean". |
| `startup-errors-doc.test.ts` | Add `SECRET_FILE_MESSAGES` lines that no portable case can trigger (not readable, other errno) to the printed set, like `STARTUP_MESSAGES`. |
| `main.test.ts` | End-to-end spawns (section 8). |

Docs: see section 7.

## 5. Contracts

No API, protocol or realtime message changes. The contract is config.

### 5.1 Variables

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_SECRET_FILE` | unset | Path of a file holding `TOKEN_SECRET`. |
| `TOKEN_SECRET_PREVIOUS_FILE` | unset | Path of a file holding `TOKEN_SECRET_PREVIOUS`. |
| `REDIS_URL_FILE` | unset | Path of a file holding `REDIS_URL`. |

Relative paths resolve against the working directory (like
`SYNC_CONFIG_PATH`). Read once at startup.

### 5.2 `Config error` messages (new)

`<var>` is the `_FILE` name, `<base>` its plain name. `"<path>"` is the
value of `<var>` passed through `shownText` (control characters → `?`, cut
to 64 characters + `...`), printed **only** when it names an existing entry
(see 9.2).

| Message | When |
|---|---|
| `<base> and <var> are both set; set only one` | Both set, either may be `""`. |
| `<var> must not be empty` | `<var>=""`. |
| `<var> file does not exist` | `ENOENT`, `ENOTDIR` (path not printed). |
| `<var> file "<path>" is not readable by the server user` | `EACCES`, `EPERM`, and an `lstat` of the path succeeds (the entry exists). |
| `<var> file is not accessible to the server user` | `EACCES`, `EPERM`, and the `lstat` fails too (e.g. a directory on the path cannot be searched), so the entry may not exist (path not printed; Gate 3 fix). |
| `<var> file "<path>" is not a regular file` | Directory, FIFO, device, socket (`EISDIR` or `fstat`). |
| `<var> file "<path>" is larger than 4096 bytes` | `fstat` size or bytes read > 4096. |
| `<var> file "<path>" is empty` | 0 bytes, or only one `\n` / `\r\n`. |
| `<var> file "<path>" is not valid UTF-8` | Decoder error. |
| `<var> file "<path>" contains a NUL character` | `\0` in the content. |
| `<var> file cannot be read (<code>)` | Any other errno (path not printed). |

Validation of the value (existing templates, label changes only): e.g.
`TOKEN_SECRET (from TOKEN_SECRET_FILE) must not start or end with whitespace`,
`REDIS_URL (from REDIS_URL_FILE) is not a valid redis:// or rediss:// URL`.
`TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET` is unchanged.

### 5.3 Log

`info` `{ "event": "token_secret_source", "source": "env" | "file" | "dev" | "random" }`
once at startup. No path, value or length.

## 6. Docker impact

`Docker impact: none` for images and the repo's compose files (they keep
`TOKEN_SECRET` for development). Only the operator-guide compose example
changes (docs).

## 7. Docs impact

- `docs/operator-guide.md`
  - Env table: three rows (`unset`, `-`, `-`, purpose incl. "set only one of
    `X` / `X_FILE`; one trailing newline is removed").
  - "Passing secrets to the container" (secret-file bullet and the compose
    example below it only): drop the `sh` wrapper, "planned in issue #58"
    and the "Until then a short wrapper" text; compose uses
    `environment: { SYNC_CONFIG_PATH: ..., TOKEN_SECRET_FILE: /run/secrets/sync_token_secret }`
    with the image `CMD`. Bullets: fail-closed list (missing file, not
    readable, directory, empty, > 4 KiB, both set); newline rule (one `\n` or
    `\r\n` removed, CRLF files now work); rotation with
    `TOKEN_SECRET_PREVIOUS_FILE`; `REDIS_URL_FILE` holds the whole URL; the
    secret is no longer in the process environment but still readable in
    the mounted file via `docker exec`. Keep the existing Swarm bullets'
    content (Swarm guidance is #60); only reword what refers to the wrapper.
    Keep the strings the #51 repo-hygiene test needs (`--env-file`,
    `docker inspect`, `600`, `TOKEN_SECRET_FILE`, `/run/secrets/`).
  - Token secret "Routine rotation": the secret-file sentence points to
    `TOKEN_SECRET_PREVIOUS_FILE`.
  - Do not touch `docs/roadmap.md`, Swarm guidance (#60), repo-hygiene
    secret checks (#59).
- `docs/startup-errors.md`: new "Config error: secret files" table (5.2);
  `<name>` note for token secrets and Redis rows also covers
  `X (from X_FILE)` (Redis rows become `<name>` templates).
- `docs/conventions.md`: one row "Secret files" → ADR 0023 (first chunk).
- `docs/decisions/0015-...md`: one "Related: 0023" header line (option 1
  only).
- README: none (no env table).

## 8. Test plan (mapped to acceptance criteria)

Runner: Vitest (`pnpm --filter @mosherw/sync-system-server test`). All
secrets in tests are `SENTINEL-...` values; every failure and success case
asserts the sentinel is absent from problems, `ConfigError.message`, stderr,
captured logs, `JSON.stringify` / `util.inspect` of the result (AC7).

| AC | Tests |
|---|---|
| AC1 | `secret-file.test.ts`: each of the three read from a temp file; `token-secret.test.ts` / `redis-config.test.ts`: resulting `current` / `previous` / endpoint equal the file value. |
| AC2 | Table test: each existing token rule (short, weak, example, dev in prod, whitespace, previous == current, also mixed env/file) and each Redis URL rule, from a file, gives the same template with the `(from X_FILE)` label. Dev secret from file accepted in `test`. |
| AC3 | Both-set for each variable, with `X=""`, with `X_FILE=""`, with both non-empty: one problem naming both; file never opened (injected fs spy); `loadConfig` throws. |
| AC4 | Missing file, directory, empty file, > 4096 bytes (4096 ok, 4097 error), invalid UTF-8, NUL; unreadable via `chmod 000` (`skipIf` win32 or root) plus injected `EACCES`/`EPERM`/`EIO` mapping; FIFO (`mkfifo`, skipIf win32) does not hang and is "not a regular file". Path absent for ENOENT, present (sanitized) otherwise; a path with `\n` is shown with `?`. |
| AC5 | `X_FILE=""` is an error, not unset (also in development: no random fallback). |
| AC6 | `secret\n` and `secret\r\n` accepted (= `secret`); `\n` alone and `\r\n` alone → empty; `secret\n\n`, `secret\r`, ` secret`, `secret `, `\tsecret`, BOM prefix → whitespace error for token secrets; interior spaces preserved. |
| AC7 | Sentinel checks above; a secret placed in `TOKEN_SECRET_FILE` itself (operator mistake) is not printed in "does not exist" (9.2). |
| AC8 | Matrix cases: several file problems plus an unrelated `MAX_*` problem reported together, exit 1; `startup-errors-doc.test.ts` lists every new message. |
| AC9 | `warnAboutSecrets` logs `token_secret_source` with `file`/`env`/`dev`/`random`; previous warning still logged when previous comes from a file. |
| AC10 | `unknown-vars.test.ts` (known 37, `MAX_X_FILE`, `REDIS_PASSWORD_FILE`, `TOKEN_SECRET_FILES` flagged); `env-reference.test.ts` and repo-hygiene env-table test pass with the new rows; config-matrix coverage guards include the new names. |
| AC11 | Existing repo-hygiene #51 tests still pass on the new guide (no literal secrets, `/run/secrets/sync_token_secret` present); review checks the wrapper text is gone. |
| AC12 | `main.test.ts` spawns `src/index.ts` with `TOKEN_SECRET_FILE` (no `TOKEN_SECRET`): listens, log has `token_secret_source` `file`, no sentinel in stdout/stderr; and a spawn with both set exits 1 with the conflict line. |
| AC13 | Whole existing suite unchanged and green; env-only messages byte-identical. |

Checks before each push: `pnpm lint`, `pnpm typecheck`, server tests;
Redis tests (`*.redis.test.ts`) only if the Redis harness is available (the
change does not touch connection code).

## 9. Risks / edge cases

1. **FIFO / device paths** would block or read forever: `O_NONBLOCK` open,
   `fstat` on the descriptor, bounded read.
2. **Secret mistaken for a path** (`TOKEN_SECRET_FILE=<the secret>`): the
   "does not exist" message would echo it. Mitigation: path printed only
   when the entry exists (open succeeded, or `EACCES`/`EPERM`/`EISDIR`).
   Needs the user's OK at Gate 2 as a narrowing of Q6.
3. **Path with control characters** could forge extra `Config error` lines:
   `shownText` replaces them.
4. **Silent fallback**: a bad `TOKEN_SECRET_FILE` in development must not
   become `random`; tested.
5. **BOM / CRLF editors**: CRLF now works (one `\r\n` stripped); a BOM is
   kept and rejected for token secrets.
6. **Redis URL whitespace**: `new URL` ignores leading/trailing spaces and
   C0 controls for both sources (existing behaviour, kept for parity);
   a stray `\r` or extra newline in `REDIS_URL_FILE` is tolerated, not
   rejected. Advisory only.
7. **Symlinks** are followed (Kubernetes); no `O_NOFOLLOW`.
8. **Windows dev machines**: no `O_NONBLOCK`, no `chmod 000`/`mkfifo`;
   those tests `skipIf(process.platform === 'win32')`, errno mapping is
   covered by the injected fs on every OS.
9. **Memory**: the string value lives as long as the process, same as an
   env value; buffers are zeroed after decoding.
10. **Test harness**: `helpers/child-env.ts` already drops family names from
    spawned envs, so a developer's `TOKEN_SECRET_FILE` cannot leak into tests.

## 10. Security-sensitive areas

Security-sensitive: yes

- Secrets/config: new input path for `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS`,
  `REDIS_URL` (`secret-file.ts`, `token-secret.ts`, `redis.ts`).
- File reads from an operator-supplied path (FIFO/device/size/symlink
  handling, `secret-file.ts`).
- Non-leak of secret values in errors and logs (`config-error.ts` contract,
  `warnAboutSecrets`, message builders).
- Unknown-variable gate (`known-vars.ts`, ADR 0015/0023).
- No new or upgraded dependency (Node built-ins only), no crypto change, no
  endpoint or message handler change.

## 11. Implementer model

Implementer model: opus
Reason: security-sensitive secret handling with an open ADR, a new module
and changes across ~5 source files and ~9 test files; fail-closed and
non-leak properties must hold on every path.

## 12. Implementation chunks

1. `docs(adr): accept 0023 secrets-from-files` (status Accepted per the
   user's Gate 2 choice, `docs/conventions.md` row, the "Related" line in
   ADR 0015; or the option-2/3 variant).
2. `feat(server): add secret file reader for _FILE variables`
   (`secret-file.ts` + `secret-file.test.ts`).
3. `feat(server): read token secrets from _FILE variables`
   (`token-secret.ts`, `known-vars.ts` names `TOKEN_SECRET_FILE`,
   `TOKEN_SECRET_PREVIOUS_FILE`, `token_secret_source` log, tests).
4. `feat(server): read REDIS_URL from REDIS_URL_FILE`
   (`redis.ts`, `known-vars.ts` `REDIS_URL_FILE`, `redis-config.test.ts`).
5. `test(server): cover _FILE variables in config matrix and startup`
   (`config-cases.ts`, `config-matrix.test.ts`, `unknown-vars.test.ts`,
   `env-reference.test.ts`, `startup-errors-doc.test.ts`, `main.test.ts`
   end-to-end). Doc-driven tests that need the doc rows may land with
   chunk 6 if they cannot pass alone; keep every commit green.
6. `docs(server): document _FILE secret variables`
   (`docs/operator-guide.md`, `docs/startup-errors.md`).

Note: `known-vars.ts` names and the env-table rows are checked against
each other by `env-reference.test.ts` and `repo-hygiene.test.ts`; to keep
every commit green, add the three env-table rows to
`docs/operator-guide.md` in the same commit as the names (chunks 3 and 4),
and the rest of the guide in chunk 6.

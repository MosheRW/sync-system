# Security review (plan): read secrets from files via `_FILE` variables (#58)

- Mode: plan. Reviewed: [`spec.md`](spec.md), [`architecture.md`](architecture.md),
  [ADR 0024](../../decisions/0024-secrets-from-files.md) (Proposed), and the
  code it touches (`apps/sync-server/src/config/token-secret.ts`, `redis.ts`,
  `load.ts`, `config-error.ts`, `apps-config.ts` `shownText`, `main.ts`,
  `index.ts` `fatal`/`safeErr`), plus `docs/operator-guide.md`
  "Passing secrets to the container".
- **Verdict: PASS.** Critical 0, high 0, medium 1, low 4. The required
  controls below are part of the plan.

## 1. Assets and trust boundaries

| Asset | Where it lives |
|---|---|
| `TOKEN_SECRET` / `TOKEN_SECRET_PREVIOUS` (forge any join/session token) | File, then a JS string, then `TokenSecrets.current/previous` Buffers for the process lifetime |
| `REDIS_URL` password (full access to all group state in Redis) | File, then a JS string, then `RedisSettings` (already redacted for `toJSON`/`inspect`, #35 C9) |

Trust boundaries:

- **Operator to server (env + file system).** `X_FILE` and the file are
  operator-controlled. Anyone who can set the env or write the file already
  controls the deployment, so the path is not attacker input; the risks are
  operator *mistakes* (wrong path, secret pasted into `X_FILE`, CRLF/BOM
  editors, loose permissions) and leaking through output.
- **Server to observers.** stderr `Config error` lines, the pino log stream,
  crash output (`fatal` + `safeErr`), `docker inspect` / `compose config`, and
  `/proc/<pid>/environ`. These are often shipped to log aggregators and read
  by people who must not see secrets.
- No network-facing change: no route, message handler, crypto or dependency
  change.

## 2. Threats (STRIDE, brief)

| | Threat | Plan's answer |
|---|---|---|
| I | Secret or file content in a `Config error`, log, thrown message, `inspect`/`toJSON` | Fixed message builders; `err.message` never used; errno gated by regex; only `token_secret_source` logged (enum) |
| I | Secret pasted into `X_FILE` echoed back as "path" | 9.2 narrowing: path omitted for `ENOENT`/`ENOTDIR`/other errno |
| I | Secret stays in the process env | Solved by design for the `_FILE` route (the point of #58) |
| D | FIFO / `/dev/zero` / huge file blocks or exhausts startup | `O_NONBLOCK`, `fstat` on the fd, 4 KiB bounded read |
| T | Stat-then-open race swaps the file | `fstat` on the open descriptor, no path stat used for the decision |
| T | Forged extra `Config error` lines via control characters in the path | `shownText` |
| E / S | Bad file silently falls back to a random/dev secret or the memory store | `invalid` never falls back; problems fail `loadConfig` |
| T | CRLF / BOM / NUL / non-UTF-8 makes file and env values differ silently | One terminator stripped; BOM kept and rejected; NUL and invalid UTF-8 rejected |

## 3. Findings

| # | Severity | Location | Issue (attack / failure scenario) | Fix |
|---|---|---|---|---|
| F1 | Medium | architecture 8 (AC7 tests); `token-secret.ts` `TokenSecrets` | AC7 says the secret never appears in `toJSON`/`inspect` output, and the plan tests that by searching for a string sentinel in `JSON.stringify` / `util.inspect` of "the result". `TokenSecrets.current/previous` are Buffers: `util.inspect` prints them as hex bytes (`<Buffer 53 45 4e ...>`) and `JSON.stringify` as a byte array, so the sentinel test passes while the secret is fully rendered. Today nothing logs `tokenSecrets`, but one stray `logger.debug({ config })` would print it in a recoverable form. | Give `TokenSecrets` the same treatment as `RedisSettings`: a fixed marker from `toJSON`, `toString` and `[inspect.custom]` (keep `current`/`previous` as Buffers so `assertTokenSecrets` in `server.ts` still passes). Then the sentinel tests are meaningful; additionally assert the hex and base64 forms of the sentinel are absent. |
| F2 | Low | architecture 3.1 step 1 | `openSync(path, O_RDONLY \| O_NONBLOCK)` opens whatever the path names before `fstat` rejects it. Opening a terminal device without `O_NOCTTY` can make it the controlling terminal of a session-leader process (node is PID 1 in the container), and some devices act on open (e.g. watchdogs). Operator-mistake only. | Add `O_NOCTTY` where defined (`?? 0`). Optionally a cheap `statSync(path)` pre-check that refuses non-regular entries before opening; the `fstat` on the fd stays the authoritative check (so no TOCTOU). |
| F3 | Low | architecture 7 (operator guide) | Docs could steer operators into unsafe fixes: on "not readable by the server user" the easy fixes are `chmod 644` or `user: root`. Compose `secrets: file:` is a bind mount, so host ownership and mode apply (the long-syntax `uid`/`gid`/`mode` only work in Swarm). A `REDIS_URL_FILE` recipe that types the password in a command lands in shell history and `ps`. | See required control C10. |
| F4 | Low | architecture 5.2 / `shownText` | `shownText` replaces C0/C1 controls and U+2028/9 but not bidi or format characters (U+202A-U+202E, U+2066-U+2069, U+200B-U+200F, U+FEFF), so a printed path can be displayed misleadingly in a terminal or log viewer. Operator-supplied, cosmetic. | Optional: extend `shownText`'s class with those ranges (it is shared with the apps-config messages, so update its tests too). Not required for #58. |
| F5 | Low | spec Q7 (accepted) | No permission check: a world-readable secret file starts without warning. Accepted by the user; the guide's mode 400 recipe is the control. | Accepted risk. A future `secret_file_world_readable` warning (POSIX only, no path in the log) could be a follow-up issue. |

No critical or high findings.

## 4. Assessment of the pending Gate 2 decisions

- **Q6 narrowing (path omitted for "does not exist" and unknown errno):
  recommend accepting.** It closes a realistic leak: an operator who pastes
  the secret (or the full `redis://:pw@host` URL) into `X_FILE` gets
  `ENOENT`/`ENOTDIR`/`ENAMETOOLONG`, and base64 secrets contain `/`, so they
  look like paths. With 44-character base64 secrets, the 64-character
  `shownText` cut would print the whole value. The cost is a slightly less
  helpful "does not exist" message; the variable name is still printed and the
  operator can `ls` the path. ADR 0024's "a file path may be printed" line must
  be updated to the narrowed rule when it is accepted (chunk 1).
- **REDIS_URL from file keeps the URL parser's lenient whitespace: no
  objection.** WHATWG `URL` dropping leading/trailing C0/space and inner
  tab/newline is existing env behaviour; the outcome of a stray `\r` or blank
  line is a working or a failing connection, not a leak or a bypass (the
  dev-password, query/fragment and scheme checks still run on the parsed
  URL). Parity with env (AC2/AC13) is the safer contract. Keep the existing
  `raw.includes('?' | '#')` check on the raw value.
- **ADR 0024 route:** no security difference between the options. Option 1 is
  fine.

## 5. Required controls (part of the plan)

C1. **Bounded, race-free read.** Only `secret-file.ts` reads secret files.
    `openSync(path, O_RDONLY | (O_NONBLOCK ?? 0) | (O_NOCTTY ?? 0))`,
    `fstatSync(fd)` decides regular-file and size before any `readSync`, read
    at most `MAX + 1` bytes in a loop, `closeSync` in `finally` on every path
    (including a throw from `fstat`/`readSync`). Never `readFileSync`,
    `existsSync`/`statSync`-then-read as the decision, or async streams.
    Symlinks followed (accepted for Kubernetes).

C2. **Messages from fixed builders only.** Every new problem comes from
    `SECRET_FILE_MESSAGES`. Never `err.message`, `err.path`, `err.syscall`,
    decoder error text, file content, byte offsets, content length or line
    numbers. The errno code is printed only if it matches `/^E[A-Z0-9]+$/`.
    The path goes through `shownText` and, if the narrowing is accepted, only
    for entries that exist (`EACCES`, `EPERM`, `EISDIR`, or after a successful
    open). Validation messages use the label `X (from X_FILE)`, names only.

C3. **Fail closed.** Conflict (`X` and `X_FILE` both defined, either `""`) is
    checked before the file is opened. `X_FILE=""` is an error. A terminator-
    only file is "empty". A resolver `invalid` result always pushes a problem
    and never becomes `random` (token secret), "unset" (memory store for
    Redis) or a default; `loadConfig` throws whenever any problem exists.
    Tested in `development` and `test` too.

C4. **Identical validation.** File values go through `checkSecret` /
    `parseUrl` unchanged (length, distinct bytes, examples, dev secret / dev
    Redis password outside dev, whitespace, query/fragment). `PREVIOUS must
    differ` compares resolved values across mixed sources.

C5. **Encoding.** `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`;
    BOM kept (so the whitespace rule rejects it for token secrets and URL
    parsing rejects it for Redis); NUL rejected; strip exactly one trailing
    `\r\n` or `\n`; nothing else trimmed. The read buffer is zeroed after
    decoding (best effort).

C6. **Logging.** The only new log line is `info`
    `{ event: 'token_secret_source', source }` with `source` from the fixed
    enum. No path, length, hash or value. The `ResolvedSecret` object and
    file-read results are never passed to a logger or included in a thrown
    error.

C7. **Redact `TokenSecrets`** (F1): `toJSON`, `toString`, `[inspect.custom]`
    return a fixed marker; Buffers stay accessible to `TokenKeyring`.

C8. **Unexpected errors stay safe.** Any exception inside the reader is either
    mapped to a builder message or propagates to the existing `fatal` path,
    which logs only `safeErr` (name, frames, code). Test: an injected fs
    whose error `message` and `path` contain the sentinel produces no sentinel
    on stderr/logs.

C9. **Non-leak tests (AC7)** use a sentinel on every success and failure
    path and assert it is absent (plain, hex and base64 forms) from problems,
    `ConfigError.message`, spawned stdout/stderr, captured logs, and
    `JSON.stringify` / `util.inspect` of `LoadedConfig`, `TokenSecrets` and
    `RedisSettings`. Include the operator-mistake cases: a base64 secret
    containing `/` and a full `redis://:SENTINEL@host` URL placed in `X_FILE`
    are not printed. Test temp files are created with mode 600 and removed.

C10. **Operator guide (F3).**
    - Keep the uid 1000 / mode 400 / outside-any-git-tree recipe and say that
      compose `secrets: file:` is a bind mount, so host owner and mode apply.
    - The "not readable" troubleshooting (guide and `docs/startup-errors.md`)
      says to fix ownership (`chown 1000:1000`, mode 400), and explicitly not
      to make the file world-readable or run the container as root.
    - The `REDIS_URL_FILE` example never puts the password on a command line
      (generate it into the file, or write the file with an editor), same
      mode 400 / uid 1000.
    - State that the secret is still readable in the container
      (`docker exec`), that `_FILE` and `X` together is an error (so a leftover
      wrapper or `TOKEN_SECRET:` line fails closed), and that the secret file
      must not live in the image, the build context or a git working tree.
    - Remove the wrapper only where it refers to #58; no secret-looking
      literals in examples (the #51 repo-hygiene test still passes).

C11. **No new dependency** (Node built-ins only); no change to `known-vars`
    families beyond the three names.

## 6. What I will check in code mode

- `secret-file.ts`: open flags, `fstat` before read, bounded loop, `finally`
  close, errno map and regex, path shown only per the accepted Q6 rule,
  decoder options, NUL check, single-terminator strip, buffer zeroing.
- `token-secret.ts` / `redis.ts`: resolver used for all three variables and
  nowhere else reads `env.TOKEN_SECRET*` / `env.REDIS_URL` directly; no
  fallback after `invalid`; labels; `TokenSecrets` redaction; the new log line.
- `known-vars.ts`: exactly three names added.
- Tests for C3, C8, C9 (sentinel forms), FIFO non-blocking, 4096/4097 bounds.
- Docs: C10 items; ADR 0024 text matches the accepted Q6 rule.
- Scanners: gitleaks on the PR commits, semgrep on changed files, `npm audit`
  (high/critical).

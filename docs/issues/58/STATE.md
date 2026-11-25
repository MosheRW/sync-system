# State: #58 feat(server): read secrets from files via _FILE variables (follow-up to #51)
- Path: full
- Phase: validation
- Branch: feat/58-secret-files
- PR: #76
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: engineer
## Model log
- pm grooming: sonnet (default) → DONE
- architect plan: opus (rule: security-sensitive + NEXT_MODEL) → DONE
- security plan: opus (rule) → PASS
- engineer implement: opus (rule: Implementer model + security-sensitive) → DONE (one run, interrupted once by an API rate limit and resumed from the pushed commits)
- qa review: sonnet (NEXT_MODEL) → PASS
- security code: opus (rule) → PASS (0 critical/high/medium, 2 low advisories)
- engineer fix: opus (rule: fix round) → DONE
## Gate 2 decisions (user)
- ADR 0023 option 1: Accepted; ADR 0015 gains only a "Related: 0023" line; conventions.md row added
- Q6 narrowing accepted: the path is omitted for "does not exist" (ENOENT/ENOTDIR) and unknown errors; printed (via shownText) only for entries that exist
- REDIS_URL from a file keeps the URL parser's lenient leading/trailing whitespace handling (parity with env)
- Gate 1 answers stand: strip one `\n` or `\r\n`; terminator-only file is empty; 4096-byte cap; empty X plus X_FILE is a conflict; `file` logged as token-secret source; no permission check
- QA verdict (round 1): PASS, 13/13 criteria met; POSIX-only tests not rerun by QA (Docker unavailable)
## Open questions
- none
## Deviations from plan
- `test/no-disk.test.ts` updated: it pins the list of source files that import `node:fs`; `secret-file.ts` is added with a check that it opens read-only.
- New test helper `test/helpers/secret-files.ts` (mode-600 temp files, sentinel checks in plain, hex, spaced hex, base64 and base64url forms).
- `test/load.test.ts` gained the `LoadedConfig` JSON/inspect non-leak test (security C9).
- To keep every commit green, the coverage guards (`config-cases.ts` ENV_CASES / VALID_VALUES, `env-reference`, `unknown-vars` count) and the matching `docs/startup-errors.md` rows landed with the code chunks (3, 4) and the test chunk (5); chunk 6 holds the operator-guide secrets section. The Redis URL rows of `docs/startup-errors.md` became `<name>` templates in chunk 5.
- Extra commits: `test(server)` writing a BOM as an escape; `fix(server)` replacing a template-literal log message (caught by the existing static log check); two `docs` commits repairing table rows broken by an escaping mistake. No history rewritten.
- `TokenSecrets` stays an interface (tests build it as a literal); the collector returns a frozen object with non-enumerable `toJSON` / `toString` / `inspect.custom` (C7).
- The log message of `token_secret_source` is static ("token secret source at startup"); the source is only in the `source` field.
- POSIX-only tests (FIFO, `chmod 000`) skip on Windows; they were run and pass in the pinned `node:24` Linux image as uid 1000.
- Gate 3: user asked to fix the two low advisories. Fixed in `34c799f` (token secrets are a frozen class instance with prototype `toJSON` / `toString` / `inspect.custom`; their Buffers redact JSON, inspect and string conversion, so a spread copy stays redacted; new export `redactTokenSecrets`, used by `createSyncServer` to keep a redacted copy of caller-built secrets without changing them; `TokenSecrets` interface unchanged) and `fd1e979` (EACCES/EPERM on open prints the path only after an `lstat` of it succeeds; otherwise the new path-less message `<name> file is not accessible to the server user`; `SecretFileSystem` gained `lstatSync`; startup-errors.md, operator guide and ADR 0023 updated). An explicit `buffer.toString(encoding)` still decodes a secret Buffer (TokenKeyring and tests rely on the bytes). POSIX tests rerun in the local node:24 image as uid 1000: pass. Per the orchestrator, these fix commits carry `Refs: #58` only, no Co-Authored-By trailers.

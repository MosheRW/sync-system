# Security review (plan): #36 health, readiness and config errors

- Mode: plan, round 1. Reviewed at `fe5e90f` (`architecture.md`, ADR 0015 Proposed, `spec.md` with Gate 1 Q20-Q26).
- Verdict: **PASS**. Critical 0, high 0, medium 1, low 6.
- Required controls C1-C10 below are part of the plan. The engineer implements them and I check them in code mode.

## 1. Assets and trust boundaries

| Asset | Where | Boundary |
|---|---|---|
| Token secrets (`TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS`) | env → `config/token-secret.ts` | operator env → process; must never reach stderr or logs |
| Redis credentials (`REDIS_URL` user, password, host) | env → `config/redis.ts` (`RedisSettings`, redacted) | same |
| App API keys | apps file → `config/apps-config.ts` | operator file → process; never printed |
| Reader sync API key, credential-bearing URLs | `READER_*` → `apps/reader/src/config/schema.ts` | same; truncated echo for non-secret values only (Q24) |
| Server version, storage kind, readiness state | `/health`, `/ready` | **unauthenticated network** → process |
| `package.json` | image `/app/package.json` (root-owned, read-only for `node`) | file system → process |

## 2. Threats (STRIDE, short)

- **Information disclosure, network:** anyone who can reach the port reads the version (fingerprinting for known CVEs), the storage kind, and whether Redis is down (`/ready` 503).
- **Information disclosure, local:** a config message echoes a secret into stderr, and from there into container logs or a log aggregator. Ways this can happen: a raw value, a `new URL()` / `JSON.parse` / zod error that carries the input, a "did you mean" that leaks, or a variable name that holds a pasted secret.
- **Fail-open (tampering/elevation):** the refactor from "throw at the first error" to "collect every problem" lets a collector return a default (random/dev secret, memory store, default ceiling) and the server starts with a weaker config.
- **Denial of service:** `/ready` probes amplifying load on Redis; a stray env var now stopping startup (by design, Q20); a bad or missing `package.json` stopping startup.
- **Spoofing/log forging:** control characters in echoed text (file path, JSON key names) making fake `Config error:` lines.

## 3. Verified in the code (claims of the plan)

- **Q23 holds.** `apps/sync-server/src/storage/redis/redis-storage.ts:202-209`: `status()` returns `state: instance.started && (instance.fenced() || !pubsub.healthy) ? 'unreachable' : options.link.state`. `instance.fenced()` (`instance.ts:110`) is true when the state is not `live` (fenced or stopped) or no renewal succeeded within `selfFenceMs`. `pubsub.healthy` (`pubsub.ts:191`) is false while the subscriber is down, being replaced or resyncing. Everything is synchronous in-memory state, so no Redis command runs per probe.
- `instance.started` is false before registration. `server.listen()` (`server.ts:332-359`) awaits `storage.start()` before `httpServer.listen()`, so no HTTP request can arrive in that window.
- After `close()`, `instance.stop()` makes `fenced()` true anyway. The new `closing` flag covers the earlier part of `close()` (heartbeat, connection close).
- `/health` today: constant body, `Cache-Control: no-store`, `nosniff`. Compose healthchecks only test `r.ok`, so the additive body is safe (`compose.yaml:51-56`).
- Ports are published on loopback only in compose, and nginx proxies every path, including `/health` and `/ready`, to whoever reaches it.
- `semver` is already a runtime dependency (`apps/sync-server/package.json`). No new dependency.
- Existing echo hygiene: Redis URL messages name the variable only; the `JSON.parse` message is reduced to line and column (M2); zod issues are reduced to the field and the rule. Exceptions that the plan's echo rule does not list yet (see L2): the apps file path (`SYNC_CONFIG_PATH` value) prefixes every apps-file message, and `unknown field(s): <keys>` prints JSON key names from the file.
- Reader: `shownUrl` cuts everything up to the last `@`. The API key is never shown (`schema.ts:108-123, 190`).

## 4. Findings in the plan

| # | Severity | Location | Issue / scenario | Fix |
|---|---|---|---|---|
| M1 | Medium | architecture 3.3 (collect every problem), `load.ts` | **Fail-open risk of the refactor.** Today each stage throws, so a bad `TOKEN_SECRET` or `REDIS_URL` stops `run()` before anything uses it. In collect mode, a collector that returns a fallback after pushing a problem (random secret, `undefined` Redis = memory store, a default ceiling) is harmless only while `loadConfig` throws on any problem. One missed path (a wrapper, a `problems` array that is never checked, a warning path in `run()` that runs before the check) would start a production instance with a forgeable or per-process secret, or without the shared store. | Controls C1 and C2. |
| L1 | Low | AC33, contract 6.1 | `/health` shows the exact version to anyone who can reach the port (fingerprinting). Accepted by Gate 1 (Q21, Q26). Ports are loopback-only in compose, and the plan's README advice covers the rest. | Keep the planned README note: restrict `/health` and `/ready` to the load balancer or a private network when the version is sensitive. No code change. |
| L2 | Low | architecture 3.3 "Echo rule", Q-3 | The documented echo rule lists only validated integers and pattern-matching namespaces. The server also echoes the `SYNC_CONFIG_PATH` value (prefix of every apps-file line) and JSON key names (`unknown field(s): ...`). Neither is a secret in practice, but the rule as written is not exhaustive, and AC37's "never echoes the value" is not literally true for the path. | C5: list every allowed echo in `docs/startup-errors.md`. |
| L3 | Low | `apps-config.ts:157`, file path prefix, ADR 0015 name cut | Echoed text that comes from operator input (file path, JSON key names) can hold control characters or newlines, so one problem can print lines that look like extra `Config error:` lines (log forging in stderr or aggregators). Env names are safe because ADR 0015 only checks `[A-Za-z][A-Za-z0-9_]*`. | C6: escape control characters in echoed path and key strings, and cap them in length. |
| L4 | Low | ADR 0015, 64-character cut | A name in a family is printed (up to 64 characters). If an operator pastes a secret into the *name* (`TOKEN_SECRET_aB3x...=`), part of it reaches stderr. This is unlikely, and names are by definition not secret, but the cut could be shorter. | Optional: cut flagged names at 48 characters (the longest known name is 31). Accept either way. |
| L5 | Low | `src/version.ts` | `readFileSync` of a root-owned file at a fixed module-relative path is fine. Missing hygiene: no size cap before `JSON.parse`, and the version that goes into `/health` must be the validated string. | C8. |
| L6 | Low | ADR 0015 consequences | Availability, not confidentiality: shared `env_file` / Helm setups that inject `REDIS_PASSWORD`, `REDIS_HOST`, `SYNC_*` helpers into every container now stop the server at startup. This is by design (Q20). On the plus side, a typo of `TOKEN_SECRET` or `REDIS_URL` no longer silently falls back to a random/dev secret or the memory store. | Keep the upgrade note. Also list `REDIS_PASSWORD` / `REDIS_HOST` as examples in the "Upgrading" section, with the rename workaround. |
| L7 | Low | Q24, reader `shown()` | The reader echoes a truncated raw value for non-URL, non-key variables. A secret pasted into the wrong variable (an API key in `READER_SYNC_APP_VERSION`) is partly printed. Accepted at Gate 1. | Document it in the echo rule (already planned). No change. |

## 5. Required controls (part of the plan)

- **C1. No partial config.** `loadConfig` throws `ConfigError(problems)` whenever `problems.length > 0`, and only then returns. Collectors return `undefined` (never a default or fallback) for a value that failed. `run()` does nothing that depends on config (logger, warnings, version read, Redis connect, `createSyncServer`) before `loadConfig` has returned. Test: one case per secret-bearing variable (invalid `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS` equal to current, invalid `REDIS_URL`, dev secret/dev Redis password in production) where `run()` exits 1 and nothing listens.
- **C2. Same semantics as today.** Every rule that throws today is still a problem in collect mode: secret rules, dev Redis password, dev API key outside development/test, example secrets, `NODE_ENV` handling. The `parseEnv` / `parseTokenSecrets` / `parseRedisSettings` wrappers throw when their collector reported anything.
- **C3. Never echo secrets.** Messages never contain the value, or any part of it, of `TOKEN_SECRET*`, `REDIS_URL` (user, password and host), app `apiKey`, or `READER_SYNC_API_KEY`. No `err.message` from `new URL`, `JSON.parse`, zod, or `fs` is passed on (only `err.code`). The AC37 matrix uses a unique sentinel per case and asserts it is absent from **both** stderr and the log destination. Secret cases need sentinels for each part: Redis user, password and host separately.
- **C4. Unknown-variable check reads names only.** It never reads or compares values. It only considers names matching `[A-Za-z][A-Za-z0-9_]*`. Suggestions come only from `KNOWN_SERVER_VARIABLES` (or the reader list). The edit distance runs on names already cut to the length limit. Output is sorted and deterministic.
- **C5. Exhaustive echo rule** in `docs/startup-errors.md`. Server: validated integers, namespaces matching `NAMESPACE_PATTERN`, the config file path, JSON key names of unknown fields, env variable names (cut), `errno` codes. Reader: Q24 rule. Anything else echoed is a code-mode finding.
- **C6. Escape operator-supplied text** that is echoed (file path, JSON key names): replace control characters (`\u0000-\u001f`, `\u007f`) with a visible escape or `?`, and cap the length (64 characters plus `...`), so one problem is always exactly one line.
- **C7. `/health` and `/ready`:** prebuilt bodies, no per-request I/O, no Redis command, no reason field, no instance ID, key prefix, host, address or app data. Headers as today (`no-store`, `nosniff`). Methods other than `GET` and other paths give the existing 404. `ready()` is synchronous. `closing` is set as the first statement of `close()`.
- **C8. Version read:** the path is fixed relative to the module and never comes from env or args. Reject files over 64 KiB before parsing. Never print file content or the absolute path (only the reasons listed in 3.1 and the `errno` code). The value served is the validated string (≤ 64 characters, `semver.valid`). It is read once at startup, never per request.
- **C9. No new dependency.** `pnpm audit --audit-level=high` stays clean.
- **C10. Docs contain no usable secret.** `docs/startup-errors.md` and the READMEs use placeholders only. Any new example secret-shaped value that would pass validation is added to `PUBLIC_EXAMPLE_SECRETS` (refused everywhere).

## 6. Gate 2 questions (security view)

- **Q-1 (ADR 0015):** Option 1 is fine from a security view. It catches typos of `TOKEN_SECRET*` and `REDIS_URL`, which today fail open silently (random/dev secret, memory store). That is a real security gain. The platform-suffix exclusions only reduce typo coverage; they create no bypass of any security control.
- **Q-2 (reader check):** Yes. `READER_SYNC_ULR` silently turning sync off is the same fail-silent class. It is names-only, with no new exposure.
- **Q-3 (echo validated numbers):** Yes. A number is printed only after it parsed as an integer under `/^[1-9][0-9]*$/` (the parsed value, not the raw string), and a namespace only when it matches the pattern. Neither can carry a secret. Condition: C5 makes the rule exhaustive (path, key names).
- **Q-4 (skip comparisons against an invalid ceiling):** Acceptable. It is safe because the run still exits 1 on the invalid ceiling itself (C1), so nothing starts with an unchecked app value.
- **Q-5 ("did you mean"):** Yes. It suggests from the known-name list only and never touches values (C4).
- **Q-6 (no drain window):** Accept. There is no security impact; a drain window would be availability work for a follow-up.

## 7. What I will check in code mode

- C1-C10 one by one, especially every early return in `load.ts` and `run()` (fail-open) and every template literal in `src/config/*.ts` and `apps/reader/src/config/schema.ts` (echo).
- `/health` and `/ready` bodies and headers, `ready()` purity, `closing` placement.
- `version.ts` path resolution in both `src/` and `dist/`, the size cap, and reasons without content.
- `childEnv()` only removes names; it must not inject anything.
- `docs/startup-errors.md` contains no real-looking secret.
- Scanners: gitleaks on the PR range, semgrep on changed files, `npm audit` / `pnpm audit` (high/critical).

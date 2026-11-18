# Architecture: #36 health, readiness and config errors (PRD item 9b)

Spec: [`spec.md`](spec.md) (AC33-AC42, AC37a; Gate 1 decisions Q20-Q26).
Path: full. No UI change, no designer phase. One PR (`Closes #36`).

## 0. Summary

- `/health` gains `version` (read from the server's `package.json` at startup)
  and `storage` (`memory` | `redis`). New `GET /ready`: 200 `ready` / 503
  `not_ready`, from `SyncServer.storage()` plus a "closing" flag.
- Q23 is satisfied **without new machinery**: `storage.status()` of the Redis
  store already reports `unreachable` while the instance is fenced or its
  pub/sub link is unhealthy (`storage/redis/redis-storage.ts`, `status()`:
  `instance.started && (instance.fenced() || !pubsub.healthy) ? 'unreachable' :
  link.state`). That is the same condition that refuses upgrades. `/ready`
  uses it as is. No Gate 2 question is needed for Q23.
- Config: one loader collects **every** problem of the env, Redis settings,
  token secrets, unknown look-alike variables, the apps file and dev keys, and
  prints one `Config error:` line per problem, exit 1. Today the stages throw
  one after another, and only the first line of a multi-line error carries
  the `Config error:` prefix.
- Unknown look-alike variables (AC37a): the naming rule is
  [ADR 0015](../../decisions/0015-unknown-environment-variables.md) (Proposed).
- Startup-error list: new `docs/startup-errors.md`, checked by a test against
  the shared invalid-config case tables of the server and the reader.
- Security-sensitive: yes. Implementer model: opus.

## 1. Repo layout

Layout: `monorepo` (pnpm workspace, `pnpm-workspace.yaml`: `apps/*`,
`packages/*`); `git submodule status` is empty; no turbo/nx. Compose files:
`compose.yaml`, `compose.redis.yaml`, `compose.multi.yaml`. No other repo is
involved; no linked issue.

| Package | Path | Default branch | Checks |
|---|---|---|---|
| `@sync-system/server` | `apps/sync-server` | `main` | `pnpm --filter @sync-system/server typecheck`, `test` (also with `SYNC_TEST_STORE=redis` and `SYNC_TEST_REDIS_URL`), `build`; image build |
| `@sync-system/reader` | `apps/reader` | `main` | `pnpm --filter @sync-system/reader typecheck`, `test`, `build`, `test:e2e` |
| root | `/` | `main` | `pnpm audit --audit-level=high`, `pnpm lint`, the three `docker compose ... config -q` |

`packages/protocol` and `packages/client` are not changed (no protocol change).

## 2. Decisions

- [ADR 0015](../../decisions/0015-unknown-environment-variables.md) **Which
  unknown environment variables stop startup** (Proposed). Recommendation:
  option 1, families of the server's own names (`MAX_`, `TOKEN_`, `REDIS_`,
  `SYNC_`, `JOIN_`, `QR_`, `APPROVAL_`, `DISCONNECT_`, `KEEP_ALIVE_`,
  `INACTIVITY_` prefixes and the `_CEILING` suffix) minus `SYNC_TEST_*` and
  platform link names (Kubernetes service links, Docker `--link`).
- Everything else is decided by the spec or follows existing patterns. The
  remaining Gate 2 questions are in section 13.

No new dependency. No schema or storage change. No protocol change.

## 3. Approach

### 3.1 Server version (AC33, Q21)

- New `apps/sync-server/src/version.ts`, `readServerVersion(url = new URL('../package.json', import.meta.url))`.
  The module sits directly in `src/`, so `../package.json` resolves to
  `apps/sync-server/package.json` from `src/version.ts` (tests, `tsx` dev
  script) and to `/app/package.json` from `dist/version.js` (image; `rootDir`
  is `src`, `outDir` is `dist`).
- Checks, in order, each with its own reason (no path beyond `package.json`,
  no file content is printed):
  1. readable: else `package.json not found next to the server code` /
     `package.json cannot be read (<errno code>)`;
  2. JSON object: else `package.json is not valid JSON`;
  3. `name === "@sync-system/server"`: else `package.json is not the sync
     server's` (guards against picking up the workspace root or another
     package after a layout change);
  4. `version` is a string, at most 64 characters, `semver.valid` (semver is
     already a dependency): else `package.json has no valid semver version`.
- Failure: `Startup error: cannot read the server version: <reason>`, exit 1
  (a packaging fault, not a config fault, so the `Startup error` family). It
  runs in `run()` **after** config validation, so config problems are still
  all reported first, and **before** Redis connects.
- `createSyncServer` gets `version?: string`; when omitted (tests) it calls
  `readServerVersion()` once. No version constant is checked in (Q21).
- In the image: `pnpm --filter @sync-system/server deploy --prod --legacy /out`
  always writes the package's `package.json` into `/out`, and the runtime
  stage copies `/out` whole (`COPY --from=build /out ./`). So `/app/package.json`
  is already present. The plan adds a Dockerfile comment saying it is needed
  at runtime, and a `repo-hygiene` test that the runtime stage still copies
  `/out` whole or `package.json` explicitly. QA checks it on the built image
  (section 11, step L6).

### 3.2 `/health` and `/ready` (AC33-AC36, Q22, Q23, Q26)

- `src/http/health.ts`: `handleHttpRequest` becomes
  `createHttpHandler(deps: { version: string; storageKind: 'memory' | 'redis'; ready: () => boolean })`.
  The `/health` body is built once (it is constant for the process). The
  `/ready` body is one of two prebuilt strings per storage kind.
- `server.ts`: a `closing` flag set as the **first** statement of `close()`.
  New `SyncServer.ready(): boolean`:
  `!closing && (status.kind === 'memory' || status.state === 'connected')`,
  with `status = storage.status()`. The upgrade handler's `available()` stays
  as it is (no behaviour change for WebSockets).
- No Redis command per request: `status()` is synchronous and reads in-memory
  state, so `/ready` cannot be used to amplify load on Redis.
- `SyncServer.storage()` keeps its contract; its doc comment loses "Not
  exposed over HTTP in 9a".
- What 503 during shutdown means in practice: `close()` stops the listener
  right away (`httpServer.close()`, `closeIdleConnections()`), so a probe on a
  **new** connection is refused and only a request already on an open
  connection sees the 503. Both read as "not ready" to a load balancer. No
  drain delay is added (out of scope; see Q-6).
- Compose healthchecks keep `/health` (AC36). `config/nginx-multi.conf` is not
  changed (open-source nginx has passive checks only).

### 3.3 Collect every config problem in one run (AC37, AC38)

New `apps/sync-server/src/config/load.ts`:

```ts
export interface LoadedConfig {
  env: ServerEnv;
  apps: AppConfig[];
  tokenSecrets: TokenSecrets;
  redis: RedisSettings | undefined;
}
export function loadConfig(env: EnvSource): LoadedConfig; // throws ConfigError(problems)
```

Steps, each pushing into one `problems: string[]`; the order is fixed so
output is deterministic:

1. `collectEnv(env, problems)` (refactor of `parseEnv`): numeric vars,
   `LOG_LEVEL`, `HOST`, `JOIN_METHODS_ALLOWED`, `SYNC_CONFIG_PATH`, then
   `collectRedisSettings`, then the cross-field rules (as today: only when the
   numbers they compare are valid). Returns the env plus a **partial
   ceilings** view: a ceiling (or `joinMethodsAllowed`) that failed its own
   check is `undefined`. `parseEnv` stays as a thin wrapper (existing callers
   and tests).
2. `collectTokenSecrets(env, env.NODE_ENV, problems)` (refactor of
   `parseTokenSecrets`, which stays as a wrapper).
3. `collectUnknownVariables(env, problems)` (ADR 0015).
4. Apps file, if `SYNC_CONFIG_PATH` is valid: `collectAppsConfigFile(path,
   partialCeilings, problems)`. Every field rule runs; a comparison with a
   ceiling (or with `JOIN_METHODS_ALLOWED`, or the keep-alive rule that
   depends on a defaulted limit) is **skipped** when that ceiling is
   `undefined`, because there is nothing valid to compare against (Q-4).
   Structural failures (file missing, unreadable, not JSON, no `apps` array)
   still end the file step with one problem, as today.
5. `devKeyProblems(apps, NODE_ENV)` (refactor of `checkDevKeys`): every app
   with the public dev key outside development/test is reported, not just the
   first. The warning part moves to `warnDevKeys(apps, logger)`.

`ConfigError` (`config/config-error.ts`) gets `readonly problems: readonly string[]`
like the reader's; `message` stays `problems.join('\n')` for compatibility.
`main.ts` prints **one `Config error: <problem>` line per problem** (today
lines 2+ have no prefix) and returns exit 1. `run()` then reads the version,
creates the logger, logs the warnings (dev keys, secrets), connects Redis, as
today.

Messages (AC38, "say what to change"). The engineer reviews every message
against this rule: it names the variable or the field (with the JSON path
`<file>: apps[<i>] (namespace "<ns>"): <field>` for the file) and states the
rule or the action. Known gaps to fix:

| Today | After |
|---|---|
| `apps[i]: <field> <v> exceeds <CEILING> <c>` | `... exceeds <CEILING> <c> (lower <field> or raise <CEILING>)` |
| `<path>: cannot read config file (<code>)` | `... (<code>; check that the server user can read it)` |
| `apps[i] has the same namespace "<ns>" as apps[j]` | `... (each app needs its own namespace)` |
| `apps[i] ... has the same apiKey as apps[j] ...` | `... (each app needs its own key)` |
| `apps[i] ... uses the public development API key; set a real key` | unchanged (already says what to do) |

Existing tests that assert old texts are updated in the same commit.

Echo rule for the server (documented in the startup-error list): the server
never prints a raw value it received. It may print a number it has already
parsed and validated as an integer (ceilings, cross-field rules) and a
namespace that matches the namespace pattern, because both are needed to say
what to change and neither can be a secret (Q-3).

### 3.4 Unknown look-alike variables (AC37a, ADR 0015)

New `apps/sync-server/src/config/known-vars.ts`:

- `KNOWN_SERVER_VARIABLES`: the 30 names (19 numeric from `NUMERIC_VARS`,
  plus `HOST`, `LOG_LEVEL`, `NODE_ENV`, `SYNC_CONFIG_PATH`,
  `JOIN_METHODS_ALLOWED`, `TOKEN_SECRET`, `TOKEN_SECRET_PREVIOUS`, the four
  `REDIS_*`). `NUMERIC_VARS` names are typed against it so a new variable
  cannot be parsed without being known.
- `isServerFamilyName(name)`, `isPlatformName(name)`, and
  `collectUnknownVariables(env, problems)` with the rule and messages of ADR
  0015 (name charset `[A-Za-z][A-Za-z0-9_]*`, upper-case family match,
  `SYNC_TEST_` and platform suffixes never flagged, 64-character cut, sorted,
  "did you mean" within 2 edits).
- Only names are read; values are never touched by this check.

Test hygiene: `test/helpers/child-env.ts` exports `childEnv(extra)`, which
copies `process.env` without family names and adds `extra`. The five tests
that spawn the server with `...process.env` use it: `main.test.ts`,
`main-redis.redis.test.ts`, `multi-process.redis.test.ts`,
`restart-process.int.test.ts`, `dev-script.test.ts`.

### 3.5 Reader (AC39, Q24, Q25)

- The reader already collects all problems (`parseReaderConfig`) and prints
  one `Config error:` line each. Q24: the truncated echo for non-secret values
  stays; URL credentials stay redacted (`shownUrl`); the API key is never
  shown. 9b documents the rule and adds the AC37-style coverage tests.
- If Q-2 is yes: `apps/reader/src/config/known-vars.ts` with
  `KNOWN_READER_VARIABLES` (the 11 `READER_*` names) and the same check with
  the single family `READER_` and the same platform exclusions, called from
  `parseReaderConfig` (so the server, Vite dev and preview all apply it).
  Message: `<NAME> is not a reader variable; did you mean <KNOWN>?` /
  `<NAME> is not a reader variable; remove it or fix the name (see "Configuration" in apps/reader/README.md)`.
  The ADR 0015 helpers are small; the reader gets its own copy (the reader
  does not depend on the server package, and a shared package for ~40 lines
  is not worth it). A test in each package pins the same suffix list.
- `HOST` and `NODE_ENV` have no invalid value in the reader (any `HOST` that
  cannot be bound gives `Startup error: cannot listen ...`); the docs say so.
- No `/ready` for the reader (Q25). Reader `/health` unchanged.

### 3.6 Startup-error list (AC40)

`docs/startup-errors.md` (new; linked from both READMEs). Sections:

1. How to read it: `Config error` (fix the config), `Startup error` (fix the
   environment or the image), exit code 1, one line per problem, every
   problem in one run.
2. Echo rules: server (3.3) and reader (Q24).
3. Server `Config error`, grouped: env variables, cross-field rules, Redis,
   token secrets, unknown variables, apps file (structure, fields, ceilings,
   join methods, duplicates, dev key).
4. Server `Startup error`: version, Redis unreachable / authentication / TLS /
   version too old / connection failed, storage start, cannot listen.
5. Reader `Config error` and `Startup error` (library index, index.html,
   cannot listen).
6. Not caught: typos of generic names (`PORT`, `HOST`, `LOG_LEVEL`,
   `NODE_ENV`) and platform-shaped names (ADR 0015).

Format, so a test can read it: each entry is a table row whose first cell is
the message template in backticks, starting with `Config error: ` or
`Startup error: `; placeholders are lower-case words in angle brackets
(`<name>`, `<n>`, `<path>`, `<field>`, `<where>`, `<value>`, `<code>`,
`<reason>`, `<known>`); the second cell is the fix.

The check:

- `apps/sync-server/test/config-cases.ts` and `apps/reader/test/config-cases.ts`:
  the invalid-config case tables used by the AC37/AC39 tests (each case: an
  env and/or apps file, the variable/field it targets, a sentinel that must
  not appear in the output).
- `apps/sync-server/test/startup-errors-doc.test.ts` (and the reader's
  `startup-errors-doc.node.test.ts`): run every case through `loadConfig` /
  `parseReaderConfig`, prefix each problem with `Config error: `, and assert
  each line fully matches a template of its section (placeholders become
  `.+?`, the rest is literal). Reverse guard: every `Config error` template
  is matched by at least one case, so the list cannot go stale. `Startup
  error` texts are fixed strings: the modules export them
  (`STARTUP_MESSAGES` in `storage/redis/connect.ts` and `storage/errors.ts`,
  `version.ts` reasons, the reader's `run.ts`), and the test checks each one
  is listed. A template must contain at least one literal word besides the
  prefix.

## 4. Files

### Create

- `docs/decisions/0015-unknown-environment-variables.md`: ADR (this commit, Proposed).
- `apps/sync-server/src/version.ts`: `readServerVersion()` and its reasons.
- `apps/sync-server/src/config/load.ts`: `loadConfig()` collecting all problems.
- `apps/sync-server/src/config/known-vars.ts`: known names, family rule, unknown check.
- `apps/sync-server/test/helpers/child-env.ts`: env for spawned servers.
- `apps/sync-server/test/config-cases.ts`: invalid-config case tables.
- `apps/sync-server/test/config-matrix.test.ts`: AC37/AC38 per variable and field, through `run()`.
- `apps/sync-server/test/unknown-vars.test.ts`: AC37a typo, no false positives, platform names.
- `apps/sync-server/test/version.test.ts`: version read and each failure reason.
- `apps/sync-server/test/ready.int.test.ts`: `/ready` and `/health` contracts.
- `apps/sync-server/test/ready.redis.test.ts`: `/ready` during outage and fence.
- `apps/sync-server/test/startup-errors-doc.test.ts`: AC40 for the server.
- `apps/reader/src/config/known-vars.ts`: (if Q-2 yes) known names and check.
- `apps/reader/test/config-cases.ts`, `apps/reader/test/config-matrix.node.test.ts`, `apps/reader/test/startup-errors-doc.node.test.ts`.
- `docs/startup-errors.md`: the list.

### Modify

- `apps/sync-server/src/config/config-error.ts`: `problems` list.
- `apps/sync-server/src/config/env.ts`: `collectEnv` + partial ceilings; `parseEnv` wrapper; names typed by `known-vars.ts`.
- `apps/sync-server/src/config/apps-config.ts`: `collectAppsConfigFile` with partial ceilings, reworded messages.
- `apps/sync-server/src/config/token-secret.ts`: `collectTokenSecrets`; wrapper kept.
- `apps/sync-server/src/config/dev-key.ts`: `devKeyProblems` + `warnDevKeys`.
- `apps/sync-server/src/config/redis.ts`: none beyond being called from `load.ts` (`parseRedisSettings` stays).
- `apps/sync-server/src/main.ts`: use `loadConfig`, one line per problem, version read, `Startup error` for it.
- `apps/sync-server/src/http/health.ts`: `createHttpHandler`, `/health` additions, `/ready`.
- `apps/sync-server/src/server.ts`: `version` option, `closing` flag, `ready()`, handler wiring, comment.
- `apps/sync-server/src/storage/redis/connect.ts`, `src/storage/errors.ts`: export their fixed `Startup error` texts.
- `apps/sync-server/Dockerfile`: comment that `package.json` is read at runtime.
- `apps/sync-server/test/http.int.test.ts`, `env.test.ts`, `apps-config.test.ts`, `token-secret.test.ts`, `dev-key.test.ts`, `main.test.ts`: new body, reworded messages, all-problems behaviour.
- `apps/sync-server/test/main.test.ts`, `main-redis.redis.test.ts`, `multi-process.redis.test.ts`, `restart-process.int.test.ts`, `dev-script.test.ts`: `childEnv()`.
- `apps/sync-server/test/outage.redis.test.ts`, `instance.redis.test.ts`: add `/ready` assertions next to the existing 503-upgrade ones.
- `apps/sync-server/test/repo-hygiene.test.ts`: Dockerfile keeps `package.json` in the runtime stage; README env table equals `KNOWN_SERVER_VARIABLES`.
- `apps/reader/src/config/schema.ts`: call the unknown check (if Q-2 yes).
- `apps/reader/server/run.ts`: export its fixed `Startup error` texts.
- `apps/reader/test/readme.node.test.ts`: README names the startup-error list.
- `README.md`, `apps/reader/README.md`, `docs/conventions.md`: docs chunk (section 8).

## 5. Data model

None. No Redis key, no stored value, no migration.

## 6. Contracts

### 6.1 `GET /health` (liveness; additive change, Q26)

- 200 while the process serves HTTP, in every storage state, also while
  closing (liveness must not restart a draining or Redis-less instance).
- Headers (unchanged): `Content-Type: application/json`, `Content-Length`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Body, keys in this order:

```json
{"status":"ok","protocolVersion":1,"minProtocolVersion":1,"version":"0.1.0","storage":"memory"}
```

`version`: the server's semver from `package.json`. `storage`: `"memory"` or
`"redis"` (kind only, never the connectivity state). No app, group, host,
address, instance ID or key prefix.

### 6.2 `GET /ready` (readiness, new)

- Path match as `/health`: query string ignored; any other method gives the
  existing 404 `{"error":"not_found"}`; `/ready/x` is 404.
- Same headers as `/health`. No `Retry-After`.
- 200 `{"status":"ready","storage":"memory"}` or `{"status":"ready","storage":"redis"}`.
- 503 `{"status":"not_ready","storage":"<kind>"}` when any of:
  - `close()` has started (Q22);
  - Redis store state is `unreachable`, which already includes: link down or
    stalled, instance fenced (12.5), pub/sub link unhealthy (12.7) (Q23).
- The memory store is always ready except while closing.
- No reason field (spec: `status` and storage kind only); operators read the
  reason from the logs (`redis_unreachable`, `instance_fenced`,
  `pubsub_resync`, `server_stopping`).
- Per instance; no cluster-wide view.

### 6.3 Config errors (stderr, exit 1)

One line per problem: `Config error: <problem>\n`. Every problem of one run
is printed before exit. `Startup error: <message>\n` stays one line, exit 1.
The exact templates are in `docs/startup-errors.md` (3.6).

### 6.4 WebSocket protocol

No change.

## 7. Docker impact

- `apps/sync-server/Dockerfile`: comment only (runtime needs `package.json`).
  The image already contains `/app/package.json`.
- Compose files: no change. `/health` stays the healthcheck. The no-false-
  positive test (9.4) parses their sync-server `environment:` maps.
- `docker compose ... config -q` for the three combinations stays in CI.

## 8. Docs impact

- `docs/startup-errors.md` (new): the list (3.6).
- `README.md`: "Run locally" health line (new body) and `/ready`; new
  subsection "Health and readiness" (both contracts, why `/health` must not
  be used for routing: it stays 200 while Redis is down or the instance is
  fenced, so the load balancer would keep sending clients that get 503 on
  upgrade; use `/ready`); "Environment variables": unknown look-alike rule
  (ADR 0015) and a link to the list; "Upgrading": 9b note (unknown names in
  the families now fail startup, no switch; all config problems are printed
  in one run, one prefixed line each; message rewording); link to the list.
- `apps/reader/README.md` "Configuration": echo rule, unknown `READER_*`
  rule (if Q-2 yes), link to the list.
- `docs/conventions.md`: a "Sync server config (#36)" row for ADR 0015 and
  the echo rule (chunk 1).
- Not here: changelog and release notes (9c, #37).

## 9. Test plan

Test runner: Vitest 4 per package (`pnpm test`); reader e2e with Playwright
(`test:e2e`, unchanged). No new framework.

### 9.1 By acceptance criterion

| AC | Test |
|---|---|
| AC33 | `ready.int.test.ts`: `/health` 200, exact body with `version` equal to `apps/sync-server/package.json` `version`; no host/address/app data (keys exactly the five). `version.test.ts`: valid file; missing file, invalid JSON, wrong `name`, missing / non-semver / over-long `version` each give their reason; `run()` with a bad version URL prints `Startup error: cannot read the server version: ...` and exits 1, after printing config problems if any. Image check L6. |
| AC34 | `/health` `storage` is `memory` on the memory store and `redis` under `SYNC_TEST_STORE=redis` (the test reads the helper's kind, so it passes in both runs); still `redis` while unreachable (`outage.redis.test.ts`). |
| AC35 | `ready.int.test.ts`: 200 ready (memory); headers; query string; POST/HEAD 404; `/ready/x` 404; a fake `Storage` whose `status()` returns `unreachable` gives 503 `not_ready` and upgrades 503; `close()` called and not awaited: `server.ready()` is false at once, and the handler unit returns 503. `outage.redis.test.ts`: 503 while Redis is unreachable or stalled, 200 again after recovery. `instance.redis.test.ts`: 503 while fenced (monotonic clock test), 200 under the new ID. |
| AC36 | `repo-hygiene.test.ts`: compose healthchecks still use `/health`; README drift test: `/ready` documented in "Health and readiness". |
| AC37 | `config-matrix.test.ts`: a case for **every** name in `KNOWN_SERVER_VARIABLES` with an invalid value (except `NODE_ENV`, which has none; documented) and for **every** key of the apps entry schema plus the file-level structure: `run()` exits 1, the output names the variable / JSON path, and the case's sentinel is absent from stderr and the logs. Coverage guards: the test fails if a known variable or an entry-schema key has no case. |
| AC38 | Same file: every cross-field rule (four ceilings-vs-caps rules, three `MAX_BUFFERED_BYTES` minimums, token refresh min/max, app over ceiling, keep-alive vs inactivity, join methods vs `JOIN_METHODS_ALLOWED`, token secret rules, previous = current, dev key, duplicates, unreadable file, invalid JSON) gives its message with the action; one run with problems in env, Redis, secrets, unknown names and the apps file prints all of them, each with the `Config error:` prefix; an invalid ceiling skips only its own app comparison (and reports the ceiling). |
| AC37a | `unknown-vars.test.ts`: `MAX_GROUP_SIZE_CIELING=SENTINEL` gives `MAX_GROUP_SIZE_CIELING is not a sync server variable; did you mean MAX_GROUP_SIZE_CEILING?`, value never printed, reported together with another problem, exit 1; `REDIS_PASSWORD` flagged without suggestion; lower-case `redis_url` flagged; 64-char cut. No false positives: the env maps of `compose.yaml`, `compose.yaml`+`compose.redis.yaml`, and `sync-server-2` of `compose.multi.yaml` (parsed from the files) plus `config/apps.dev.json` load with **no** problem; `ENV` lines of both Dockerfiles; the `env:` names in `ci.yml`; `SYNC_TEST_STORE`, `SYNC_TEST_REDIS_URL`; `NODE_VERSION`, `YARN_VERSION`, `HOSTNAME`, `HOME`, `PATH`, `CI`, `VITEST`, `npm_config_x`; Kubernetes links for services `redis`, `sync`, `sync-server` (`REDIS_SERVICE_HOST`, `REDIS_SERVICE_PORT`, `REDIS_SERVICE_PORT_REDIS`, `REDIS_PORT`, `REDIS_PORT_6379_TCP`, `..._TCP_ADDR`, `..._TCP_PORT`, `..._TCP_PROTO`, `SYNC_SERVER_SERVICE_HOST`, ...); Docker link names (`REDIS_NAME`, `REDIS_ENV_REDIS_VERSION`). |
| AC39 | Reader `config-matrix.node.test.ts`: every `READER_*` and `PORT` invalid case names the variable; non-secret values appear truncated; `READER_SYNC_URL` / `READER_SRC_ORIGINS` with credentials never show the user or password; `READER_SYNC_API_KEY` never appears; all problems in one run; `run()` exits 1. If Q-2 yes: `READER_SYNC_ULR` typo, platform names, compose reader env (existing `compose.node.test.ts` env) not flagged. |
| AC40 | `startup-errors-doc.test.ts` (server) and `startup-errors-doc.node.test.ts` (reader), as in 3.6, both directions. |
| AC41 | Existing suites unchanged in meaning (valid configs); the compose env test in AC37a; `config/apps.dev.json` and `config/apps.example.json` (with a valid secret) load; every known variable at its documented default and at a valid non-default value still parses (matrix "valid" rows). README drift: "Upgrading" mentions the unknown-variable rule. |
| AC42 | Local CI in Docker (9.3). |

### 9.2 Not covered by automated tests

- The exact moment a load balancer probe hits the 503 during shutdown (the
  listener closes at once; 3.2). Covered at the unit level only.

### 9.3 Local CI in Docker (AC42; GitHub Actions is blocked by billing)

As for #38 and #40: fresh clone from a git bundle (no `dist/`), no bind
mounts, `node:24`, pinned `redis:7.2.17-alpine@sha256:2f66...c335` with a
password, `--save ""`, `--appendonly no`, `noeviction`, on a private network;
Test before Build, as in `ci.yml`.

- L1 `pnpm install --frozen-lockfile`; L2 `pnpm audit --audit-level=high`;
  L3 `pnpm lint`; L4 `pnpm typecheck`;
- L5 `pnpm test` with `CI=true` and `SYNC_TEST_REDIS_URL`, then
  `SYNC_TEST_STORE=redis pnpm --filter @sync-system/server test`. These runs
  happen inside `node:24`, whose env has `NODE_VERSION`, `YARN_VERSION`,
  `HOSTNAME`: the spawned-server tests prove no false positive there.
- L6 `pnpm build`; the three `docker compose ... config -q`; image check:
  build `apps/sync-server/Dockerfile`, run it with a mounted dev registry
  copy baked into a throwaway image layer (no bind mounts) and
  `NODE_ENV=development`, `GET /health` shows `"version":"0.1.0"` and
  `"storage":"memory"`, `GET /ready` 200; with `REDIS_URL` to the CI Redis,
  `storage` `redis` and `/ready` 200, then `docker pause` the Redis: `/ready`
  503, `/health` 200; unpause: 200. Run the image once with
  `MAX_GROUP_SIZE_CIELING=1`: exit 1 with the AC37a line. Delete
  `/app/package.json` in a derived image: exit 1 with the version
  `Startup error`.
- L7 reader e2e (`pnpm --filter @sync-system/reader test:e2e`), 5/5.

## 10. Risks and edge cases

- **Deployments with stray family names** (for example `REDIS_PASSWORD`
  used for interpolation, or an old misspelt variable that never worked)
  stop starting after the upgrade. This is the Gate 1 decision; the message
  names the variable, the upgrade notes say so, and the docs list the
  workaround (rename it outside the families).
- **Platform names that end like a link** are never flagged, so a typo that
  happens to end in `_PORT` or `_NAME` is missed. Accepted (ADR 0015).
- **Test environments**: a developer shell with family names cannot break
  the spawned-server tests (`childEnv()`); in-process tests pass explicit env
  objects already.
- **Version file**: a future Dockerfile that copies only `dist/` would break
  startup loudly (exit 1 with the reason), never silently; the hygiene test
  catches it first.
- **Readiness flapping**: `/ready` follows `status()` exactly, which already
  has the hysteresis 9a built (probe, baseline). No extra smoothing.
- **Skipped comparisons**: with an invalid ceiling, an app value above the
  intended ceiling is reported only in the next run. Stated in the docs.
- **Information disclosure**: `/health` now shows the version and storage
  kind to anyone who can reach the port. Spec decision (AC33, AC34); the
  README advises keeping the port private behind the proxy and allowing
  `/ready` and `/health` only from the load balancer if the version is
  sensitive.

## 11. Security-sensitive areas

Security-sensitive: yes

- New unauthenticated HTTP endpoint `/ready` and a wider `/health` body:
  `src/http/health.ts`, `src/server.ts` (information disclosure; no Redis
  call per request).
- Config error messages around secrets: `TOKEN_SECRET*`, `REDIS_URL`, apps
  `apiKey`, unknown-variable check (names only, never values):
  `src/config/*.ts`, `src/main.ts`; reader echo rule:
  `apps/reader/src/config/schema.ts`.
- Reading a file at runtime (`package.json`): fixed path relative to the
  module, never from env; contents never printed.
- Test helper `childEnv()` decides what parent env reaches spawned servers.
- No new or upgraded dependency.

## 12. Implementer model

Implementer model: opus
Reason: security-sensitive, ~20 files across two packages, a new ADR, a new
HTTP contract, and a config-loader refactor where secret-handling messages
must stay value-free.

## 13. Gate 2 questions

- **Q-1 (ADR 0015) naming rule.** Recommended: option 1 (ten prefixes plus
  `_CEILING`, minus `SYNC_TEST_*` and platform link names). Trade-off: catches
  typos in 26 of 30 names and look-alikes like `REDIS_PASSWORD`; does not
  catch typos of `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV`; operators keeping
  helper variables with those prefixes must rename them. Option 2 (only
  `MAX_`, `REDIS_`, `TOKEN_`, `_CEILING`) flags less but misses typos of
  `SYNC_CONFIG_PATH`, `JOIN_METHODS_ALLOWED` and five ceilings; option 3
  (edit distance over all names) gives false positives (`HOME`/`HOST`).
- **Q-2 reader gets the same check** (`READER_` family, same exclusions).
  Recommended: yes. Trade-off: same safety for the reader's 11 variables
  (a typo like `READER_SYNC_ULR` silently turns sync off today) and the same
  behaviour on both services, at the cost of one more upgrade note and a
  failing start for anyone with a stray `READER_*` (including a Kubernetes
  service named `reader`, whose link names are excluded anyway). No: smaller
  change, AC37a stays server-only as written.
- **Q-3 server echo of validated numbers.** Recommended: keep printing numbers
  the server has already parsed (`MAX_APP_CONNECTIONS_CEILING (20000) must be
  <= MAX_CONNECTIONS (10000)`, `maxGroupSize 500 exceeds
  MAX_GROUP_SIZE_CEILING 100 ...`) and namespaces that match the pattern.
  Trade-off: these messages say exactly what to change (AC38) and cannot
  leak a secret; the alternative (names only) is stricter wording of AC37
  but makes cross-field errors harder to act on.
- **Q-4 apps checks against an invalid ceiling.** Recommended: skip only the
  comparisons that need that ceiling, report everything else. Trade-off:
  never a false error; an app value above the intended ceiling shows up only
  after the ceiling is fixed. The alternative (compare against the default)
  could report errors that vanish once the env is fixed.
- **Q-5 "did you mean" suggestion** in the unknown-variable message
  (Damerau-Levenshtein <= 2, names only). Recommended: yes. Trade-off: faster
  fix for the common typo; a few lines of code and tests.
- **Q-6 shutdown drain (informational).** Q22 is implemented as decided, but
  `close()` stops the listener at once, so the 503 is seen only on an open
  keep-alive connection; new probes are refused. Recommended: accept (both
  mean "not ready"); if a drain window (keep serving with `/ready` 503 for N
  seconds after SIGTERM) is wanted, open a follow-up issue: it is new
  behaviour and likely a new variable.

## 14. Implementation chunks

All in this repo, on `feat/36-health-readiness-config-errors`, one PR.

1. `docs(adr): accept 0015 unknown environment variables` (ADR status, Gate 2 choice, `docs/conventions.md` row)
2. `refactor(server): carry a problem list in ConfigError and print one line each`
3. `feat(server): collect every config problem in one run` (`load.ts`, `collectEnv` with partial ceilings, `collectTokenSecrets`, `collectAppsConfigFile`, `devKeyProblems`/`warnDevKeys`, `main.ts`; updated tests)
4. `feat(server): make config messages say what to change` (rewording table 3.3; updated tests)
5. `feat(server): refuse unknown look-alike env variables` (`known-vars.ts`, `childEnv()` and the five spawned-server tests, `unknown-vars.test.ts`)
6. `feat(server): read the server version from package.json` (`version.ts`, `run()` `Startup error`, Dockerfile comment, hygiene test, `version.test.ts`)
7. `feat(server): add version and storage to /health` (`createHttpHandler`, `http.int.test.ts`)
8. `feat(server): add /ready readiness endpoint` (`closing`, `ready()`, `ready.int.test.ts`, `/ready` in `outage.redis.test.ts` and `instance.redis.test.ts`)
9. `test(server): cover every env variable and apps-config field` (`config-cases.ts`, `config-matrix.test.ts`, coverage guards)
10. `feat(reader): refuse unknown READER_ variables` (only if Q-2 yes)
11. `test(reader): cover every reader variable and the echo rule` (`config-cases.ts`, `config-matrix.node.test.ts`)
12. `refactor: export the fixed startup error texts` (`connect.ts`, `storage/errors.ts`, `version.ts`, reader `run.ts`; no text change)
13. `docs: add the startup-error list` (`docs/startup-errors.md`)
14. `test: check the startup-error list against the invalid-config cases` (both packages)
15. `docs(readme): document health, readiness and config errors` (README, reader README, upgrade notes, README drift tests)

# Spec: 9b health, readiness and config errors (#36)

Issue: https://github.com/MosheRW/sync-system/issues/36
Parent spec: `docs/issues/35/spec.md` (section "9b (#36): AC33-AC42"; Q11 accepted at Gate 1; Q20-Q26 decided at Gate 1, 2026-11-15).
Path: full. Change type: feat. No UI impact (server and reader config, plus HTTP only), so no design step.

## Problem / motivation

9a (#35, merged 2026-11-15) added Redis storage and several instances. Operators and load balancers still cannot see the real state:

- `GET /health` returns only `{status, protocolVersion, minProtocolVersion}`. It has no server version and no storage kind. There is no readiness check, so a load balancer keeps sending traffic to an instance whose Redis is unreachable (its WebSocket upgrades are already refused, `server.ts` `available()`).
- Config validation was written piecemeal. Nothing guarantees that every env variable and every apps-config field is tested, that cross-field rules give an actionable message, or that the reader meets the same bar. There is no list of startup errors with their fixes.

## What exists after 9a (verified in the code)

- `apps/sync-server/src/http/health.ts`: `handleHttpRequest` serves `GET /health` with a constant body `{status:'ok', protocolVersion, minProtocolVersion}`; any other path or method gives 404 `{error:'not_found'}`. Headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. It receives no server state today.
- `SyncServer.storage()` (9a AC27) returns `StorageStatus`: `{kind:'memory'}` or `{kind:'redis', state:'connected'|'unreachable'}` (`storage/storage.ts`). The upgrade handler already uses it (`available()`); no HTTP route does.
- `main.ts` `run()`: `parseEnv`, `loadAppsConfigFile`, `parseTokenSecrets`, `parseRedisSettings` raise `ConfigError`, printed as `Config error: <message>` on stderr, exit 1, no values or keys echoed. Redis connection failures and listen/storage-start failures print `Startup error: ...` (also exit 1). These are two families of startup message.
- Server env variables are parsed in `config/env.ts` (PORT, HOST, LOG_LEVEL, NODE_ENV, config path, the `*_CEILING` set, MAX_CONNECTIONS, MAX_PENDING_HANDSHAKES, MAX_INBOUND_*, MAX_BUFFERED_BYTES, TOKEN_REFRESH_*), `config/redis.ts` (REDIS_*), `config/token-secret.ts` and `config/apps-config.ts` (JSON file).
- The sync server version exists only as `apps/sync-server/package.json` `"version": "0.1.0"`; there is no constant in code.
- The reader (`apps/reader`) has its own `GET /health` (`server/handler.ts`) and validates `READER_*` in `src/config/schema.ts`, collecting problems into one list. Unlike the server, its messages do echo a truncated value (`shown(...)`; URLs have everything up to the last `@` replaced by `***`; the API key is never shown). The reader version is a constant `READER_VERSION = '0.1.0'` in `src/config/version.ts`, kept equal to `package.json` by a test.
- 9a's own config checks (REDIS_*) are validated and tested in 9a. 9b reviews all the rest.

## User stories

- As an **operator**, I want every invalid config, Redis settings included, to stop startup with a message that tells me what to fix, so that problems are visible at once.
- As an **operator**, I want a readiness check that fails while Redis is down and a health check that shows the version and storage kind, so that load balancers and monitoring see the real state.
- As an **operator**, I want a list of every startup error with its fix, so that I can resolve a failed deploy without reading the source.

## Acceptance criteria

Numbers AC33-AC42 are kept from `docs/issues/35/spec.md`. Where the post-9a code makes something concrete, the text says so.

- [ ] AC33. `GET /health` stays a liveness check (200 while the process serves) and adds the server's semver version (`version`), read from the server's `package.json` at runtime (no checked-in constant). The architect makes sure `package.json` is present in the built image. It still carries no app, group, host or address data.
- [ ] AC34. `GET /health` adds the storage kind `storage` (`"memory"` or `"redis"`), read from `SyncServer.storage().kind` (9a AC27). It does not include the connectivity state: that belongs to `/ready`.
- [ ] AC35. A new `GET /ready` returns 200 when the instance can serve and 503 while its Redis store state is `unreachable` (the same condition under which WebSocket upgrades are refused). It always returns 200 with the in-memory store, uses the same headers and data rules as `/health` (no app, group, host or address data; `Cache-Control: no-store`), and answers per instance. The body carries `status` (`ready` or `not_ready`) and the storage kind. It also returns 503 from the moment shutdown (`close()`) starts, and 503 when the instance has fenced itself or its pub/sub is unhealthy (9a architecture 12.5), provided that state is already observable without new machinery; if it is not, the architect raises it at Gate 2 instead of adding machinery. There is no `/ready` for the reader.
- [ ] AC36. The compose healthchecks keep using `/health`, and the README documents `/ready` for load balancers (and why `/health` must not be used for routing).
- [ ] AC37. Every server env variable and every apps-config field has a test: an invalid value gives `Config error` naming the variable or field (with the JSON path for the config file), never echoes the value, and the run exits 1.
- [ ] AC38. Rules that span fields (for example app values above an env ceiling, the `MAX_BUFFERED_BYTES` minimum, the token-secret rules, unreadable or invalid JSON config files) each give a message that says what to change, and every problem is reported in one run.
- [ ] AC39. The reader's startup config (`READER_*`) meets the same standard as AC37 and AC38. The reader keeps its truncated echo for non-secret values (URL credentials redacted, API key never shown); this rule is documented in the startup-error list (AC40).
- [ ] AC40. A list of every startup error the server and the reader can print (`Config error`, and the server's `Startup error` family: Redis unreachable, cannot listen, storage start), with the fix for each, lives in the docs (moved here from 9c). A test fails if an error message produced by the invalid-config tests is missing from the list.
- [ ] AC41. No existing valid config stops working: every known variable and config field keeps accepting what it accepted before, and the repo's compose files and test configs still start. The README / upgrade notes state that unknown look-alike variables now fail startup (consequence of AC37a). There is no escape-hatch switch.
- [ ] AC37a. (Q20, decided: check and fail.) At startup, a set env variable that matches the server's naming rule but is not a known server variable (for example the typo `MAX_GROUP_SIZE_CIELING`) is a `Config error` naming the variable, never its value. It is reported together with every other problem in one run, and the run exits 1. The architect proposes the naming rule (prefixes/suffixes) at Gate 2. The rule must not flag variables set by the repo's own compose files and Dockerfiles, or by the Node/Docker runtime. A test covers a typo case and a no-false-positive case.
- [ ] AC42. CI runs locally in Docker, as for #38 and #40 (GitHub Actions is blocked by billing): node:24, pinned `redis:7.2.17-alpine`, no bind mounts, from a fresh clone. When Actions works again, the normal pipeline applies (same checks as 9a AC31).

AC37a is the extra criterion for Q20. It is numbered as a sub-number of AC37 because AC43+ are already used by 9c in `docs/issues/35/spec.md`.

## Out of scope

- Any UI change, including a status page.
- Metrics, tracing or a Prometheus endpoint.
- Changing 9a's Redis behaviour (fencing, outage handling) or its config rules; 9b only reads the store state.
- Cluster-wide readiness (it answers per instance).
- Public docs beyond the startup-error list, the changelog and releases (9c, #37).
- Auth on `/health` and `/ready` (they carry no sensitive data by AC33-AC35).

## Decisions (Gate 1, 2026-11-15)

- **Q20. Unknown env variables: CHECK AND FAIL.** The user overrode the PM recommendation (warn only). A set variable that matches the server's naming rule but is unknown is a `Config error` naming the variable (never its value), reported with all other problems, exit 1. See AC37a and AC41. The naming rule is for the architect to propose at Gate 2.
- **Q21. Server version source: read `package.json` at runtime** (the alternative; no checked constant). The architect makes sure `package.json` is available in the built image. See AC33.
- **Q22. `/ready` during shutdown: yes.** 503 from the moment `close()` starts. See AC35.
- **Q23. `/ready` on fenced / pub-sub unhealthy: yes, if the state is already observable without new machinery;** otherwise the architect raises it at Gate 2. See AC35.
- **Q24. Reader echo: keep the truncated echo for non-secret values** (URL credentials redacted, API key never shown) and document the rule. See AC39, AC40.
- **Q25. Reader `/ready`: no.**
- **Q26. `/health` body: additive only** (`version`, `storage`); `status` unchanged. See AC33, AC34.

## Open questions

- None open from Gate 1. Items deferred to the architect for Gate 2: the naming rule for AC37a, how `package.json` reaches the built image (AC33), and whether fenced / pub-sub state is observable without new machinery (AC35).

## Security note (for the orchestrator)

Security-sensitive: yes (modest). New unauthenticated endpoints expose the version and storage kind (information disclosure: keep to the AC33-AC35 data rules), and the work touches validation of secrets and error messages that must never echo secrets (AC37, Q24). Recommend running the security plan review.

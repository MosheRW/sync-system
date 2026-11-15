# Spec: 9b health, readiness and config errors (#36)

Issue: https://github.com/MosheRW/sync-system/issues/36
Parent spec: `docs/issues/35/spec.md` (section "9b (#36): AC33-AC42"; Q11 accepted at Gate 1, Q20 open).
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

- [ ] AC33. `GET /health` stays a liveness check (200 while the process serves) and adds the server's semver version (`version`; source per Q21). It still carries no app, group, host or address data.
- [ ] AC34. `GET /health` adds the storage kind `storage` (`"memory"` or `"redis"`), read from `SyncServer.storage().kind` (9a AC27). It does not include the connectivity state: that belongs to `/ready`.
- [ ] AC35. A new `GET /ready` returns 200 when the instance can serve and 503 while its Redis store state is `unreachable` (the same condition under which WebSocket upgrades are refused). It always returns 200 with the in-memory store, uses the same headers and data rules as `/health` (no app, group, host or address data; `Cache-Control: no-store`), and answers per instance. The body carries `status` (`ready` or `not_ready`) and the storage kind. Further 503 conditions per Q22 and Q23.
- [ ] AC36. The compose healthchecks keep using `/health`, and the README documents `/ready` for load balancers (and why `/health` must not be used for routing).
- [ ] AC37. Every server env variable and every apps-config field has a test: an invalid value gives `Config error` naming the variable or field (with the JSON path for the config file), never echoes the value, and the run exits 1.
- [ ] AC38. Rules that span fields (for example app values above an env ceiling, the `MAX_BUFFERED_BYTES` minimum, the token-secret rules, unreadable or invalid JSON config files) each give a message that says what to change, and every problem is reported in one run.
- [ ] AC39. The reader's startup config (`READER_*`) meets the same standard as AC37 and AC38. How the reader treats echoed values: Q24.
- [ ] AC40. A list of every startup error the server and the reader can print (`Config error`, and the server's `Startup error` family: Redis unreachable, cannot listen, storage start), with the fix for each, lives in the docs (moved here from 9c). A test fails if an error message produced by the invalid-config tests is missing from the list.
- [ ] AC41. No existing valid config stops working: the current compose files and test configs still start. Q20 (if accepted) only warns and never fails.
- [ ] AC42. CI runs locally in Docker, as for #38 and #40 (GitHub Actions is blocked by billing): node:24, pinned `redis:7.2.17-alpine`, no bind mounts, from a fresh clone. When Actions works again, the normal pipeline applies (same checks as 9a AC31).

If Q20 is accepted it adds one more criterion (numbered after Gate 1): a warning, never a failure, for set variables that look like the server's own but are unknown; the warning names the variable (not its value).

## Out of scope

- Any UI change, including a status page.
- Metrics, tracing or a Prometheus endpoint.
- Changing 9a's Redis behaviour (fencing, outage handling) or its config rules; 9b only reads the store state.
- Cluster-wide readiness (it answers per instance).
- Public docs beyond the startup-error list, the changelog and releases (9c, #37).
- Auth on `/health` and `/ready` (they carry no sensitive data by AC33-AC35).

## Open questions (Gate 1)

- **Q20. Unknown env variables.** Recommended: at startup, warn (do not fail) about set variables that look like the server's own but are unknown (a likely typo, such as `MAX_GROUP_SIZE_CIELING`). Needs a naming rule to tell which variables are the server's (for example a prefix list: `MAX_`, `TOKEN_`, `REDIS_`, ending in `_CEILING`). Alternative: no check, which avoids false warnings and a naming rule that can rot.
- **Q21. Where the server version comes from.** Recommended: a checked constant (like the reader's `READER_VERSION`, kept equal to `package.json` by a test), so it works in a bundled and a source run. Alternative: read `package.json` at runtime. 9c will use Changesets with one fixed version group, so the release flow must bump the constant (the equality test catches drift).
- **Q22. Should `/ready` also fail while the server is shutting down or draining?** Recommended: yes, 503 from the moment `close()` starts, so a load balancer stops routing before sockets close. Alternative: Redis state only, as in the AC.
- **Q23. Should `/ready` fail when the instance has fenced itself or pub/sub is unhealthy (9a architecture 12.5), even if the Redis command connection is up?** Recommended: yes, if that state is already observable from the store without new machinery, because a fenced instance cannot act and closes sessions with 1001. Alternative: connectivity only (simpler); the architect confirms what is observable.
- **Q24. Reader config messages echo truncated values; the server never does (AC37).** Recommended: keep the reader's truncated echo for non-secret values (URL with credentials redacted, version string, choice values), never echo secrets (the API key already is not shown), and state that rule in the error list. Alternative: make the reader match the server and never echo any value.
- **Q25. Does the reader get a `/ready`?** Recommended: no. The reader is a static file server with no dependency to be unready on, and its `/health` suffices. Alternative: add a `/ready` that mirrors `/health` for symmetry.
- **Q26. `/health` body field names.** Recommended: additive only (`version`, `storage`), so existing consumers (compose healthchecks) are unaffected and `status` is not renamed. Alternative: none; flagged so the architect does not rename fields.

## Security note (for the orchestrator)

Security-sensitive: yes (modest). New unauthenticated endpoints expose the version and storage kind (information disclosure: keep to the AC33-AC35 data rules), and the work touches validation of secrets and error messages that must never echo secrets (AC37, Q24). Recommend running the security plan review.

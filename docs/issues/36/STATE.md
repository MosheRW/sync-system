# State: #36 feat: 9b health, readiness and config errors
- Path: full
- Phase: merged (PR #43 merged 2026-11-18 as 0d1dba3)
- Branch: feat/36-health-readiness-config-errors
- PR: #43
- Plan approved by user: yes
- Security-sensitive: yes
- Review rounds: 1
- Last updated by: pm
## Model log
- pm grooming: sonnet (default) → DONE
- pm gate-1 update: sonnet (default) → DONE
- architect plan: opus (default + pm NEXT_MODEL) → DONE
- security plan round 1: opus (rule) → PASS
- engineer implement: opus (architect Implementer model; security-sensitive) → DONE
- qa validation round 1: opus (engineer NEXT_MODEL) → PASS
- security code round 1: opus (rule) → PASS
- pm a1 follow-up issue #44: haiku (trivial chore) → DONE
## Gate 1 decisions (2026-11-15)
- Q20: check and fail (overrides the warn recommendation); new AC37a; naming rule proposed by architect.
- Q21: read version from package.json at runtime; package.json must be in the built image.
- Q22: yes, /ready 503 from the start of close().
- Q23: yes, if fenced / pub-sub state is already observable; else raise at Gate 2.
- Q24: keep truncated echo for non-secret values; document the rule.
- Q25: no /ready for the reader.
- Q26: /health additive only (version, storage).
- AC41 narrowed; no escape-hatch switch.
## Gate 2 decisions (2026-11-15, "Approve all")
- Plan approved: yes.
- Q-1: ADR 0015 option 1 (ten prefixes plus `_CEILING`; `SYNC_TEST_*` and Kubernetes / Docker link names excluded). ADR set to Accepted.
- Q-2: yes, the reader gets the same check (`READER_` family); chunk 10 is in.
- Q-3: yes, keep validated integers (parsed, not raw) and valid namespaces in messages.
- Q-4: yes, skip only the comparisons that need an invalid ceiling (the run still exits 1).
- Q-5: yes, "did you mean" from the known-name list only (within 2 edits).
- Q-6: accept no drain window; no follow-up issue.
- Security controls C1-C10 are mandatory; low advisories L1-L7 applied as the plan absorbs them (L4: flagged names cut at 48 characters).
## Security plan review (round 1)
- PASS: critical 0, high 0, medium 1 (M1 fail-open risk of collect-mode refactor), low 6. Required controls C1-C10 in docs/issues/36/security.md are part of the plan.
## Implementation (engineer, 2026-11-15)
- All 15 planned chunks committed and pushed (072f410 .. a379d7b), plus 0b79e13 (style: escaped newline in the version startup error) and 02da5e7 (fix found by the local CI run, see Deviations).
- Controls: C1 `loadConfig` throws on any problem and returns only a complete config; collectors return `undefined` (env, Redis settings, token secrets, apps); `run()` calls it first, the logger, version read and Redis come after (config-matrix: no log output in any invalid case; secret cases: nothing listens). C2 `parseEnv` / `parseTokenSecrets` / `parseRedisSettings` / `parseAppsConfig` / `loadAppsConfigFile` / `checkDevKeys` stay as throwing wrappers. C3 one sentinel per case, Redis user / password / host separately, absent from stderr and logs. C4 names only, `[A-Za-z][A-Za-z0-9_]*`, suggestions from the known list, names cut before comparing, sorted. C5 echo rule in `docs/startup-errors.md`. C6 `shownText()` for the apps path and JSON key names. C7 prebuilt bodies, `ready()` synchronous, `closing = true` first in `close()`. C8 fixed module-relative path, 64 KiB cap before parsing, reasons only, validated string served. C9 no new dependency (audit clean). C10 placeholders only (doc test).
- Local CI in Docker at 02da5e7 (fresh clone from a git bundle, no `dist/`, no bind mounts, node:24 (24.22.3), pinned redis:7.2.17-alpine with password, no persistence, noeviction, private network; Test before Build): install --frozen-lockfile, audit (no known vulnerabilities), lint, typecheck, test (protocol 207, sync-server 1816, client 574, react 227, reader 1054), sync-server with SYNC_TEST_STORE=redis 1816/1816, build: all green. The three `docker compose ... config -q` checks pass. Reader e2e 5/5 (in the node:24 container).
- Image checks (architecture 9.3, image built from the fresh clone, dev registry baked into a throwaway layer): memory store `/health` `{"status":"ok","protocolVersion":1,"minProtocolVersion":1,"version":"0.1.0","storage":"memory"}` 200, `/ready` 200, `POST /ready` 404; with `REDIS_URL` to a private Redis: `storage` `redis`, `/ready` 200; `docker pause` Redis: `/ready` 503 `not_ready`, `/health` 200; unpause: `/ready` 200; the Redis password never in the logs. `MAX_GROUP_SIZE_CIELING=1`: `Config error: MAX_GROUP_SIZE_CIELING is not a sync server variable; did you mean MAX_GROUP_SIZE_CEILING?`, exit 1. `/app/package.json` deleted in a derived image: `Startup error: cannot read the server version: package.json not found next to the server code`, exit 1.
- The first container run (at a379d7b) failed in `packages/react` (integration test starting the real server under jsdom): fixed by 02da5e7, then the whole run above passed.
## QA verdict (round 1, 2026-11-15)
- PASS at b0f2513: checks 13/13, acceptance criteria 11/11 met (AC33-AC42, AC37a), no blocking findings.
- Local CI in Docker (fresh clone from a git bundle, no dist/, no bind mounts, node:24, pinned redis:7.2.17-alpine with password, no persistence, noeviction, private network): install, audit, lint, typecheck, test (207/1816/574/227/1054, none skipped), SYNC_TEST_STORE=redis 1816/1816, build, the three compose config checks, reader e2e 5/5. Built-image checks (9.3): /health and /ready for memory and Redis, Redis paused gives 503 then 200, typo gives the AC37a line and exit 1, missing /app/package.json gives the version Startup error and exit 1.
- GitHub Actions did not start (billing block), not a code failure.
- Advisories (no fix needed): no real pub/sub-unhealthy /ready test (covered by status() by construction); roadmap still says 9b "in grooming" (update on merge); README Upgrading has a wrapped inline code span.
- Attribution: all 23 commits signed.
## Gate 3 (2026-11-18)
- The user merged PR #43 as 0d1dba3; #36 closed.
- Security advisory A1 (control characters in echoed config values) became follow-up #44; A2 (the truncated echo, Q24) is accepted; the QA advisories needed no fix.
## Open questions
- None (Gate 2 answered every question).
- Resolved by the plan: `package.json` is already in the image (pnpm deploy output, runtime copies /out whole); fenced and pub/sub-unhealthy are already observable via `storage.status()` (Q23 met without new machinery).
## Deviations from plan
- Extra test files: `apps/sync-server/test/load.test.ts` (loadConfig order, Q-4 skips, C1 collectors, devKeyProblems/warnDevKeys) and `apps/reader/test/unknown-vars.node.test.ts` (reader rule, platform names, compose env, suffix list pinned against the server copy).
- No separate `ready.redis.test.ts`: the `/ready` outage, stall and fence assertions sit in `outage.redis.test.ts` and `instance.redis.test.ts`, as chunk 8 lists.
- `server_listening` also logs `version` (chunk 6 reads the version before `/health` uses it).
- `no-disk.test.ts` now allows `version.ts` as a second read-only file-system importer (opened with `'r'` only).
- `collectRedisSettings` returns `undefined` when any `REDIS_*` problem was found (C1); before, a valid URL next to a bad prefix or timeout built settings with the default (never used, the wrapper threw).
- ADR 0015 cut for flagged names is 48 characters (security L4), not 64; the longest known name has 36 characters (the security review said 31).
- The unknown-field message also says what to do: `(remove them or fix their names)`. `shownText()` also replaces U+0080-U+009F, U+2028 and U+2029, besides C6's control characters.
- `APP_ENTRY_FIELDS` exported from `apps-config.ts` for the coverage guard; `listenErrorMessage()` exported from `main.ts` and `STARTUP_MESSAGES.listen()` from the reader's `run.ts` (the listen text has placeholders).
- `version.ts` builds the default URL with Node's `URL` from `import.meta.url` in a variable, not `new URL(x, import.meta.url)`: Vite rewrites that pattern into an asset URL under jsdom (02da5e7).
- Cross-field env rules now run per rule when their own numbers are valid (plan 3.3); before, any env or Redis problem skipped all of them.
- README nginx example restricts `/health` and `/ready` to a private range (security L1).

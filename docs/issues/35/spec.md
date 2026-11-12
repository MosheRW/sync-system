Issue: https://github.com/MosheRW/sync-system/issues/35

# feat: redis storage, public docs and first release (PRD item 9)

Scope: PRD item 9 of 9. **Split proposed (Q1):** 9a Redis storage on one instance (this issue), 9b several instances on one Redis (own issue after Gate 1), 9c public docs, changelog and first release (own issue after Gate 1). The acceptance criteria below are grouped by sub-item and numbered once across all three, so the numbers stay stable if they move to their own issues (as was done for 8a/8b).

## Problem / motivation

Items 1-8 built the whole v1 product, but the PRD's "Deliverables and operations" section is still open:

- **Storage.** Groups live only in one process's memory. A restart drops every group; groups come back only when the leader's token recreates them, members wait in the parking lot until then, and the server-side record of ended groups is lost (accepted risk in #13). Only one server instance can run. The block list lives only in the leader's client, so after a restart blocked members are refused only once the leader returns.
- **Product readiness.** There are no public docs beyond the long root README and the package READMEs, no changelog, no license, no versioning policy and no release process. Every package is `private: true` at `0.1.0`, and the repo itself is private.
- Earlier specs deferred decisions to this item: the protocol version stays 1 until releases start here (#5 Q13, #13 Q7, #10 Q2.1); `@sync-system/react` stays `private: true` until the release item (#15 Q10); release notes for the removal of join by group ID (#10); codes, counters and pending approvals in Redis with one code namespace across instances (#10, out-of-scope list).

Source: PRD "Deliverables and operations" (Storage, Configuration, Product readiness) and "Open questions"; `docs/roadmap.md` row 9.

### What already exists (checked in the code, so the gap is real)

| PRD line | Today | Gap |
| --- | --- | --- |
| Health endpoint | `GET /health` on the sync server returns 200 `{status, protocolVersion, minProtocolVersion}`, no app or group data (#1 AC23, `apps/sync-server/src/http/health.ts`). The reader also has `/health`. Both compose services use them as healthchecks. | No storage status, no readiness check that can fail, no server version. |
| Clear startup errors for invalid config | `parseEnv` and `loadAppsConfigFile` collect every problem into one `Config error: <message>` on stderr, exit code 1, never echoing values or keys (#1 AC6, `apps/sync-server/src/main.ts`). | Nothing for Redis settings (they don't exist yet). No single list of all startup errors in the docs. |
| Storage abstraction | `GroupStore` is async and atomic per call, written so a Redis version can match it; `InMemoryGroupStore` is the only one; `createSyncServer({store})` accepts another. | Process-local state outside the store: `CodeIndex` (codes), `ApprovalQueue` (method B), `ParkingLot`, `EndedGroups`, `DoorGuard`, `KeyedLock` (per-group mutex), `GroupTimers`, `LocalNotifier` (event fan-out), connection and rate counters. Restart survival needs some of these; several instances need all of them. |
| Semver | App versions are compared as semver (#1 AC9). | The packages themselves have no versioning policy, changelog or release. |

Because health and config errors largely exist, the candidate sub-item "health endpoint and config errors" is not worth its own issue: its Redis parts go into 9a and 9b, and its docs part into 9c (see Q1).

## Split proposal (Q1)

| Sub-item | Scope | Depends on | Risk | Issue |
| --- | --- | --- | --- | --- |
| **9a** Redis storage, one instance | Optional Redis store; groups, codes, ended groups, door-code counters and timer deadlines kept in Redis; restart survival; block lists held server-side; Redis config errors; storage status in health/readiness; data lifetime and privacy rules | none | High: new runtime dependency, every store call becomes a network call, timer re-arming after restart, data-lifetime rules for names of possible minors | this issue |
| **9b** Several instances | Shared code namespace, cross-instance event delivery, cross-instance atomicity (locks), timers that fire once across instances, method B approvals across instances, instance failure, a compose example with two instances | 9a (Redis client, key layout, data lifetime) | Highest: distributed concurrency in a 1,900-line group service built on a process-local lock | new issue after Gate 1 |
| **9c** Public docs, changelog, first release | Operator and integrator docs with the reading app as the worked example, env reference, semver and changelog, publishing `protocol`/`client`/`react`, server image, license, release process runnable without GitHub Actions, protocol version decision | 9a and 9b (documents and versions them) | Medium: irreversible (a published version can't be unpublished after 72 h), needs user-owned credentials | new issue after Gate 1 |

Recommended order **9a, then 9b, then 9c**:
1. 9c documents, versions and freezes what 9a and 9b build. The protocol is frozen at version 1 at the first release, so any wire change that Redis or several instances need (for example a "storage unavailable" error) has to land before 9c.
2. 9b needs 9a's Redis client, key layout and lifetime rules; reviewing 9a's single-instance store first keeps 9b's review about concurrency only.
3. Review size: each sub-item is about the size of 8a or 8b. One PR for all of item 9 would mix a storage engine, distributed systems work and a release.

Fallback (Q2): if 9b turns out large, the user can release 1.0.0 after 9a (with "one instance only" documented) and ship several instances in a minor release, but only if 9b needs no wire changes.

No designer phase: none of the sub-items has UI impact (the reader is unchanged; docs are Markdown).

## User stories

- As an **operator**, I want groups to stay live through a server restart, so that a deploy doesn't send every group through token recovery. (9a)
- As an **operator**, I want Redis to be optional and off by default, so that a small self-hosted install keeps working with no extra service. (9a)
- As an **operator**, I want the server to refuse to start with a clear message when the Redis settings are wrong or Redis can't be reached, and a readiness check that fails while Redis is down, so that problems are visible at once. (9a)
- As a **leader**, I want a member I removed to stay out after a restart even before I come back, so that removal holds. (9a)
- As a **participant who may be a minor**, I want nothing about me kept in Redis after the group ends, so that the no-persistence promise still holds. (9a)
- As an **operator**, I want to run several sync server instances behind a load balancer on one Redis, so that I can scale and survive one instance going down. (9b)
- As a **participant**, I want to join and follow a group no matter which instance my phone connects to, so that scaling is invisible to me. (9b)
- As an **app developer**, I want public docs for the server, the protocol and the packages, with the reading app as a working example, so that I can integrate without reading the source. (9c)
- As an **app developer**, I want installable versioned packages with a changelog, so that I can depend on them and upgrade safely. (9c)
- As the **maintainer**, I want a written release process that runs on my machine in Docker, so that I can release without GitHub Actions. (9c)

## Acceptance criteria

### 9a: Redis storage on one instance (this issue)

Configuration and startup
- [ ] AC1. With no Redis setting, the server behaves exactly as today (in-memory store); the full existing server, client, react and reader test suites pass unchanged.
- [ ] AC2. Setting the Redis connection variable (name per the plan, e.g. `REDIS_URL`) makes the server use Redis for everything listed in AC7. `redis://` and `rediss://` (TLS) URLs with a password are accepted.
- [ ] AC3. An invalid Redis setting (unparseable URL, unsupported scheme, invalid companion variable such as the key prefix or connect timeout) is reported with the existing `Config error: <message>` format and exit code 1, together with every other config problem. The message names the variable and never contains the URL, host, user or password.
- [ ] AC4. If Redis can't be reached at startup within a bounded, configurable time, the server exits 1 with `Startup error: <message>` that names the problem (unreachable, auth failed, TLS failed) without the URL, host or password.
- [ ] AC5. All Redis keys are under a configurable prefix (default per the plan), so one Redis can be shared with other software or another sync deployment; two prefixes never see each other's groups (test).
- [ ] AC6. In 9a only one instance may use a prefix: a second instance started on the same prefix while the first is alive refuses to start with a clear `Startup error` (until 9b lifts this). (Q8)

What lives in Redis
- [ ] AC7. With Redis on, these survive a server restart: every live group record (all `GroupRecord` fields, including the block list, roster, codes, vice, lock, pause and term), the per-app code index (group code, alphanumeric code, door-code checks), the ended-groups record, door-code failure counts and method A pauses, and the deadlines of every group timer.
- [ ] AC8. Tokens, the token secret, QR ticket keys and API keys are never written to Redis. QR tickets stay stateless.
- [ ] AC9. Pending method B approvals are not kept across a restart on one instance (the joiner's socket is gone): after a restart the joiner sends a new request. (Their cross-instance storage is 9b.)

Restart survival
- [ ] AC10. After a restart with Redis, a member's token resume finds the group live and rejoins at once, without waiting for the leader and without the parking lot; the member gets the current position.
- [ ] AC11. After a restart with Redis, the leader's token resume finds the group live and keeps the lead; the group is not "recreated" (no recovery marking, no new term) and keeps its codes.
- [ ] AC12. A server restart is not counted against the leader: a group whose leader was online at shutdown hands off only if the leader is still away a full `disconnectGraceSeconds` after the server is back. (Q9)
- [ ] AC13. Timers are re-armed at startup from the stored deadlines. A deadline that passed while the server was down (max session, inactivity limit, grace, hold, keep-alive countdown) takes effect once at startup, with the same outcome and events as if the server had been up.
- [ ] AC14. A group that ended before the restart stays ended: checks and resumes for it get `ended` and no token can recreate it (closes the #13 accepted risk while Redis is on).
- [ ] AC15. If Redis comes back empty (flushed or replaced), recovery falls back to the existing token-based recreation with all #5 and #13 rules unchanged (test).

Server-side block lists
- [ ] AC16. With Redis on, a removed or blocked member who resumes after a restart is refused before the leader returns, with the same error as today. The leader's client may still send its block list on resume; it only adds IDs, as today.

Data lifetime and privacy
- [ ] AC17. Every Redis key of a group is deleted when the group ends, and every key carries an expiry no later than the group's latest possible end (max-session deadline, plus the ended-group guard for the ended-groups entry), so nothing outlives a group even if the delete is missed (test that inspects keys and TTLs).
- [ ] AC18. Display names, participant IDs, codes and positions in Redis are never logged; Redis errors are logged without key names that contain group IDs or codes, and without the URL or password (log-capture test).

Failure while running
- [ ] AC19. If Redis becomes unreachable while the server runs, the server stays up, never falls back to memory, and answers requests that need storage with an error (existing code or one new code, decided in the plan; Q10) without leaving a group half-updated. When Redis returns, normal service resumes without a restart (test with a stopped Redis or a failing client).
- [ ] AC20. `GET /health` keeps its current 200 body for liveness and adds the storage kind (`memory` or `redis`), still with no app, group, host or address data. A readiness check (Q11) returns 503 while Redis is unreachable and 200 otherwise; with the in-memory store it always returns 200.

Dependency, tests and tooling
- [ ] AC21. The Redis client library is chosen in an ADR at Gate 2 (Q5), pinned exactly, `pnpm audit --audit-level=high` stays clean, and it is loaded only when Redis is configured (an in-memory server never opens a Redis connection).
- [ ] AC22. One shared `GroupStore` contract test suite runs against both the in-memory store and the Redis store; the restart tests (AC10-AC16) run against a real Redis.
- [ ] AC23. Compose gets an optional Redis service (dev only, loopback port or no host port, password set, pinned image digest) that is off unless asked for (for example a compose profile); the default `docker compose up` is unchanged.
- [ ] AC24. CI: the `ci.yml` jobs pass, with the Redis-backed tests running against a Redis service in CI (not silently skipped). Because GitHub Actions is blocked by billing, QA runs the `ci.yml` jobs locally in `node:24` Docker containers exactly as for #31, with a pinned Redis container on the same Docker network.
- [ ] AC25. The README documents the Redis settings, the one-instance limit of 9a, what survives a restart, the data lifetime rules and the readiness check (full public docs are 9c).

### 9b: several instances on one Redis (own issue after Gate 1)

- [ ] AC26. Two or more instances on the same Redis and prefix start and serve together (AC6's single-instance guard is lifted); no sticky sessions are required.
- [ ] AC27. Codes are unique per app across all instances: a group created on instance A is joinable by group code, alphanumeric code, door code and QR ticket through instance B; two instances never hand out the same live code in one app (concurrency test).
- [ ] AC28. Every group event (position, roster, leader changes, lifecycle prompts, pause and resume, lock, removal with close code 4004, group end) reaches participants on every instance; a leader move on A reaches a member on B within the PRD's 1 s target (test asserts the bound on a local run).
- [ ] AC29. Every operation that is atomic on one instance stays atomic across instances (for example two joins for the last slot on two instances, two leader resumes, take-back against a handoff, create-if-absent): exactly one wins (concurrency tests).
- [ ] AC30. Each group timer fires exactly once across all instances, and still fires if the instance that armed it goes down.
- [ ] AC31. Method B approvals work across instances: a joiner on B, the leader on A; approve, deny, timeout and the leader leaving all settle the request once; pending requests live in Redis with an expiry of the approval timeout.
- [ ] AC32. When one instance stops (clean or killed), its participants reconnect through another instance by token and their groups go on; a leader on the dead instance gets the normal grace, not an instant handoff.
- [ ] AC33. Connection and rate limits have documented semantics across instances (per instance or global, Q12), with tests for the chosen one.
- [ ] AC34. A dev-only compose example runs two instances, Redis and a load balancer on loopback, and the README explains it.
- [ ] AC35. CI and docs as in AC24 and AC25, with the multi-instance tests (two in-process servers on one Redis at least) included.

### 9c: public docs, changelog and first release (own issue after Gate 1)

Docs
- [ ] AC36. Public docs in Markdown in the repo (Q13) cover: an operator guide (install with Docker Compose, the apps config file, every env var, Redis, several instances, health and readiness, upgrading, deployment security), the wire protocol v1 reference, the `@sync-system/client` API, the `@sync-system/react` API, and an integration guide that walks through the reading app as the worked example.
- [ ] AC37. The env reference lists every server env var with its default, minimum and maximum; a test fails if a variable in the code is missing from the reference or its values differ.
- [ ] AC38. The docs list every startup error the server can print (config and startup), with the fix for each.
- [ ] AC39. The PRD open question on default values and env ceilings is answered by the documented v1 defaults and ceilings, and the PRD and `docs/roadmap.md` record that (Q14).

Versioning and changelog
- [ ] AC40. A written versioning policy: semver per published package; what counts as breaking for the protocol, the client API, the React API and the server's config and env; how `PROTOCOL_VERSION` and `MIN_CLIENT_PROTOCOL_VERSION` move; which package versions work with which server.
- [ ] AC41. The first release ships protocol version 1 with minimum 1 (no bump, since nothing was released before; Q7). Stated in the changelog.
- [ ] AC42. A changelog in a consistent format (tool per Q6) exists for every published package and for the server; the first entry summarises v1 and includes notes for anyone who ran pre-release builds, among them the removal of join by group ID (#10), token format 2 (#13) and the `MAX_BUFFERED_BYTES` minimum.

Packages and release
- [ ] AC43. `@sync-system/protocol`, `@sync-system/client` and `@sync-system/react` are no longer `private`, carry the license, repository and public-access fields, and their published contents are only the build output, README, changelog and license (a check runs `pnpm pack` and lists the tarball contents).
- [ ] AC44. A smoke test installs the packed tarballs into a clean temporary project and imports each package (ESM), type-checks against its types, and renders the React provider on the server (SSR safety, #15).
- [ ] AC45. The server ships as a Docker image (registry per Q4) tagged with its semver; `GET /health` reports the server version (Q11). The reader and the server stay `private` on npm.
- [ ] AC46. A LICENSE file exists at the repo root (license per Q3) and in each published package.
- [ ] AC47. A release process document (for example `RELEASING.md`) gives the steps to release from a clean clone inside a `node:24` Docker container (no GitHub Actions): checks, version bump, changelog, tag, `pnpm publish`, image push, GitHub release notes. A dry run of those steps (no publish, no push) succeeds and QA runs it.
- [ ] AC48. Agents never publish packages, push images or create releases: the plan ends at a release candidate on the branch, and the human runs the publish step after merging.
- [ ] AC49. CI as in AC24, with the pack and smoke checks added to `ci.yml`.

## Out of scope

- Any reader UI change (no designer phase).
- A hosted offering, self-service app registration, a docs website generator or hosted docs site (unless the user picks one in Q13).
- Persisting anything beyond a group's life (PRD), session history, analytics.
- Redis Cluster or Sentinel topologies (single Redis endpoint only; Q5).
- GitHub Actions release automation and npm provenance (Actions is blocked; provenance needs CI OIDC).
- The parked follow-ups #9, #12, #21, #27, #28 and #32 as part of this issue (Q15 asks which must be fixed before the first release).

## Open questions (each with a recommended default)

- **Q1. Split.** Recommended: split into 9a (this issue, AC1-AC25), 9b (AC26-AC35) and 9c (AC36-AC49), run in that order; 9b and 9c get their own issues after Gate 1. The candidate "health and config errors" sub-item is folded in, because both exist since #1. Alternative: the three-way split from the request (Redis / health and config / docs and release), which puts the risky multi-instance work in one issue with restart survival.
- **Q2. Several instances in v1.** Recommended: keep 9b before the first release (the PRD lists it under v1 storage). Alternative: release 1.0.0 after 9a with "one instance" documented, and ship 9b as 1.1.0 if it needs no wire changes.
- **Q3. License.** Needed before anything is published, and only you can choose it. Recommended: MIT. Alternatives: Apache-2.0 (explicit patent grant), or keep it unlicensed and unpublished.
- **Q4. Registries and repo visibility.** Recommended: the three packages on the public npm registry under the `@sync-system` scope (the scope must be free or owned by you), the server image on GitHub Container Registry, and the repo made public at the first release so the docs and `repository` links work. Alternatives: GitHub Packages for npm; Docker Hub for the image; keep the repo private and publish only the packages.
- **Q5. Redis client and server versions.** Recommended: the official `redis` (node-redis) client, a regular dependency of the server loaded only when configured; support Redis 7.2+ and protocol-compatible Valkey, tested against one pinned image; single endpoint only. The architect confirms the library in an ADR at Gate 2. Alternative: `ioredis`.
- **Q6. Changelog tooling.** Recommended: Changesets (pnpm-workspace aware, works locally without Actions), with `protocol`, `client` and `react` in one fixed version group so they always share a version. Alternatives: a hand-written Keep a Changelog file; independent package versions.
- **Q7. Starting versions and protocol version.** Recommended: the first release is 1.0.0 for all three packages and the server (v1 of the PRD), protocol version stays 1 with minimum 1. Alternative: 0.x releases first (no stability promise), or bump the protocol to 2 to mark the break from pre-release builds (no one depends on those).
- **Q8. One-instance guard in 9a (AC6).** Recommended: yes, refuse a second instance on the same prefix until 9b, so state can't be corrupted silently. Alternative: document the limit only.
- **Q9. Grace after a restart (AC12).** Recommended: a full `disconnectGraceSeconds` counted from the server being back, for every group whose leader was online at shutdown. Alternative: count from the leader's last activity before shutdown (a long deploy could then hand off groups).
- **Q10. Error for "storage unavailable" (AC19).** Recommended: let the architect pick an existing retryable error code if one fits, else add one before the first release (the protocol freezes at 9c). Alternative: always close the socket and let the client reconnect.
- **Q11. Health, readiness and version (AC20, AC45).** Recommended: keep `GET /health` as liveness (always 200 while serving, plus the storage kind), add `GET /ready` (503 while Redis is unreachable), and add the server version to `/health` in 9c. Alternative: one `/health` that turns 503 when Redis is down (compose would then restart a server that can't fix Redis), or no version (slightly less disclosure).
- **Q12. Limits across instances (AC33).** Recommended: connection caps and rate limits stay per instance and are documented that way; global per-app limits are a follow-up. Alternative: global limits in Redis.
- **Q13. Docs format.** Recommended: Markdown in the repo (`docs/` guides plus package READMEs that ship in the npm tarballs), no site generator. Alternative: a static docs site (adds a dependency and a hosting decision).
- **Q14. PRD open questions.** Recommended: record the current defaults and ceilings as the v1 values (AC39), and close the lock-duration question with the #24 Gate 2 answer (30 s works when `disconnectGraceSeconds` is 45 or more; the default ceiling is 120). Alternative: revisit specific defaults first.
- **Q15. Parked follow-ups before the first release.** Recommended: fix #32 (server take-back rule, changes what the wire offers), #12 (group creation limits; its counters must work with Redis) and #21 (reader trusted types) as their own issues before 9c, ideally #12 after 9a so its counters are written for Redis once; #9, #27 and #28 don't block the release. Alternative: fold #12 into 9b, or release with all of them open and listed as known issues.

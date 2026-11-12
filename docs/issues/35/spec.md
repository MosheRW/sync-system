Issue: https://github.com/MosheRW/sync-system/issues/35

# feat: redis storage with restart survival and several instances (PRD item 9a)

Scope: PRD item 9 of 9. **Split agreed at Gate 1 (2026-11-12, Q1):**

| Sub-item | Scope | Issue | ACs | Order |
| --- | --- | --- | --- | --- |
| **9a** Redis storage | Optional Redis store: restart survival, server-side block lists, several instances on one Redis, Redis config validation and startup errors | **#35 (this issue)** | AC1-AC32 (32) | first |
| **9b** Health and config errors | `/health` storage kind and server version, `GET /ready`, review of all config and env validation, startup-error list with fixes | #36 | AC33-AC42 (10) | second |
| **9c** Public docs, changelog, release | Docs in the repo and a GitHub wiki, versioning policy, changelog, license, packages under `@mosherw`, server image, release process without GitHub Actions | #37 | AC43-AC56 (14) | third |

The acceptance criteria for all three sub-items are numbered once, so the numbers stay stable in #36 and #37. 9a is large: 32 criteria, and it combines restart survival with distributed concurrency. **The architect decides at Gate 2 whether to plan it as two PRs on this issue and branch** (for example, one PR for the store and restart survival, then one for several instances).

## Problem / motivation

Items 1-8 built the whole v1 product, but the PRD's "Deliverables and operations" section is still open:

- **Storage.** Groups live only in one process's memory.
  - A restart drops every group. Groups come back only when the leader's token recreates them, and members wait in the parking lot until then.
  - The record of ended groups is lost on a restart (an accepted risk in #13).
  - Only one server instance can run.
  - The block list lives only in the leader's client, so after a restart blocked members are refused only once the leader returns.
- **Product readiness.** Health and config errors exist but are incomplete (9b). There are no public docs beyond the READMEs, and there is no changelog, no license, no versioning policy and no release process (9c).
- **Deferred to this item by earlier specs:**
  - The protocol version stays 1 until releases start (#5 Q13, #13 Q7, #10 Q2.1).
  - `@sync-system/react` stays `private: true` until the release item (#15 Q10).
  - Release notes for the removal of join by group ID (#10).
  - Codes, counters and pending approvals in Redis, with one code namespace across instances (#10).

Source: PRD "Deliverables and operations" (Storage, Configuration, Product readiness) and "Open questions"; `docs/roadmap.md` row 9.

### What already exists (checked in the code, so the gap is real)

| PRD line | Today | Gap |
| --- | --- | --- |
| Health endpoint | `GET /health` on the sync server returns 200 `{status, protocolVersion, minProtocolVersion}` with no app or group data (#1 AC23, `apps/sync-server/src/http/health.ts`). The reader has its own `/health`. Both compose services use them as healthchecks. | No storage status, no readiness check that can fail, no server version (9b). |
| Clear startup errors for invalid config | `parseEnv` and `loadAppsConfigFile` collect every problem into one `Config error: <message>` on stderr and exit with code 1, never echoing values or keys (#1 AC6, `apps/sync-server/src/main.ts`). | Nothing for Redis settings (9a). No review of every rule, and no list of errors with their fixes (9b). |
| Storage abstraction | `GroupStore` is async and atomic per call, written so that a Redis version can match it. `InMemoryGroupStore` is the only implementation, and `createSyncServer({store})` accepts another one. | Process-local state outside the store: `CodeIndex` (codes), `ApprovalQueue` (method B), `ParkingLot`, `EndedGroups`, `DoorGuard`, `KeyedLock` (per-group lock), `GroupTimers`, `LocalNotifier` (event fan-out), and the connection and rate counters. Restart survival needs some of these; several instances need all of them (9a). |
| Semver | App versions are compared as semver (#1 AC9). | The packages have no versioning policy, changelog, license or release; all are `private: true` at `0.1.0`, and the repo is private (9c). |

No designer phase: none of the sub-items changes the UI.

## User stories

- As an **operator**, I want groups to stay live through a server restart, so that a deploy doesn't send every group through token recovery. (9a)
- As an **operator**, I want Redis to be optional and off by default, so that a small self-hosted install keeps working with no extra service. (9a)
- As an **operator**, I want to run several sync server instances behind a load balancer on one Redis, so that I can scale and survive one instance going down. (9a)
- As a **participant**, I want to join and follow a group no matter which instance my phone connects to, so that scaling is invisible to me. (9a)
- As a **leader**, I want a member I removed to stay out after a restart even before I come back, so that the removal holds. (9a)
- As a **participant who may be a minor**, I want nothing about me kept in Redis after the group ends, so that the no-persistence promise still holds. (9a)
- As an **operator**, I want every invalid config, Redis settings included, to stop startup with a message that tells me what to fix, so that problems are visible at once. (9a for Redis, 9b for the rest)
- As an **operator**, I want a readiness check that fails while Redis is down and a health check that shows the version and storage kind, so that load balancers and monitoring see the real state. (9b)
- As an **app developer**, I want public docs for the server, the protocol and the packages, with the reading app as a working example, so that I can integrate without reading the source. (9c)
- As an **app developer**, I want installable versioned packages with a changelog, so that I can depend on them and upgrade safely. (9c)
- As the **maintainer**, I want a written release process that runs on my machine in Docker, so that I can release without GitHub Actions. (9c)

## Acceptance criteria

### 9a: Redis storage (#35, this issue): AC1-AC32

Configuration and startup. AC3 and AC4 stay in 9a, not 9b: a new variable can't ship unvalidated. 9b reviews the rest of the config validation.
- [ ] AC1. With no Redis setting, the server behaves exactly as today (in-memory store), and the full existing server, client, react and reader test suites pass unchanged.
- [ ] AC2. Setting the Redis connection variable (name per the plan, for example `REDIS_URL`) makes the server use Redis for everything listed in AC7. `redis://` and `rediss://` (TLS) URLs with a password are accepted.
- [ ] AC3. An invalid Redis setting (an unparseable URL, an unsupported scheme, or an invalid companion variable such as the key prefix or the connect timeout) is reported in the existing `Config error: <message>` format with exit code 1, together with every other config problem. The message names the variable and never contains the URL, host, user or password.
- [ ] AC4. If Redis can't be reached at startup within a bounded, configurable time, the server exits 1 with `Startup error: <message>`. The message names the problem (unreachable, auth failed, TLS failed) without the URL, host or password.
- [ ] AC5. All Redis keys sit under a configurable prefix (default per the plan), so one Redis can be shared with other software or another sync deployment. Two prefixes never see each other's groups (test).
- [ ] AC6. Two or more instances on the same Redis and prefix start and serve together, with no sticky sessions required. (The former single-instance guard is dropped, not built even as an intermediate state; Q8. If the architect plans two PRs, the first one documents "one instance only" in the README until the second one lands.)

What lives in Redis
- [ ] AC7. With Redis on, the following live in Redis and survive a restart of any or all instances:
  - every live group record, with all `GroupRecord` fields: the block list, roster, codes, vice, lock, pause and term
  - the per-app code index (group code, alphanumeric code, and the door-code checks)
  - the ended-groups record
  - door-code failure counts and method A pauses
  - pending method B approvals
  - the deadlines of every group timer
- [ ] AC8. Tokens, the token secret, QR ticket keys and API keys are never written to Redis. QR tickets stay stateless.

Restart survival
- [ ] AC9. After a restart with Redis, a member's token resume finds the group live and rejoins at once, without waiting for the leader and without the parking lot. The member gets the current position.
- [ ] AC10. After a restart with Redis, the leader's token resume finds the group live and keeps the lead. The group is not "recreated" (no recovery marking, no new term) and keeps its codes.
- [ ] AC11. A server restart is not counted against the leader: a group whose leader was online at shutdown hands off only if the leader is still away a full `disconnectGraceSeconds` after the server is back (Q9).
- [ ] AC12. Timers are re-armed at startup from the stored deadlines. A deadline that passed while the server was down (max session, inactivity limit, grace, hold, keep-alive countdown) takes effect once at startup, with the same outcome and events as if the server had been up.
- [ ] AC13. A group that ended before the restart stays ended: checks and resumes for it get `ended`, and no token can recreate it. This closes the #13 accepted risk while Redis is on.
- [ ] AC14. If Redis comes back empty (flushed or replaced), recovery falls back to the existing token-based recreation, with all #5 and #13 rules unchanged (test).

Server-side block lists
- [ ] AC15. With Redis on, a removed or blocked member who resumes after a restart is refused before the leader returns, with the same error as today. The leader's client may still send its block list on resume; as today, it only adds IDs.

Several instances
- [ ] AC16. Codes are unique per app across all instances. A group created on instance A can be joined by group code, alphanumeric code, door code and QR ticket through instance B. Two instances never hand out the same live code in one app (concurrency test).
- [ ] AC17. Every group event reaches participants on every instance: position, roster, leader changes, lifecycle prompts, pause and resume, lock, removal with close code 4004, and group end. A leader move on A reaches a member on B within the PRD's 1 s target (the test asserts the bound on a local run).
- [ ] AC18. Every operation that is atomic on one instance stays atomic across instances: exactly one wins (concurrency tests). Examples: two joins for the last slot on two instances, two leader resumes, take-back against a handoff, create-if-absent.
- [ ] AC19. Each group timer fires exactly once across all instances, and still fires if the instance that armed it goes down.
- [ ] AC20. Method B approvals work across instances, for example a joiner on B and the leader on A. Approve, deny, timeout and the leader leaving each settle the request exactly once. A pending request expires in Redis after the approval timeout. A joiner whose socket was lost (for example to a restart) sends a new request.
- [ ] AC21. When one instance stops (cleanly or killed), its participants reconnect through another instance by token and their groups go on. A leader on the stopped instance gets the normal grace, not an instant handoff.
- [ ] AC22. Connection caps and rate limits stay per instance (Q12). Tests cover this, and the README says so.
- [ ] AC23. A dev-only compose example runs two instances, Redis and a load balancer on loopback, and the README explains it.

Data lifetime and privacy
- [ ] AC24. Every Redis key of a group is deleted when the group ends. Every key also carries an expiry no later than the group's latest possible end (the max-session deadline, plus the ended-group guard for the ended-groups entry), so nothing outlives a group even if the delete is missed (a test inspects keys and TTLs).
- [ ] AC25. Display names, participant IDs, codes and positions in Redis are never logged. Redis errors are logged without key names that contain group IDs or codes, and without the URL or password (log-capture test).

Failure while running
- [ ] AC26. If Redis becomes unreachable while the server runs:
  - The server stays up and never falls back to memory.
  - Requests that need storage get an error without leaving a group half-updated. The error is an existing retryable code if one fits, otherwise a new one added before the first release (Q10).
  - When Redis returns, normal service resumes without a restart (test with a stopped Redis or a failing client).
- [ ] AC27. The server exposes the store's connectivity state (memory, or Redis connected / unreachable) internally, for 9b's `/health` and `GET /ready`. 9a adds no HTTP endpoint and doesn't change the `/health` body.

Dependency, tests and tooling
- [ ] AC28. The Redis client library is chosen in an ADR at Gate 2. Recommended: the official `redis` (node-redis), supporting Redis 7.2+ and protocol-compatible Valkey, with a single endpoint (Q5). The library is pinned exactly, `pnpm audit --audit-level=high` stays clean, and it is loaded only when Redis is configured (an in-memory server never opens a Redis connection).
- [ ] AC29. One shared `GroupStore` contract test suite runs against both the in-memory store and the Redis store. The restart tests (AC9-AC15) run against a real Redis, and the several-instance tests (AC16-AC21) run at least two in-process servers on one Redis.
- [ ] AC30. Compose gets an optional Redis service, off unless asked for (for example with a compose profile): dev only, a loopback port or no host port, a password set, and a pinned image digest. The default `docker compose up` is unchanged.
- [ ] AC31. CI: the `ci.yml` jobs pass, with the Redis-backed tests running against a Redis service (not silently skipped). GitHub Actions is blocked by billing, so QA runs the `ci.yml` jobs locally in `node:24` Docker containers exactly as for #31, with a pinned Redis container on the same Docker network.
- [ ] AC32. The README documents the Redis settings, what survives a restart, running several instances, the per-instance limits and the data-lifetime rules. The full public docs are 9c.

### 9b: health endpoint and config errors (#36): AC33-AC42

Depends on 9a only for the Redis parts: AC34 and AC35 read 9a's store state (AC27). The rest (AC33, AC36-AC42) doesn't depend on Redis.
- [ ] AC33. `GET /health` stays a liveness check (200 while the process serves) and adds the server's semver version. It still carries no app, group, host or address data.
- [ ] AC34. `GET /health` adds the storage kind (`memory` or `redis`) (needs 9a AC27).
- [ ] AC35. A new `GET /ready` returns 200 when the instance can serve and 503 while its Redis is unreachable. It always returns 200 with the in-memory store, uses the same headers and data rules as `/health`, and answers per instance (Redis part needs 9a AC27).
- [ ] AC36. The compose healthchecks keep using `/health`, and the README documents `/ready` for load balancers.
- [ ] AC37. Every server env variable and every apps-config field has a test: an invalid value gives `Config error` naming the variable or field (with the JSON path for the config file), never echoes the value, and the run exits 1.
- [ ] AC38. Rules that span fields (for example app values above an env ceiling, the `MAX_BUFFERED_BYTES` minimum, the token-secret rules, unreadable or invalid JSON config files) each give a message that says what to change, and every problem is reported in one run.
- [ ] AC39. The reader's startup config (`READER_*`) meets the same standard as AC37 and AC38.
- [ ] AC40. A list of every startup error the server and the reader can print, with the fix for each, lives in the docs (moved here from 9c). A test fails if an error message produced by the invalid-config tests is missing from the list.
- [ ] AC41. No existing valid config stops working: the current compose files and test configs still start.
- [ ] AC42. CI as in AC31.

### 9c: public docs, changelog and first release (#37): AC43-AC56

Docs
- [ ] AC43. Public docs in Markdown in the repo cover:
  - an operator guide: install with Docker Compose, the apps config file, every env variable, Redis, several instances, health and readiness, upgrading, deployment security
  - the wire protocol v1 reference
  - the client API and the React API
  - an integration guide that walks through the reading app as the worked example
- [ ] AC44. The same docs appear in the repo's GitHub wiki (Q13). The repo Markdown is the source of truth, and a documented sync step produces the wiki pages from it.
- [ ] AC45. The env reference lists every server env variable with its default, minimum and maximum. A test fails if a variable in the code is missing from the reference or its values differ.
- [ ] AC46. The PRD open question on default values and env ceilings is answered by the documented v1 defaults and ceilings. The phone-lock question is closed with the #24 Gate 2 answer (a 30 s lock works when `disconnectGraceSeconds` is 45 or more). The PRD and `docs/roadmap.md` record both (Q14).

Versioning and changelog
- [ ] AC47. A written versioning policy:
  - semver per published package
  - what counts as breaking for the protocol, the client API, the React API, and the server's config and env
  - how `PROTOCOL_VERSION` and `MIN_CLIENT_PROTOCOL_VERSION` move
  - which package versions work with which server
- [ ] AC48. The first release is 1.0.0 for the packages and the server, and ships protocol version 1 with minimum 1 (no bump, since nothing was released before; Q7). The changelog states this.
- [ ] AC49. A changelog made with Changesets (Q6), with the protocol, client and React packages in one fixed version group. The first entry summarises v1 and includes notes for anyone who ran pre-release builds: the removal of join by group ID (#10), token format 2 (#13) and the `MAX_BUFFERED_BYTES` minimum.

Packages, license and release
- [ ] AC50. The protocol, client and React packages are published under the `@mosherw` npm scope (exact names per the 9c Gate 1 question Q16). They are no longer `private`, and carry the license, repository and public-access fields. Their published contents are only the build output, README, changelog and license (a check runs `pnpm pack` and lists the tarball contents).
- [ ] AC51. A smoke test installs the packed tarballs into a clean temporary project, then imports each package (ESM), type-checks against its types, and renders the React provider on the server (SSR safety, #15).
- [ ] AC52. The server ships as a Docker image tagged with its semver, in the registry chosen in 9c's Gate 1 (Q17). The reader and the server stay `private` on npm.
- [ ] AC53. The license is GPL-3.0 with SPDX identifier `GPL-3.0-only` (Q3):
  - The full text is in a root `LICENSE` file and in each published package.
  - Every `package.json` has `"license": "GPL-3.0-only"`.
  - The docs state that the GPL also covers the client and React packages. An app that bundles them and ships that bundle (including browser bundles) is bound by the GPL's terms.
- [ ] AC54. A release process document (for example `RELEASING.md`) gives the steps to release from a clean clone inside a `node:24` Docker container, without GitHub Actions: checks, version bump, changelog, tag, `pnpm publish`, image push, wiki sync, and GitHub release notes. A dry run of those steps (no publish, no push) succeeds, and QA runs it.
- [ ] AC55. Agents never publish packages, push images, push to the wiki repo (`<repo>.wiki.git`) or create releases. The plan ends at a release candidate on the branch, and the human runs or approves each outward step after the merge.
- [ ] AC56. CI as in AC31, with the pack and smoke checks added to `ci.yml`.

## Out of scope

- Any reader UI change (no designer phase).
- A hosted offering, self-service app registration, and a docs-site generator (Q13 chose repo Markdown plus the wiki).
- Persisting anything beyond a group's life (PRD), session history, analytics.
- Redis Cluster or Sentinel topologies: a single Redis endpoint only (Q5).
- Global connection or rate limits across instances (Q12): a possible follow-up.
- GitHub Actions release automation and npm provenance: Actions is blocked, and provenance needs CI OIDC.
- The parked follow-ups #9, #12, #21, #27, #28 and #32 as part of item 9 (Q15).

## Decisions (Gate 1, 2026-11-12)

The user accepted every recommended default except Q1, Q3, Q4 and Q13, which were changed as follows.

- **Q1. Split (changed).**
  - 9a (#35) is all Redis storage: restart survival, server-side block lists and several instances.
  - 9b (#36) is health and config errors.
  - 9c (#37) is docs, changelog and release.
  - Order: 9a, 9b, 9c. The architect may plan 9a as two PRs on this issue.
- **Q2. Several instances before 1.0 (accepted):** in 9a (AC6, AC16-AC23).
- **Q3. License (changed): GPL-3.0, SPDX `GPL-3.0-only`.**
  - Why `-only` and not `-or-later`: `-or-later` would let terms in future GPL versions, written by the FSF, apply to the code. `-only` keeps the terms under the owner's control, which fits the plan to maybe relicense later.
  - The user may relicense to MIT later. That stays simple only while the user is the sole copyright holder: after outside contributions it needs every contributor's consent, or a contributor agreement in place before they contribute.
  - The GPL also binds apps that bundle the client and React packages.
  - It is the GPL, not the AGPL: running a modified server as a network service does not require offering its source.
- **Q4. Registries and repo visibility (changed, partly open):** the packages are published under the user's npm scope `@mosherw` (`@mosherw/sync-system`), not `@sync-system`. The exact package names, the server image registry and the repo visibility are open for 9c's own Gate 1 (Q16-Q18).
- **Q5. Redis client (accepted):** the official `redis` (node-redis), loaded only when configured; Redis 7.2+ and Valkey; a single endpoint. Confirmed by an ADR at Gate 2.
- **Q6. Changelog tooling (accepted):** Changesets, with protocol, client and React in one fixed version group.
- **Q7. Versions (accepted):** 1.0.0 for everything; protocol version 1, minimum 1.
- **Q8. Single-instance guard (moot):** 9a ships several instances, so AC6 now requires them to work together, and no guard is built.
- **Q9. Grace after a restart (accepted):** a full `disconnectGraceSeconds` from when the server is back (AC11).
- **Q10. Error when storage is unavailable (accepted):** an existing retryable code if one fits, otherwise a new one before the first release (AC26).
- **Q11. Health and readiness (accepted):** `/health` stays liveness and adds the storage kind and server version, plus a new `GET /ready` (9b: AC33-AC35).
- **Q12. Limits across instances (accepted):** per instance, documented (AC22).
- **Q13. Docs format (changed):** Markdown in the repo and a GitHub wiki (AC43, AC44). The details are open for 9c's Gate 1 (Q18, Q19).
- **Q14. PRD open questions (accepted):** AC46.
- **Q15. Parked follow-ups (accepted):** #32, #12 (after 9a, so its counters are written for Redis once) and #21 are fixed as their own issues before 9c. #9, #27 and #28 don't block the release.

## Open questions

### 9a (#35)
- None. Implementation choices (the Redis variable names, the key layout, the locking and timer-ownership method, the event fan-out channel) belong to the architect, with the Redis client in an ADR at Gate 2.

### 9b (#36): for its own Gate 1
- Q20. Unknown env variables. Recommended: at startup, warn (don't fail) about set variables that look like the server's own but aren't known (a likely typo, such as `MAX_GROUP_SIZE_CIELING`). This needs a naming rule to tell which variables are the server's. Alternative: no check.

### 9c (#37): for its own Gate 1
- Q16. Package names under `@mosherw`. Recommended: three packages, `@mosherw/sync-system-protocol`, `@mosherw/sync-system-client` and `@mosherw/sync-system-react`: separate versions and dependencies, and React apps only pull React. Alternative: one package `@mosherw/sync-system` with subpath exports (`/protocol`, `/client`, `/react`), where React becomes an optional peer dependency.
- Q17. Server image registry. Recommended: GitHub Container Registry (`ghcr.io/mosherw/sync-system-server`). Alternative: Docker Hub.
- Q18. Repo visibility. Recommended: make the repo public at the first release, so that the docs links, the `repository` field and the wiki work for users. Alternative: keep it private. Then the wiki needs a paid GitHub plan, and npm users can't follow the source links.
- Q19. Wiki source and publishing. Recommended: the repo Markdown is the source of truth, and a script copies it into a local clone of `<repo>.wiki.git` (renaming files and links for the wiki). The human reviews and pushes that clone as an outward step, like `npm publish`. Hand edits in the wiki are overwritten at the next sync. Note that a wiki on a private repo needs a paid plan or the repo going public (Q18). Alternative: the wiki as the source, with the repo docs generated from it (not recommended: wiki edits bypass review).

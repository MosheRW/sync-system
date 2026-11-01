# Spec: #1 Sync server core and monorepo scaffold

Issue: https://github.com/MosheRW/sync-system/issues/1
Source PRD: `docs/PRD Group Reading Sync.md`
Path: full | Type: feat | Issue 1 of 9

## Problem / motivation

Group Reading Sync (see `docs/PRD Group Reading Sync.md`) is two products: a sync service that lets an ad-hoc group follow one leader's position in real time, and a reading app that is its first customer. Nothing exists yet. This issue is the first of 9 and lays the foundation: the monorepo every later package lives in, and the sync server core that stores and relays an **opaque** position for isolated, ephemeral, in-memory groups across multiple registered client apps.

Core principle carried into this issue: **the server syncs a position, not a page.** It never reads the position payload or the group metadata.

## Decisions made at intake (user)

- TypeScript monorepo with pnpm workspaces.
- Node sync server over WebSockets (`ws` or Socket.IO; the architect decides).
- Later packages: framework-free TS core client, React/Next package, Next.js reading app (not in this issue).
- Vitest for tests. Docker Compose for running the server.
- The PRD is split into 9 issues worked in order; this is issue 1 of 9.
- Joining in this issue uses a **temporary** mechanism (join by group ID). Join methods A-D are issue 4.
- Lock-tolerance success criterion: **30 seconds** (confirmed at Gate 1; enforced in later issues, recorded here).

## Gate 1 decisions (user)

- All proposed defaults and env ceilings accepted as written (see "Defaults" below), including the timer values recorded for issue 5.
- An app config value above its env ceiling is a startup error, not clamped (AC5).
- App versions and the configured minimum app version are semver (AC9).
- In this issue, a leader disconnect ends the group with a "group ended" event (AC17).
- Over-rate leader updates are rejected, not coalesced (AC22).
- Added: max message size for position payload and group metadata (AC27).
- Added: GitHub Actions CI workflow (AC28).
- pnpm workspaces confirmed.

## User stories

- As a **self-hosting operator**, I want to register client apps (API key + namespace + app settings) in a JSON config file and cap their settings with env variables, so that one server can serve many apps without any app hurting the others.
- As an **operator**, I want the server to refuse to start with a clear message when its config is invalid, and a health endpoint I can probe, so that misconfiguration is caught immediately and the container can be monitored.
- As a **client app developer**, I want my app's leader to create a group and broadcast any payload and metadata I choose, so that I can sync whatever "position" means in my app without the server knowing about it.
- As a **group member**, I want to receive the group's current position as soon as I join and on every leader update, so that I am always on the leader's position.
- As a **client app developer**, I want a clear rejection when my client's protocol version or app version is too old, so that I can prompt users to update instead of failing in confusing ways.
- As a **user who may be a minor**, I want my IP address and name kept out of server logs, so that nothing personal outlives the session.
- As a **contributor**, I want one command each for lint, typecheck, test and build across the monorepo, so that every later issue builds on a consistent toolchain.

## Acceptance criteria

### Monorepo scaffold
- [ ] AC1. The repo root is a pnpm workspace (`pnpm-workspace.yaml`, root `package.json`) using TypeScript with a shared base `tsconfig`.
- [ ] AC2. From a clean clone, `pnpm install` followed by `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` each run across all workspace packages and exit 0.
- [ ] AC3. The sync server lives in its own workspace package and its tests run with Vitest.

### Client-app registry and configuration
- [ ] AC4. The server loads client apps from a JSON config file (path settable by env variable). Each app entry has at least: API key, namespace, minimum app version, max group size, max leader update rate, max message size.
- [ ] AC5. Env variables define ceilings for every client-set value in this issue (max group size, max leader update rate, max message size). An app value above its ceiling causes a startup error naming the app namespace and field (values are never clamped).
- [ ] AC6. The server exits non-zero at startup with a human-readable error identifying the problem when: the config file is missing or not valid JSON; a required field is missing or has the wrong type; two apps share an API key or a namespace; an env ceiling is not a positive number. The error never prints API key values.
- [ ] AC7. A connection that presents an unknown or missing API key is rejected with a distinguishable error code and is not attached to any app.

### Handshake and version checks
- [ ] AC8. On connect, the server declares its sync protocol version and the minimum client protocol version it accepts. A client declaring a protocol version below the minimum is rejected with a distinguishable "protocol too old" error that includes the server's minimum.
- [ ] AC9. A client declaring an app version below its app's configured minimum app version is rejected with a distinguishable "app version too old" error that includes the minimum, so the client can prompt the user to update. App versions and the configured minimum are semver and compared as semver; a configured minimum that is not valid semver is a startup error, and a client app version that is not valid semver is rejected.
- [ ] AC10. No group action (create, join, update) is accepted before a successful handshake.

### Groups and position sync
- [ ] AC11. An authenticated client can create a group, supplying opaque group metadata (content ID, fingerprint, schema version) and optionally an initial position payload. The server returns a long, unguessable group ID, and the creator becomes the group's leader.
- [ ] AC12. A client can join a group of its own app by group ID (temporary mechanism for this issue). On join it immediately receives the group metadata and the current position payload (or an explicit "no position yet").
- [ ] AC13. When the leader sends a position update, every connected member of that group receives the new payload, and later joiners receive the latest payload.
- [ ] AC14. The server stores and relays the position payload and group metadata deep-equal (as JSON) to what the leader sent, including arbitrary extra fields; tests prove the server does not depend on or alter any field inside them.
- [ ] AC15. Only the leader can send position updates; an update from a member is rejected with an error and not relayed.
- [ ] AC16. Groups are in memory only: after a server restart no group exists (recovery is issue 3).
- [ ] AC17. A disconnected member is removed from the group. In this issue, when the leader disconnects the group ends and members are notified with a "group ended" event; a group with no connections is removed from memory (temporary behavior; lifecycle, grace period and handoff are issue 5).

### Isolation
- [ ] AC18. App isolation: a client of app B joining with a group ID belonging to app A gets the same "group not found" error as for a nonexistent ID, and never receives app A's payloads.
- [ ] AC19. Group isolation: members of group X never receive updates, metadata or events of group Y, in the same app or another app.
- [ ] AC20. There is no message or endpoint that lists groups.

### Limits
- [ ] AC21. Max group size: the effective limit is the app's value (never above its env ceiling). A join that would exceed it is rejected with a distinguishable "group full" error; the leader counts toward the size.
- [ ] AC22. Leader update rate limit: the effective limit is the app's value (never above its env ceiling). Updates beyond the limit are rejected with a distinguishable "rate limited" error to the leader and are not relayed; the group's stored position stays the last accepted one. Over-rate updates are never coalesced or queued.
- [ ] AC27. Max message size: the position payload and the group metadata are each limited by a max message size, set per app (default 16 KB) and capped by an env ceiling. A create or update whose payload or metadata exceeds the effective limit is rejected with a distinguishable "message too large" error and is neither stored nor relayed; the group's stored state is unchanged.

### Operations, privacy and packaging
- [ ] AC23. `GET /health` returns HTTP 200 with a JSON body that includes the server status and protocol version, and reveals no app, group or participant data.
- [ ] AC24. Server logs never contain client IP addresses, display names, API key values, position payloads or group metadata contents. A test captures log output during connect/create/join/update/error flows and asserts this.
- [ ] AC25. A `Dockerfile` builds the sync server image, and `docker compose up` from the repo root starts the server with the config file mounted, env ceilings set, and a healthcheck that uses `/health`.
- [ ] AC26. A short README section documents how to run the server locally and with Docker Compose, the config file format, and the env variables with their defaults.
- [ ] AC28. A GitHub Actions workflow runs on `push` and `pull_request` and executes `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`; the workflow fails if any step fails. A `pnpm-lock.yaml` is committed.

## Defaults (confirmed at Gate 1)

| Setting | App default | Env ceiling (default) |
| --- | --- | --- |
| Max group size (incl. leader) | 30 | 100 (`MAX_GROUP_SIZE_CEILING`) |
| Max leader update rate | 5 updates/second | 10 updates/second (`MAX_LEADER_UPDATE_RATE_CEILING`) |
| Max message size (payload, metadata; each) | 16 KB | env-set (`MAX_MESSAGE_SIZE_CEILING`); default value: see Open questions |

Timer values for issue 5 (recorded only, not implemented here):

| Timer | App default | Env ceiling |
| --- | --- | --- |
| Disconnection timeout / grace period | 30 s (matches 30 s lock tolerance) | 120 s |
| Inactivity limit | 20 min | 60 min |
| Keep-alive prompt countdown | 60 s | 120 s |
| Max session time | 3 h | 8 h |

Env variable names are illustrative; the architect finalizes them.

## Out of scope (and which later issue covers it)

- Core framework-free JS client package: sockets, reconnect, client-side version checks (refusing unsupported servers) -> **issue 2**.
- JWT tokens, restart recovery, block list / removed members, sending stored tokens to find live groups -> **issue 3**.
- Join methods A-D (group + door code, code + approval, alphanumeric code, QR), join-method selection per app, door-code rate limiting -> **issue 4**. The group-ID join here is temporary.
- Roles beyond leader/member (vice-leader, remove member, lock group, preview mode), timers, group lifecycle, leadership handoff, keep-alive, display names / generated names -> **issue 5**.
- React/Next package -> **issue 6**.
- Reading app content, schema versions, fingerprint computation, RTL/LTR -> **issue 7**.
- Reading app sync UX (prompts, connection indicator, leader views) -> **issue 8**.
- Optional Redis storage, multi-instance, public docs, changelog and semver release process -> **issue 9**.
- Everything listed under "Out of scope and future work" in the PRD.

## Open questions

Gate 1 resolved all earlier questions (see "Gate 1 decisions" above). One detail remains:

1. **Max message size env ceiling default:** the app default is 16 KB; what should the env ceiling default to? Proposed: 64 KB. Until confirmed, the architect may treat 64 KB as the working value.

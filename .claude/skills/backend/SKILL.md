---
name: backend
description: 'Backend engineering guidance for Node.js + TypeScript services: choosing a realtime transport when undecided (WebSocket vs Socket.IO vs SSE), service structure, validation, errors, config, logging, health checks, Docker/compose, realtime rooms and presence, join codes/PINs, privacy-by-design (storing little or nothing), scaling, and DB/migration checks when a database is involved. Use when planning, implementing, or reviewing any server-side change.'
---

# Backend

Project decisions in `docs/conventions.md` and `docs/decisions/` override
everything here. If something this skill needs is undecided, the architect
proposes it as an ADR (`docs-conventions`). Never pick silently.

## Choosing a realtime transport (architect, only when undecided)
| Option | Good when | Costs |
|---|---|---|
| **WebSocket (`ws`)** | Any client (web, native, third-party) must connect with a plain, documented protocol; small footprint | You build reconnect, rooms, heartbeats, acks yourself |
| **Socket.IO** | Only your own JS clients; want rooms, reconnect, acks out of the box | Custom protocol, so third-party clients need the Socket.IO client; heavier |
| **SSE + HTTP POST** | Mostly server→client updates; simple infra and proxies | One-way stream; client→server goes over separate requests |
A **client-agnostic** service (other apps must integrate) leans toward plain
WebSocket or SSE with a published protocol spec. Recommend one; list the runner-up.

## Structure
- Layers: transport (HTTP/WS handlers) → application services → domain logic →
  adapters (storage, external APIs). Domain logic doesn't import the transport.
- Validate **every** input at the boundary (HTTP bodies, query params, WS
  messages) with a schema (e.g. zod). Reject unknown message types explicitly.
- Typed, versioned message/API contracts in one shared place; document them.
- Errors: typed domain errors mapped to status codes/messages at the edge;
  never leak stack traces or internals to clients.

## Config, logs, health (12-factor)
- All config from environment variables, validated at startup (fail fast);
  `.env.example` documents every variable; no secrets in code or images.
- Structured JSON logs with a request/connection ID. **Never log** codes/PINs,
  tokens, or user content.
- `/health` (process alive) and `/ready` (dependencies OK) endpoints.
- Graceful shutdown: stop accepting, notify connected clients, close within a timeout.

## Docker / compose
- Multi-stage build, non-root user, pinned base image, `.dockerignore`,
  `HEALTHCHECK`. One process per container.
- Compose: service names as hostnames, env via `env_file`, healthcheck-based
  `depends_on`, no published ports beyond what's needed.
- Any change to Dockerfiles or compose: `docker compose config` must pass.

## Realtime sessions (rooms, presence, codes)
- Model: session/group → members → one authoritative shared state (e.g. current
  page) plus who may change it (owner/host). Server is the source of truth.
- Join codes/PINs: generated server-side with enough entropy for their lifetime;
  short expiry; **rate-limit join attempts** per IP/connection; identical
  error for wrong vs expired codes; codes never in logs or URLs that get logged.
- Presence: heartbeat with timeout; clean up members and empty groups.
- On (re)join, send a full state snapshot, then deltas. Version or sequence-number
  state so clients can detect gaps and request a resync.
- Limits: max message size, max messages/sec per connection, max members per
  group, max groups per IP. Check WebSocket `Origin` for browser clients.
- Owner leaves: define it explicitly (transfer, freeze, or end the group).

## Privacy by design (store little or nothing)
- Keep ephemeral state in memory with TTLs; persist only what a requirement
  needs, and document why in an ADR.
- If horizontal scaling is needed, use a shared ephemeral store (e.g. Redis
  with TTLs, pub/sub between instances), not a durable database.
- Self-hosted and hosted builds behave the same; differences only via config.

## When there is a database
Migration checklist for architect (plan) and QA (review):
backward compatible with the running code (expand → migrate → contract);
data backfill plan; indexes for new queries; rollback plan; no destructive
change without an explicit user decision; generated client/types updated.

## Testing (only if the repo has tests)
- Unit: domain logic (state transitions, permissions, code expiry).
- Integration: real server on a random port with real WS/HTTP clients; cover
  join, wrong code, rate limit, owner change, disconnect/reconnect, resync.

## Review checklist
Input validation on every boundary; authorization on every state-changing
message (is this sender the owner?); limits and rate limits in place; no
sensitive data in logs; config validated; health checks and graceful shutdown;
protocol docs updated.

# 0011. Group atomicity with Redis: a per-group unit of work, then a fenced lease lock

- Status: Proposed
- Date: 2026-11-12
- Issue: #35

## Context

Every state change of a group runs under its per-group lock (`KeyedLock`,
process-local): `GroupService` takes the lock, reads the record, makes
several store calls (`patch`, `setBlockList`, `addParticipant`, ...),
arms timers and notifies sessions, all in one critical section. That is
what makes "exactly one wins" true today (two leader resumes, take-back
against a handoff, the last slot, create-if-absent).

With Redis two things break:

1. **A half-updated group (AC26).** A critical section makes up to about
   eight store calls. If Redis drops between two of them, the group is
   left half-changed (for example the leader online but the roster not
   updated, or the pause set but no grace timer).
2. **Several instances (AC18, PR 2).** A process-local lock does not stop
   instance B from changing a group while A is inside its critical section.

The business logic (about 4,000 lines across `group-service.ts`,
`join-service.ts`, `lifecycle-service.ts`, `leader-controls.ts`) is written
as "read under the lock, decide, write, notify". A design that keeps that
shape keeps every #5, #10 and #13 rule and its tests.

## Options

1. **Unit of work per locked task, plus a fenced Redis lease lock
   (recommended).**
   - PR 1: inside `locks.run(group, task)` the Redis store reads each key
     once into a per-task cache and applies every call to the cached copy
     with the same logic as the in-memory store (so snapshots and
     read-your-writes behave as today). Timer changes and the group's
     side keys (codes, door state, ended entry, indexes) are buffered too.
     When the task returns, everything is written in **one** `MULTI`/`EXEC`
     (or one Lua script where a check is needed). Session effects
     (`deliver`, `broadcast`, `detach`, `close`) go to an outbox that is
     flushed only after the commit succeeded. A failed commit writes
     nothing and sends nothing (see ADR 0014 for what the clients see).
   - PR 2: the process-local lock becomes a Redis lease lock per group
     (`SET lockKey token NX PX 10000`, renewed every 3 s while the task
     runs, released by compare-and-delete), with a local `KeyedLock` in
     front so one instance queues its own tasks without polling Redis.
     The commit script checks `GET lockKey == token` before it writes
     (fencing): a holder that lost its lease (GC pause, network split)
     cannot write over the new holder. Waiting for a held lock retries
     with jitter up to a bound (5 s), then the request fails as storage
     unavailable.
   - Pros: the business logic and its ordering stay as they are; one
     commit per operation makes AC26 hold by construction; fencing makes
     AC18 safe even when a lease expires. Cons: one lock round trip per
     group operation in PR 2 (a few hundred microseconds on a LAN); the
     unit of work is new infrastructure that every store call goes
     through.
2. **Optimistic concurrency (`WATCH`/`MULTI` or a version compare in Lua)
   with retries.** Read, compute, commit if the version is unchanged, else
   redo. Pros: no lock keys. Cons: the critical sections have side
   effects mid-way (sessions attached, frames queued, timers armed), so a
   retry needs every handler rewritten as a pure "compute a change set"
   function first; under contention (several joins for the last slot)
   retries pile up. Much larger rewrite and new behaviour to verify.
3. **Group ownership: each group lives on one instance, others forward to
   it.** Pros: in-process locks stay. Cons: needs request forwarding
   between instances (an RPC layer), ownership handover when an instance
   dies, and every participant on another instance pays a hop. Far more
   moving parts than a lock.
4. **Separate store calls, no unit of work (status quo) plus the Redis
   lock.** Cons: fails AC26 (a drop between calls leaves a half-updated
   group).

## Decision

Proposed: **option 1**. PR 1 builds the unit of work and the effect
outbox (used by both stores, so there is one code path), PR 2 adds the
fenced lease lock.

## Consequences

- `GroupStore` keeps its method set; the Redis store implements it on top
  of a task-scoped cache found through `AsyncLocalStorage`, so call sites
  do not change. Writes outside a locked task are allowed only for
  `create` (a fresh 256-bit group ID, nobody else can hold it).
- Effects (`deliver`, `broadcast`, `afterPending` closes) inside a locked
  task are queued and flushed in order after the commit. On the in-memory
  store the commit cannot fail, so the observable order per socket stays
  as today (the reply still follows the task); the full existing suites
  prove it (AC1).
- A Redis group document is one JSON value; the group's whole state is
  written in one step. Its size is bounded by the roster cap (about 64 KiB
  at the default group size ceiling of 100).
- PR 2 must keep every locked section short (no waiting on clients inside
  it), which is already the rule today.

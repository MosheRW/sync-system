# 0013. Group timers in Redis: a due-time sorted set with lease claiming

- Status: Proposed
- Date: 2026-11-12
- Issue: #35

## Context

Each group has up to six timers (`GroupTimers`: max session, frozen end,
keep-alive prompt, keep-alive deadline, grace; plus the door-pause end of
`DoorGuard`). Today they are `setTimeout`s with closures, lost on a
restart, and each callback takes the group lock and re-reads the record,
so a stale or repeated firing is a no-op (lazy timers, #13 D7).

With Redis:

- AC7, AC12: the deadlines live in Redis; after a restart they are armed
  again, and a deadline that passed while the server was down takes effect
  once at startup.
- AC19 (PR 2): each timer fires exactly once across instances, and still
  fires when the instance that armed it is gone.

The token refresher, the parking-lot expiry and the per-connection limits
stay process-local: they belong to a live socket on one instance.

## Options

1. **Due-time sorted set with lease claiming, polled by every instance
   (recommended).** A timer is a hash field `<prefix>:v1:t:<ns>:<gid>`
   (`kind -> {at, data}`) plus a member `<ns>:<gid>:<kind>` in the sorted
   set `<prefix>:v1:due` scored by `at`. Arming and clearing are part of
   the group's unit of work (ADR 0011), so a timer and the state it
   guards are written together. Each instance runs one poller: a local
   wake-up at the earliest known `at` (re-read after every arm) and a
   safety poll every 1 s. A due member is claimed with a Lua script that
   moves its score to `now + 30 s` only if it is still `<= now` (a lease);
   the claimer runs the kind's handler under the group lock and removes
   the member if its score is still the leased one. A crash after the
   claim lets the lease run out and another instance (or the restarted
   one) fires it again; the handlers are already idempotent (they re-read
   the record and check the deadline), so the effect happens once.
   Pros: survives restarts and instance loss; one mechanism for one or
   many instances; the existing handlers stay. Cons: up to the poll
   interval of extra latency when the local wake-up was missed (only
   after a crash or when another instance armed it), one small Redis
   query per second per instance.
2. **Keyspace notifications on expiring keys.** Redis notifies on key
   expiry. Cons: needs `notify-keyspace-events` server config (often
   disabled on managed Redis), expiry events are delivered when Redis
   evicts the key lazily (not on time), and pub/sub delivery is
   at-most-once: a missed event is a timer that never fires.
3. **Owner-instance timers with failover.** The instance that armed a
   timer keeps it in memory; a dead instance's timers are re-armed by
   whoever sweeps its attachments. Cons: two code paths (normal and
   failover), timers of a group spread over instances, and the restart
   case still needs a persistent table to re-arm from.
4. **Derive deadlines from the record at startup only.** Most deadlines
   can be computed from the record (`createdAt`, `lastActivityAt`,
   `pause`), so a startup pass over every live group could re-arm them.
   Cons: needs a list of live groups anyway, solves only the restart case
   (not AC19), and PR 2 would replace it.

## Decision

Proposed: **option 1**. Poll interval 1 s, lease 30 s, both fixed
constants (`limits/constants.ts`), not env settings. Timer callbacks are
replaced by a dispatch by kind (`maxSession`, `frozenEnd`,
`keepAlivePrompt`, `keepAliveDeadline`, `grace`, `doorPauseEnd`) with
small data (`{term, at}` for the grace), so nothing but plain data is
stored. The in-memory backend keeps `setTimeout` behind the same
interface.

## Consequences

- `GroupTimers` gets a backend interface; the in-memory backend keeps
  today's timing exactly (AC1).
- Instances compare deadlines with their own clock (`scheduler.now()`),
  so instances need synchronised clocks (NTP); the README says so. The
  tests drive the poller with the existing manual scheduler.
- The `due` set and timer hashes are deleted with the group (AC24) and
  every timer hash carries the group's TTL.
- At startup, past-due timers are handled in the first poll, before the
  server accepts connections (AC12).

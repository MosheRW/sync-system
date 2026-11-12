# 0014. What clients see while Redis is unreachable

- Status: Accepted (Gate 2, 2026-11-12: user chose the recommended option 1)
- Date: 2026-11-12
- Issue: #35

## Context

AC26: if Redis becomes unreachable while the server runs, the server stays
up and never falls back to memory; requests that need storage get an error
without leaving a group half-updated; the error is "an existing retryable
code if one fits, otherwise a new one added before the first release"
(Q10); when Redis returns, service resumes without a restart.

What exists today:

- `INTERNAL_ERROR` is the reply when a handler throws. The client's
  automatic rejoin treats **any** server error on `group.resume` as final:
  the group ends for the client (`rejoin_failed`) and the token is kept or
  dropped per code (`packages/client/src/rejoin.ts`). So `INTERNAL_ERROR`
  during a Redis outage would drop every reconnecting participant out of
  its group: not retryable in practice.
- Close code `1001` (`GOING_AWAY`) is already a "busy" signal for the
  client, and a refused upgrade (HTTP 503, as at the connection cap) is a
  retryable `CONNECTION_LOST`: in both cases the client keeps the group in
  `rejoining`, reconnects with growing backoff, and resumes with its token
  when it is back (`classifyClose`, #3 M3).
- ADR 0011: a failed commit writes nothing and sends nothing, but the
  local session objects of that group may already reflect the attempted
  change (an attach, a detach), so they must be resynced from the store.

## Options

1. **Close and refuse, no new code (recommended).**
   - A request whose storage step fails: the connection is closed with
     `1001`, and every other local session of the same group too (they
     resync by resuming). No error frame is sent.
   - While the store state is `unreachable`: WebSocket upgrades get HTTP
     503 (as at the connection cap), so clients back off instead of
     looping through hello and a failing resume.
   - Disconnect rules that could not be written are queued in memory per
     group and replayed under the group lock when Redis is back (the
     existing ownership re-check skips a participant that resumed
     meanwhile). A server killed with the queue unsent is covered by the
     startup sweep (PR 1) or the orphan sweep (PR 2).
   - Pros: existing, documented, retryable signals; no protocol change
     before the freeze; existing clients already behave correctly
     (groups survive the outage on the client side). Cons: an outage
     disconnects users instead of answering per request; `1001` is named
     "server shutting down" in the protocol notes and gets a second
     meaning (documented as "server temporarily unavailable").
2. **New error code `STORAGE_UNAVAILABLE` (retryable).** The reply to the
   failed request, with `retryAfterMs`. Pros: explicit per request.
   Cons: a protocol addition (error code list, client error table,
   client rejoin rule to treat it as `lost`, React docs); the local
   session state of the group still has to be resynced, so sessions are
   closed anyway; old pre-release clients would drop their group.
3. **`INTERNAL_ERROR` as today.** No change. Cons: reconnecting clients
   lose their group (above): fails the intent of AC26.

## Decision

Accepted: **option 1**: close `1001` for the affected group's local
sessions, 503 at the upgrade while unreachable, replay queued disconnects
on reconnect. The server keeps `INTERNAL_ERROR` for real bugs only.

## Consequences

- No wire protocol change in 9a; the protocol notes in the README widen
  the meaning of `1001` to "the server is going away or temporarily
  unavailable; reconnect with backoff".
- The store reports `connected` / `unreachable` (AC27); 9b's `/ready`
  uses it.
- Requests that do not need storage (hello, ping) keep working; a
  connected participant in a group notices the outage only when its group
  needs a write or a read.
- Clients reconnecting during the outage meet 503 with backoff; after
  Redis returns they resume and get the current state.

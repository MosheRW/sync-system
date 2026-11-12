# 0012. Cross-instance event delivery: one pub/sub channel per instance

- Status: Accepted (Gate 2, 2026-11-12: user chose the recommended option; applied in PR 2 of #35)
- Date: 2026-11-12
- Issue: #35 (applies to PR 2 of 9a)

## Context

Several instances (#35 AC6, AC16-AC23) mean a group's participants sit on
different instances. Every group event must reach them (AC17: position,
roster, leader changes, lifecycle prompts, pause and resume, lock, removal
with close code 4004, group end), within the PRD's 1 s target. Some effects
are not plain frames but session actions on the other instance: detach a
replaced session (`replaced`), detach and close a removed one (4004), end
the membership on group end, attach an approved joiner (method B), admit
parked members after a recreation.

Today `LocalNotifier` maps a membership key (`namespace:groupId:pid`) to the
local session that owns it, and the outbox of ADR 0011 already collects
every effect of a locked task and flushes it after the commit.

PR 2 also adds an attachment registry in the group document: which
instance owns each attached participant (`pid -> instanceId`), written in
the same commit as the attach or detach. So the sender of an effect
already knows which instance must apply it.

## Options

1. **One channel per instance, addressed through the attachment registry
   (recommended).** Each instance subscribes once, at startup, to
   `<prefix>:v1:ch:<instanceId>`. After a commit, the outbox groups the
   effects by owning instance: local ones are applied directly, the rest
   are published as one message per instance
   (`{v:1, effects:[{op, key, text?, close?}]}`). Pros: no per-group
   subscribe or unsubscribe churn and no race between subscribing and
   being attached; a message goes only to instances that have someone in
   the group; channel names hold no group ID or code. Cons: depends on the
   registry being correct (it is written in the same commit as the
   membership, under the group lock).
2. **One channel per group.** Each instance subscribes to the channels of
   groups it has sessions in. Pros: the sender needs no registry lookup.
   Cons: a SUBSCRIBE per attach and an UNSUBSCRIBE per last detach; an
   event published between the commit and the subscription is lost; every
   instance gets every event of a group even for one participant; channel
   names carry group IDs (visible in `PUBSUB CHANNELS` and `MONITOR`).
3. **Redis Streams per instance with consumer acknowledgement.** Pros:
   replay after a short subscriber outage. Cons: memory to trim, delivery
   bookkeeping, and the replay is of little use: after an outage the
   session state is resynced anyway (below). More code for no gain.
4. **One global channel.** Simplest, but every instance processes every
   event of every group: cost grows with instances times events.

Pub/sub is at-most-once. In every option except 3, an instance whose
subscriber connection dropped may have missed effects. Rule for all
options: when the subscriber reconnects, the instance closes every local
session that is in a group with close code 1001 (the client's busy
signal), so the clients resume and get the current state from the store.
The same happens when the instance loses Redis (ADR 0014).

## Decision

Accepted: **option 1**, channel `<prefix>:v1:ch:<instanceId>`, the
instance ID a fresh 128-bit random value per process start (never logged
in full; a short hash only).

## Consequences

- The `Notifier` interface grows from "local sessions" to "membership
  effects": `deliver`, `broadcast`, `detach(reason, closeCode?)`,
  `attach`, applied locally or published. `GroupService` code that reads
  local sessions to decide things (`sessionOf(...).isOpen()` for the
  successor, `anyoneAttached`) reads the registry instead.
- A frame published to another instance is the serialized server message;
  it contains what the same frame contains today (names and IDs only to
  the leader, as now). It travels inside Redis, which is in the operator's
  trust zone; the README says to protect Redis (password, TLS, private
  network).
- Ordering: one publish per instance per commit keeps the per-group order
  of effects for every recipient, because commits of a group are
  serialized by the lock and Redis keeps the order of messages on one
  connection.
- No protocol change.

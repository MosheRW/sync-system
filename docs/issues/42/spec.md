# Spec: #42 treat a just-started instance as live when picking a successor

Issue: https://github.com/MosheRW/sync-system/issues/42 (follow-up to #35)
Path: fast | Type: fix

## Problem
A newly started instance is seen as live by its peers only after their next heartbeat (up to 5 s), because peers read a 5 s live-instance cache. Two places depend on it:

1. **Grace end (`graceEnded`).** A grace ending on a peer inside that window skips the new instance's members as successors. If no other member is eligible, the group stays paused until the leader returns or the frozen bound (~25 min) ends it. Most likely during a rolling deploy.
2. **Handoff (`handoff`, security finding S4, low).** The old-leader check reads the same cache, so an old leader on a just-registered instance can be dropped without a detach message.

Sources: `docs/issues/35/architecture.md` section 12.18, `docs/issues/35/STATE.md`, QA round 2 and security S4 on PR #40.

## Acceptance criteria
- [ ] When a grace ends on instance A within 5 s of instance B starting, and B holds the only eligible members, the successor pick includes B's members and the group is not left paused.
- [ ] A multi-instance test covers this: end a grace on A within 5 s of B starting, and assert a B member becomes leader (or the group resumes) without waiting for the next heartbeat or the frozen bound.
- [ ] `handoff` does not drop an old leader on a just-registered instance without sending a detach message; a multi-instance test covers it.
- [ ] A truly dead or unregistered instance is still skipped (existing take-back and grace tests still pass).
- [ ] The liveness check only produces `isOpen()` hints; it never grants membership, leadership or approval by itself.
- [ ] Any extra Redis read on a cache miss is bounded (no read per member per tick), and a Redis error behaves as "not live", as today.
- [ ] Control C12 notes (in `docs/issues/35/architecture.md` or a new architecture note) are updated, and security plan review passes.
- [ ] Existing server checks (lint, typecheck, unit, multi-instance tests) pass.

## Out of scope
- Shortening or removing the 5 s live-instance cache for other uses.
- Changing the frozen bound (~25 min) or grace durations.
- Other #35 follow-ups (#39, #41).
- Storage create-budget TTL / live-group cleanup (#47, worked in parallel).

## Open questions
- Which fix: direct Redis liveness check on cache miss (used in both `graceEnded` and `handoff`), or one-time grace re-arm after a heartbeat? Architect decides, with security plan review. Note the re-arm option alone may not cover the `handoff` criterion.

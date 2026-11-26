# Spec: #86 fix(sync-server): stale pubsub probe result can replace a healthy link

Issue: https://github.com/MosheRW/sync-system/issues/86  (Refs: #80)

## Problem
`RedisPubSub.probe()` (`apps/sync-server/src/storage/redis/pubsub.ts`) has no
in-flight guard and does not check, after the `await`, that the probed link is
still the current one. With overlapping probes, a late failed result for an
already-replaced link replaces the new healthy link again: an extra resync and
every group session on the instance closed with 1001 a second time.
Unreachable with defaults (probe 5000 ms, command timeout 2000 ms); reachable
when `REDIS_COMMAND_TIMEOUT_MS` > probe interval (config allows up to 30000).
Context: `docs/issues/80/architecture.md` section 3.

## Acceptance criteria
- [ ] A probe result for a link that is no longer the current `this.sub` is ignored and never triggers `replace`.
- [ ] At most one probe is in flight per instance; a probe tick while one is in flight is skipped.
- [ ] The in-flight flag is cleared when a probe settles (success, failure, or timeout), so later ticks still probe.
- [ ] A test with overlapping probes (command timeout > probe interval, e.g. the old fast timings of the stalled-link test) fails before the fix (double replace) and passes after.
- [ ] A genuinely stalled link is still detected and replaced exactly once (no weakening of stall detection C15/F20).
- [ ] Existing sync-server unit and redis tests still pass.

## Out of scope
- Changing default probe interval or command timeout values.
- Test-timing changes in #80 (already merged).
- Other sync-server work (#87, #41, #48).

## Open questions
- None.

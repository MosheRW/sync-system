# Security review (plan): #42 treat a just-started instance as live when picking a successor

Issue: https://github.com/MosheRW/sync-system/issues/42 | PR: #74 (draft) | Path: fast
Reviewed: [spec.md](spec.md), [architecture.md](architecture.md), #35
[architecture 12.6, 12.8, 12.13, 12.18](../35/architecture.md#1218-risks-and-edge-cases),
#35 [security C11-C14, F17, F18](../35/security.md), and the current code it touches
(`lifecycle-service.ts` `graceEnded`/`handoff`/`announce`, `succession.ts`,
`group-service.ts` `recipient`/`orphans`/host wiring, `cluster-notifier.ts` `resolve`,
`storage/redis/instance.ts` `liveOf`/`looksLive`, `leader-controls.ts` take-back).

**Verdict: PASS** (critical 0, high 0, medium 0, low 2).

## Assets and trust boundaries

- **Leadership of a group** (who gets `leader.granted` and a leader token) and
  **membership** (`participantIds`, member tokens in `leader.lost`).
- **The liveness signal**: `P:inst:<id>` keys in Redis (truth) and the per-instance
  live cache (hint, up to 5 s stale).
- **Logs** (no pids, instance IDs or group data, #35 AC25 / L7).
- Boundaries: client WebSocket → server (unchanged; no new message or endpoint);
  server → Redis (one extra `MGET` of server-written, pattern-validated keys).
  Every input to the new read (pids, instance IDs, attach IDs) comes from the stored
  record and the registry read under the lease, never from a client message.

## Threats (STRIDE, brief)

| Threat | Who / how | Assessment |
|---|---|---|
| Elevation: become leader by looking "live" | A client cannot influence `P:inst:*` or the registry; the read only re-labels pids that `pickSuccessor`'s record filters (participant, roster `connected`, not leader / displaced / blocked) already allow. | Not possible if controls R1-R2 hold. |
| Elevation: keep membership after a handoff | The old leader stays in `participantIds` only if its own registry entry names an instance whose key exists. It was already a participant; nothing new is granted. Keeping is the fail-safe direction (sweep / reconcile remove it later from Redis truth, C12/C13). | Acceptable; this actually brings `handoff`'s removal into line with C12 (removal now needs a Redis-confirmed miss, not a cache miss). |
| Tampering: key injection via instance ID | Instance IDs come from the zod-validated registry (`INSTANCE_ID_PATTERN`), and `liveOf` filters again before building keys. | Covered (R3). |
| DoS: amplify Redis load via grace ends / take-backs | Grace ends are timer-driven (one per leader absence longer than the grace); take-backs are limited to the displaced leader, once per handoff (#32), and rate-limited (`takeBackLimiter`); group creation is rate-limited and budgeted. Each event already costs a lease acquire, an `MGET` and a `COMMIT`; the fix adds at most one `MGET` of at most (distinct instances in the group's registry) keys, and only on a cache miss. Attackers cannot force misses except via instances that genuinely just started or died. | No amplification (R4). |
| DoS: hold the lease longer | One extra round trip under the lease, bounded by `REDIS_COMMAND_TIMEOUT_MS` (default 2 s, inside the 10 s lease). Same exposure as every other in-task Redis call. | Acceptable. |
| Info disclosure: logs | New `liveness_hint_failed` warn with `err: safeErr(err)` only. | Covered (R5). |
| Repudiation / spoofing | No change to tokens, auth or message handling. | n/a |

## Findings in the plan

| # | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| L1 | Low | architecture.md "Approach" step 6, `handoff` take-back path | If the `[old]` read fails (Redis error/timeout), the old leader is treated as "not live" and dropped from `participantIds` without `leader.lost`: the S4 situation recurs on that path. Its session can keep receiving group frames as a non-participant until the sweep/reconcile. The spec mandates "error = not live" and the following `COMMIT` most likely fails on a real outage, so impact is small. | Accept as stated, or (optional) note it in the 12.18 bullet as the residual S4 case. No code change required. |
| L2 | Low | architecture.md "Risks": dead-but-key-alive / fenced instance | A Redis-confirmed "live" for a key that has not expired yet (killed instance, or an entry naming this instance's own pre-fence ID, up to ~15 s) can now pick a successor there; the grant effect is lost and the group gets a leader who isn't there until the sweep/reconcile puts it offline with a new grace. This is the existing 12.18 behaviour (the cache had the same lag), not a new exposure. | No change required; keep the 12.18 bullet accurate when updating the C12 notes. |

No critical, high or medium findings.

## Required controls (part of the plan)

- **R1 Hint only (AC5, C12).** The set from `openHints`/`openOf` is used only as the
  `isConnected` argument of the unchanged `pickSuccessor` and for `oldAttached` in
  `handoff`. It is not used to write the registry, `participantIds`, roster
  `connected`, approvals, tokens, or to skip any lease/fence check. `pickSuccessor`
  keeps all its record filters (do not replace `eligible` with `open.has`).
- **R2 Candidates from the record.** `openOf` is called only with pids from
  `successorCandidates(record)` plus `record.leaderId` (grace end) or `[old]`
  (take-back). `successorCandidates` applies the same filters as `pickSuccessor`
  (participant, roster `connected`, not leader / displaced / blocked) so the read
  never covers pids outside the record.
- **R3 Validated keys.** Only instance IDs from registry entries (`RemoteRecipient`)
  go to `liveOf`; keep `liveOf`'s `INSTANCE_ID_PATTERN` filter. Local recipients are
  never sent to Redis (a closed local session stays "not open").
- **R4 Bounded reads.** At most one `liveOf` call per grace end (shared with the
  `handoff` it triggers) and one per take-back; distinct instance IDs only; no read
  when every relevant pid is a cache hit, when there is no cluster, or when no miss
  is remote. No read per member, per tick, or in any other `isOpen()` caller.
- **R5 Logging.** `liveness_hint_failed` at warn with exactly `{ event, err: safeErr(err) }`:
  no pid, instance ID, attach ID, namespace-scoped IDs or group data. Logged once
  per failed read (not per pid).
- **R6 Error = not live, task continues.** A throw from `liveOf` leaves the misses
  "not open" and does not abort the grace end or take-back; the error does not
  escape `openHints` (no unhandled rejection).
- **R7 Under the lease.** The read happens inside the existing leased task, before
  `pickSuccessor` / the `participantIds` patch, so decisions still commit under the
  lease and commit fence (C11, C14). No new Redis key, script, or write.
- **R8 Removals unchanged.** `orphans`, sweep, reconcile, `disconnectStale` and the
  legacy pass keep reading Redis themselves; the live cache and `looksLive` are not
  modified or refreshed.
- **R9 Tests.** In addition to the planned tests:
  - unit: `onError` gets the error and the logger call carries only `err` (no
    instance ID / pid in the log record);
  - unit: a pid that Redis says is live but is blocked, displaced, the current
    leader, not a participant, or roster-disconnected is still never picked (AC5);
  - unit: `liveOf` throwing does not reject `openHints`;
  - the planned "50 pids on 2 missed instances → one call with 2 IDs" bound test.

## What I will check in code mode

- R1-R8 in `open-hints.ts`, `succession.ts`, `lifecycle-service.ts`
  (`graceEnded`, `handoff` signature and the take-back path), and the host wiring in
  `group-service.ts`; `leader-controls.ts` unchanged.
- That `open` is computed once per grace end and passed into `handoff`.
- No other `isOpen()` caller changed; no change under `src/storage/**`.
- The new log event shape and redaction; no new `info`/`debug` lines with IDs.
- The tests in R9 and the planned multi-instance tests (including AC4: a stopped
  instance is still skipped).
- C12 notes in `docs/issues/35/architecture.md` (12.6, 12.13, 12.18) match the code.
- Scanners: gitleaks, semgrep (changed files), `npm audit` (no dependency change expected).

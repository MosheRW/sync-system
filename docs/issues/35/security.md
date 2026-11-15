# Security review (plan): #35 Redis storage (PRD item 9a)

- Mode: plan, round 1. Reviewer: Security Engineer (Opus).
- Reviewed: [`architecture.md`](architecture.md) (PR 1 in depth, section 12 PR 2
  outline), ADRs [0010](../../decisions/0010-redis-client-and-supported-servers.md)-[0014](../../decisions/0014-behaviour-while-redis-is-unreachable.md)
  (Proposed), [`spec.md`](spec.md) AC1-AC32, and the code the plan touches
  (`groups/resume.ts`, `groups/ended-groups.ts`, `groups/group-service.ts` end
  path, `tokens/token-service.ts`, `logging/logger.ts`, `ws/upgrade.ts`,
  `config/token-secret.ts`, `compose.yaml`, `ci.yml`).
- Dependency checked on the npm registry (2026-11-12): `@redis/client` 6.3.1
  exists, is `latest`, MIT, zero dependencies.

**Verdict: PASS.** No critical or high finding. The plan already carries the
main controls (password kept out of `ServerEnv` and messages, `safeErr` only,
zod on the group document with "invalid is never missing", hashed refs for
ended groups, no tokens/secrets in Redis, delete-on-end plus TTLs, dynamic
import, fail-fast with `1001`/503, no memory fallback). The findings below are
medium/low. The **required controls** in section 5 are part of the plan: the
engineer implements them and I check them in code mode.

## 1. Assets and trust boundaries

| Asset | Where it lives after this change |
| --- | --- |
| `REDIS_URL` password | env -> `RedisSettings` -> `@redis/client` options (process memory only) |
| Display names (possibly of minors), participant IDs, positions, block list | group document in Redis (TTL <= `E`), PR 2 also pending approvals |
| Join capabilities: group IDs, 6-digit group codes, alphanumeric codes, door codes | group document, code-index key **names and values**, `due`/`live` members |
| Recovery fence (#13 6.9): ended entries, epoch, recovery closures | `P:e:*`, `P:epoch` |
| Token secret, tokens, QR ticket keys, API keys | process only, never Redis (AC8) |

Trust boundaries:

1. **Client -> server** (unchanged): every frame is still zod-validated at the
   WebSocket edge; nothing new is accepted from clients.
2. **Server <-> Redis (new).** Redis is in the operator's trust zone: anyone
   with write access to the prefix can rewrite any group (leader, block list).
   That is inherent and accepted; the plan documents password, `rediss://`,
   private network. Data read back is still treated as input (fail closed,
   never fail open).
3. **Operator config -> server**: `REDIS_*` env.
4. **Process -> logs/stderr**: must never carry the URL, password, host, keys
   with IDs or codes, names, IDs, codes or positions (AC3, AC4, AC25).

## 2. Threats (STRIDE, brief)

| | Who / what | Threat | Plan's answer |
| --- | --- | --- | --- |
| S | Holder of an old leader token | Recreates a group that ended (AC13) | Ended entries in Redis + epoch fence (4.5). See F1, F2, F7. |
| S | Removed/blocked member | Resumes after a restart before the leader returns | Block list in the document (AC15). OK. |
| T | Anyone with Redis access | Edits documents, epoch, ended entries | Trust zone; zod on documents. F1 widens validation to every value. |
| T | Malformed client input reaching key names or Lua | Key/Lua injection | Fixed key builders (4.1). F6 makes it a hard rule. |
| R | n/a | | |
| I | Logs, stderr, startup errors | Password, host, keys, names leak | Separate `RedisSettings`, `safeErr`, log-capture tests. F9. |
| I | Redis persistence (RDB/AOF), disk | Names of possible minors outlive the group | README advice; F3 for the compose override. |
| I | A deploy that reuses the committed dev Redis password | Redis readable by anyone on the network segment | F5. |
| D | Redis outage, slow or black-holed Redis | Reconnect storms, unbounded replay queue | 503 + `1001`, bounded queue. F4, F8. |
| D | A participant that makes a commit fail on purpose | Every local session of the group closed with `1001` (griefing) | F8. |
| D | Busy groups writing a whole document per position update | Redis bandwidth/latency exhaustion -> timeouts -> mass `1001` | F10. |
| E | Second instance on PR 1 | Interleaved commits break "exactly one wins" | README forbids it until PR 2 (accepted). |

## 3. Findings (PR 1)

No critical, no high.

| # | Sev | Location | Issue / attack scenario | Fix (required control) |
| - | --- | --- | --- | --- |
| F1 | Medium | 4.3, 4.5, 6 | Only the group document is zod-validated. The epoch, ended entries (`{ns, guardUntil?}`), `P:e:closed` values, timer hash data (`{term, at}`), code-index values (`gid`) and `INFO` fields are also read back. A non-numeric epoch or `guardUntil` gives `NaN`, and every comparison with `NaN` is false: `iat >= NaN` makes a token "not from this epoch" and `now < NaN` makes recovery "not closed", so a corrupted value **fails open** into recreation. (Exploit needs Redis write access or a foreign program on the prefix, hence medium.) | Validate **every** value read from Redis with a schema. On the recovery path an invalid value fails **closed**: invalid epoch or closure -> treat as `ended` / closed and log `store_document_invalid` (no key, no value); invalid ended entry -> `ended`; invalid timer data -> drop the timer, keep the group (handlers re-read the record). Unit tests for each with `NaN`, strings, negative and missing values. C1. |
| F2 | Medium | 3 step 5, Q-A6, 16 | Eviction policy other than `noeviction` is only a warning. Under `allkeys-*` Redis can evict `P:epoch` (no TTL) and ended entries; the next miss sets a new epoch, so leader tokens of ended groups become `recoverable` and can recreate them: AC13 silently degrades to the #13 accepted risk. Under `volatile-*` guarded ended entries can go (pre-epoch tokens of a recreated group). | Q-A6 warning is acceptable, but: the warning text and the README must say that any eviction policy other than `noeviction` voids the "ended stays ended" guarantee (AC13) and can drop live groups; the README tells operators to set `maxmemory` with `noeviction`. Also map Redis `OOM` replies to `StorageUnavailableError` (they are the expected failure under `noeviction`), not `INTERNAL_ERROR`. C2. |
| F3 | Medium | 13.1 `compose.redis.yaml`, 4.2 | The official `redis` image started without a config file keeps the built-in RDB save points (`save 3600 1 300 100 60 10000`) and declares `VOLUME /data`. The CI command disables persistence, but the plan does not say so for the compose override, so a local run writes display names to `dump.rdb` in an anonymous volume that outlives the group and the container (contradicts the "nothing kept after the group ends" story, and self-hosters copy compose files). | The compose override runs `redis-server --requirepass ... --save "" --appendonly no`, mounts no volume for `/data` (or a `tmpfs`), and `repo-hygiene.test.ts` asserts both flags. Same flags in `ci.yml` and the local CI command (already there). C3. |
| F4 | Medium | 8, ADR 0014 | The `unreachable` state is driven by client events (`error`/`end`/`reconnecting`). A black-holed or stalled Redis (no RST) keeps the socket "ready" while every command times out, so upgrades are not refused with 503, clients reconnect into failing resumes, and the replay queue keeps growing for as long as the stall lasts. | A command or commit timeout (and `LOADING`/`READONLY`/`MASTERDOWN`/`BUSY`/`OOM`) also sets the state to `unreachable` until a probe (`PING`) succeeds; recovery to `connected` only after a successful probe. Replay queue: a `Set` per group keyed by session/attach identity (not just pid), a hard global cap (e.g. `MAX_CONNECTIONS`; on overflow drop the oldest and rely on the startup-sweep rules being re-run for that group on recovery), cleared after replay, entries for a group that no longer exists or whose participant re-attached on another session are dropped under the lock. Test: stalled proxy (accepts, never answers) -> `unreachable`, 503, queue bounded. C4. |
| F5 | Medium | 10, 14 (compose dev password) | The compose override commits a public dev Redis password. The project already refuses the committed dev token secret and dev API key outside development (`config/token-secret.ts`); without the same rule, an operator who copies `compose.redis.yaml` gets a Redis whose password is on GitHub. `redis_no_password` would not fire (a password is set). | Name the dev password in one constant and refuse it at startup (`Startup error` or `Config error`, no value echoed) unless `NODE_ENV` is `development` or `test`, exactly like `DEV_TOKEN_SECRET`. Compare the parsed password, never log it. Add a `.gitleaks` allowlist entry only if a scanner flags the dev value. C5. |
| F6 | Medium | 4.1, 4.4, 5 (`keys.ts`, `scripts.ts`) | Code strings in join requests are client input and become key names (`P:c:<ns>:g:<code>`). Not exploitable as planned (fixed builders, Lua via `defineScript`), but a single string-built key or script would allow key-space confusion (`:`), glob abuse or Lua injection. | Hard rules: every key built only in `keys.ts`, which asserts each component's format (`ns`, 43-char base64url `gid`, 6 digits, the alphanumeric code alphabet, 32-hex `ref`) and throws otherwise; Lua scripts are constant strings, every dynamic value passed through `KEYS`/`ARGV`; no `KEYS`, `SCAN` by pattern or `EVAL` of built strings in production code (tests only). `keys.test.ts` covers rejected components. C6. |
| F7 | Medium | 4.4 `createIfAbsent`, 4.5 | Recreation is decided from the ended entry and epoch read at the start of the task; the commit only does `SET NX` on the document. On PR 1 the group lock serializes this, but a Redis flush or an ended write between read and commit is not re-checked, and PR 2 inherits the gap. | The recreation commit (Lua) re-checks atomically: `NOT EXISTS P:e:<ref>`, `P:epoch` equals the value used to classify, and the document is absent; otherwise abort as "ended" (or retry the classification once). Also ensure the epoch exists (`SET NX`) in every `create` commit, so tokens issued right after a flush are never older than the epoch set later. C7. |
| F8 | Medium | 8, ADR 0014 | Any `StorageUnavailableError` in a locked task closes **every** local session of the group with `1001`. If deterministic errors (script error, `WRONGTYPE`, `ERR` replies, document over a size limit, a bug) are classified as "unavailable", one participant who can trigger such an error repeatedly disconnects the whole group (griefing). | Only connection-class errors, timeouts and the listed transient replies (`LOADING`, `READONLY`, `MASTERDOWN`, `BUSY`, `OOM`, `TRYAGAIN`) are `StorageUnavailableError`. Every other Redis reply is `INTERNAL_ERROR` to the requester only, logged with `safeErr`, and never closes other sessions. Test: a forced `ERR` from the commit closes nobody else. C8. |
| F9 | Low | 3 (`REDIS_URL` parsing, startup) | Node's `ERR_INVALID_URL` carries the raw input in `err.input`; `@redis/client` error messages carry host and port; the client options object holds the password. The plan's rules cover this, listed so the tests target them. | Catch the `new URL` error and discard it (message from a constant); every Redis error logged only through `safeErr`; never log the client, its options or `RedisSettings`; `RedisSettings` gets a `toJSON`/`inspect` that returns a redacted marker. Log-capture tests (AC3, AC4, AC25) assert no password, user, host, port, prefix-plus-ID or code on stdout/stderr, including the reconnect and `INFO` paths. C9. |
| F10 | Medium | 16 (large groups) | Each position update writes the whole document (up to about 64 KiB). Many full groups at the leader-rate ceiling turn into hundreds of MB/s to Redis, causing timeouts, `unreachable`, and mass `1001` for every group on the instance (amplified DoS by anyone who can run a few big groups). | Advisory for PR 1 (accept or fix): either store the position in its own small key in the same commit, or document the write amplification in the README sizing notes and keep it on the follow-up list. Measure in QA (document size at the default ceiling). |
| F11 | Low | 3 (TLS) | The plan does not state TLS verification. `rediss://` must verify the certificate and host name; there is no option to turn it off (query strings are rejected, good). | Never set `rejectUnauthorized: false`; pass `servername` = host. A test with a self-signed TLS endpoint gives `Redis TLS handshake failed`. Optional: warn `redis_no_tls` in production when the host is not loopback. C10. |
| F12 | Low | 4.1 `P:epoch` | The epoch has no TTL. After Redis -> memory -> Redis, groups created in memory mode have tokens with `iat >= old epoch`, so they are refused as `ended` instead of `recoverable` (fails closed: availability only). | Give `P:epoch` the same `PEXPIRE ... GT <latest E + MAX_CLOCK_SKEW_MS>` as the shared keys: once every group and ended entry is gone, every token is `expired` anyway, so a fresh epoch is safe. Or document the case. |
| F13 | Low | 4.2, AC24 | Shared sorted sets (`due`, `live`, `e:plain`, `e:guarded`) keep members of a group whose document expired by TTL (server down past `E`) until pruned; members hold group IDs (join capabilities, no names). | Prune members past `E` in the timer poll and the startup sweep (planned for `live`; do it for `due` too); AC24 test covers a group that expired while the server was down. |
| F14 | Low | README (14) | Prefix isolation (AC5) is by convention only; any client on the Redis can read every prefix. | README: recommend a Redis ACL user limited to `~<prefix>:*` (and `&<prefix>:*` for PR 2 channels) with only the commands used (`-@dangerous +info` style), plus the password, `rediss://`, private network. |
| F15 | Low | 15 (local CI / `ci.yml`) | GitHub Actions `services:` containers cannot take a `command`, so `--requirepass ... --save "" --appendonly no` cannot be passed as planned; a service without the password would also make the "password set" check false. `node:24` is a tag, not a digest (same as #31). | In `ci.yml`, start Redis in a step with `docker run` (pinned digest, flags above, bound to `127.0.0.1`), or a tiny config via `options`. The CI password stays a non-secret marked CI-only. Local QA command is fine as written (no host port, private network, read-only source mount). |

## 4. PR 2 outline (section 12): settle now or in its plan revision

Settle **now** (they shape PR 1 code):

- **P2-1 Commit as a Lua script from PR 1.** Fencing (ADR 0011) needs the
  commit to check `GET lockKey == token` atomically; `MULTI`/`EXEC` can't do a
  conditional check without `WATCH`. Build the PR 1 commit as one script (or
  `WATCH`-based) so PR 2 adds the lease check instead of rewriting the commit.
  Advisory, but cheaper now.
- **P2-2 Epoch always read from Redis at decision points** (classify,
  `guardUntil` at end, recreation commit), never from a per-instance cache that
  another instance may have moved (covered by C7 in PR 1).

Settle in the PR 2 plan revision (I will review it as a blocking item there):

- **P2-3 Self-fencing on lost liveness.** An instance that cannot renew its
  liveness key before its TTL (GC pause, partition) must close its local group
  sessions with `1001` before others' orphan sweep runs, or the registry and
  local sessions diverge (frames to stale sessions).
- **P2-4 Pub/sub messages are input.** zod-validate every received effect;
  apply only to a local session whose membership key and attach identity
  match; drop otherwise. Subscriber connection gets its own `error` listener
  and `safeErr` logging. Instance ID 128-bit random, logged only as a hash.
- **P2-5 Frames with names travel through Redis** (leader-only frames, PR 2
  approvals): fine inside the trust zone; README states it (ADR 0012 already does).
- **P2-6 Join-attempt rate limits per instance** (Q12): the code-guessing budget
  for group and alphanumeric codes scales with the number of instances. Door
  failure counts are global (good). Document the multiplication and consider a
  Redis-backed join-attempt limiter as a follow-up.
- **P2-7 Lock wait bound** (5 s then unavailable) must not let one client hold
  a group's lease (no client waits inside the lock, as today).
- **P2-8 `compose.multi.yaml`**: nginx digest-pinned, loopback only, same
  dev-password rule (C5) and persistence flags (C3).

## 5. Required controls (part of the plan for PR 1)

- **C1** Every value read from Redis is schema-validated; the recovery path
  fails closed on invalid values (F1).
- **C2** Eviction warning and README state the AC13 consequence; `OOM` is
  "unavailable" (F2).
- **C3** Compose override (and CI) run Redis with `--save "" --appendonly no`,
  no persistent `/data` volume; asserted by `repo-hygiene.test.ts` (F3).
- **C4** Timeouts and transient replies flip the state to `unreachable` until a
  probe succeeds; replay queue deduplicated by session identity, globally
  capped, re-checked under the lock (F4).
- **C5** The committed dev Redis password is refused outside
  development/test, like the dev token secret (F5).
- **C6** Keys only from `keys.ts` with component format assertions; constant
  Lua with `KEYS`/`ARGV`; no pattern scans in production code (F6).
- **C7** Recreation commit re-checks ended entry, epoch and absence
  atomically; `create` commits ensure the epoch exists (F7).
- **C8** Only connection-class and listed transient errors close the group's
  sessions; others are `INTERNAL_ERROR` to the requester only (F8).
- **C9** No password/URL/host/user/port in any message, log or inspect output;
  `new URL` errors discarded; log-capture tests (F9).
- **C10** TLS verification on, never disableable; self-signed test (F11).
- Plan items already present that I will verify: exact pin and dynamic import
  (module-cache test), no tokens/secrets/ticket keys/API keys in Redis (AC8
  scan), TTL `<= E` on every group key and delete-on-end (AC24), zod document
  with "invalid is never missing", `safeErr` only, `redis_*` events with no
  URL, compose with no host port and a digest-pinned image, README security
  advice (password, `rediss://`, private network, no persistence,
  `noeviction`).

Advisories the user may accept as is: F10 (write amplification), F12-F15, P2-1.

## 6. What I will check in code mode

- `config/redis.ts`, `env.ts`, `main.ts`, `storage/redis/connect.ts`: URL rules,
  error classification, no value in any message, C5, C9, C10, dynamic import.
- `keys.ts`, `scripts.ts`: C6; every Lua script for atomicity and fail-closed
  checks (code claim compare, compare-and-delete, timer lease, `remember`
  eviction order identical to `EndedGroups`, recreation C7).
- `document.ts` and every Redis read: C1, especially `epoch.ts`, `ended.ts`,
  `resume.ts` (epoch fence, `NaN` paths), `token-service.ts` floor.
- `unit-of-work.ts`, `effects.ts`, `connection.ts`, `upgrade.ts`: no effect
  before commit (no door-code oracle on a failed commit), C4, C8, no memory
  fallback.
- `startup-sweep.ts`: leader grace from "now", members disconnected, no
  handoff before the grace (AC11).
- Lifetimes: TTLs and delete-on-end (AC24), shared-key pruning (F13).
- Compose, `ci.yml`, `repo-hygiene.test.ts`: C3, digest pin, no host port.
- Scanners: gitleaks on the PR range (dev/CI passwords expected and
  triaged), semgrep on changed files, `pnpm`/`npm audit --audit-level=high`.

---

# PR 2 (several instances): plan review, round 1

- Mode: plan, PR 2 round 1, 2026-11-12. Reviewer: Security Engineer (Opus).
- Branch `feat/35-redis-multi-instance` at `0f623b4`, draft PR #40.
- Reviewed: [`architecture.md`](architecture.md) section 12 (12.0-12.22, Gate 2
  questions Q-B1-Q-B9), ADRs [0011](../../decisions/0011-group-atomicity-with-redis.md)
  and [0012](../../decisions/0012-cross-instance-event-delivery.md) with the 12.1
  refinements, issue #39, and the merged PR 1 code the plan builds on:
  `storage/redis/{scripts,unit-of-work,codes,doors,ended,epoch,connect,redis-storage}.ts`,
  `groups/{group-lock,group-service,notifier,token-refresher,resume}.ts`,
  `lifecycle/leader-guard.ts`, `ws/upgrade.ts`, `tokens/token-service.ts`.
- Sections 1-6 above are the PR 1 review (history). C1-C10 stay mandatory and
  apply to all new PR 2 code.

**Verdict: PASS.** No critical or high finding. The plan settles the blocking
items P2-3, P2-4, P2-6, P2-7 and P2-8 (table in 7.2). The findings below
(F16-F26) are medium/low gaps in how those settlements are carried out. The
required controls **C11-C17** in 7.4 join the plan; I verify them in code mode.

## 7.1 New assets, boundaries, threats

| Asset / boundary | Change in PR 2 |
| --- | --- |
| Pub/sub channel `P:ch:<id>` | **New input boundary** (inside the Redis trust zone): effects that deliver frames, detach, admit and close sessions |
| Attachment registry `P:a` | **Authorization data**: decides who owns a membership (M4), and so who may act as leader |
| Group lease `P:lock`, liveness `P:inst`/`P:insts`, `P:ig` | Correctness of every "exactly one wins" rule (AC18, #13 RC1-RC21) |
| `P:ap` pending requests | Display names of possible minors until settled or deadline |
| `compose.multi.yaml`, nginx | New published port (dev) |

STRIDE, brief:

- **S/E:** a stale session (replaced on another instance, detach not yet
  delivered) acts as owner or leader (F19).
- **T:** a stalled or fenced instance commits after others treat it as dead
  (F16).
- **I:** names in `P:ap` and frames in transit (P2-5, accepted, trust zone).
- **D:** healthy participants on other instances are disconnected by a local
  rule that only sees local sessions (F17, F18); effects are lost on a
  silently stalled subscriber (F20); the guessing budget grows N times (F22).

## 7.2 Blocking items from section 4, re-checked

| Item | Status | Notes |
| --- | --- | --- |
| P2-1 commit as one script | Done in PR 1 (`COMMIT` op interpreter, `scripts.ts`) | Lease check goes first (12.4). Keep every `pub` op after all writes (C15). |
| P2-2 epoch read from Redis at decision points | Done in PR 1 (`RedisEpoch.current()` reads each time; C7 re-check in the commit) | Token `iat` floor across instances: F25 (low). Term floors use the stored `recoveredAt` (`nextTerm`), so they hold across instances. |
| P2-3 self-fencing | **Settled** (12.5): monotonic clock from the send time, 10 s against a 15 s key, `SET XX` cannot resurrect a key, new ID, lease fence as the second line | Gap: the commit does not check the instance's own liveness, so an instance that wakes after a long pause can still write registry entries and `P:ig` members for a dead ID (F16 -> C11). |
| P2-4 pub/sub messages are input | **Settled** (12.7): byte cap, strict zod, match on `attachId` / `rid`, own `error` listener, `safeErr`, `instanceRef` | Add stall detection on the subscriber link (F20 -> C15). |
| P2-5 frames with names via Redis | Accepted (README, ACL channel scope) | No change. |
| P2-6 join limits per instance | **Settled** as a documented risk plus a follow-up issue (Q-B6) | F22 (medium advisory). 8-character codes over 31 symbols (about 8.5e11) keep the risk linear in N. |
| P2-7 lock wait bound | **Settled** (12.4): no client awaited in a task; 5 s wait, then busy for the requester only; 30 s hold cap; fence | Busy on receiver-side tasks needs a retry path (F18 -> C13). |
| P2-8 `compose.multi.yaml` | **Settled** (12.14): unprivileged nginx by digest, loopback only, no other host ports, C3/C5 kept, `access_log off`, hygiene tests | The server reads no client IP and no `Origin`, and the WebSocket URL carries no secret, so the proxy adds no trust issue. |

## 7.3 Findings (PR 2)

No critical, no high.

| # | Sev | Location | Issue / scenario | Fix |
| - | --- | --- | --- | --- |
| F16 | Medium | 12.3 `COMMIT`, 12.5, 12.8 | The instance fence is timer-based only. An instance frozen longer than 15 s (GC pause, VM suspend, SIGSTOP) wakes, and Node may run I/O callbacks (WebSocket frames, pub/sub) before the self-fence timer. A new task then takes a fresh lease (the old lease expired) and commits registry entries `{i: <deadId>}` and `sadd P:ig:<deadId>`, possibly after a sweeper's `SSCAN` and around `FORGET_INSTANCE`. These entries name an instance that is never swept again. The result is a phantom attached leader (no grace, no handoff) or member until `E` or the next restart. | C11: the `COMMIT` script checks `EXISTS P:inst:<self>` together with the lease, so a fenced instance can never write. Plus a synchronous `fenced()` check (monotonic time since the send of the last successful heartbeat) at lease acquire, before an outbox flush and before applying a received effect. |
| F17 | Medium | 12.5 live cache, 12.6 `RemoteRecipient.isOpen`, 12.7 "effect for an instance missing from the live cache is dropped", 12.8 `sweepGroup` | The live-instance cache is refreshed every 5 s, so an instance that registered after the last refresh looks "not live" to its peers for up to 5 s. With 12.8 as written, a `sweepGroup` on A (run for a group that also had a dead instance) disconnects that new instance's participants under the normal rules. A also drops the effects it should publish to it. A healthy client is removed (members leave the roster, a leader goes offline) with no fault on its side. | C12: a decision that **disconnects** someone uses Redis truth read in the task (`P:inst:<id>`, or `P:insts` scores against Redis `TIME`), never the cache. Publishing never depends on the cache: publish to every instance the registry names (a dead channel is a no-op). The cache is only for `isOpen()` hints such as choosing a successor. |
| F18 | Medium | 12.5 self-fence, 12.12, PR 1 `GroupService.reconcile` / `sweepAfterRestart`, `anyoneAttached` | PR 1's replay `reconcile` disconnects "every participant with no open local session". In PR 2, most participants have no local session. The conversion list in 12.6 does not name `reconcile`, `anyoneAttached` or `isParticipantConnected`. If any of these keeps the local-only meaning, a Redis blip on B makes B's replay remove A's healthy members and put A's leader offline. Also, the self-fence closes sessions, which runs the disconnect rules unless they are suppressed, and the replay queue then runs under the new ID. Receiver-side `disconnectStale` / `admitParked` tasks that hit busy have no retry, so the registry keeps an entry nobody holds. | C13: `reconcile`, `anyoneAttached`, the `emptied` checks and the legacy pass go through the registry. They disconnect only pids whose entry is missing, names a dead instance (C12), or names this instance (current or any previous ID) with no matching local `attachId`. The self-fence closes sessions **without** disconnect rules, like a clean stop, and clears the replay queue (the orphan sweep takes over). Busy or failed `disconnectStale` / `admitParked` go to the replay queue. Test: B has a 2 s Redis blip with a queued replay; the group's members and leader on A stay. |
| F19 | Medium | 12.6 "`owned(session)` keeps its local fast path", `asLeader` / `asMember` in `group-service.ts` | Authority today is `notifier.get(key) === session`, checked under the lock. Across instances, a session replaced on A keeps its local entry on B until the `detach` effect arrives, or forever if that message is lost (F20). If any allow decision still uses the local map, that stale session can act as leader (end, remove, block, lock) or keep getting `token.refreshed` leader tokens. The plan intends registry-based decisions under the lease; this finding makes that a checked rule. | C14: every **allow** decision (leader guard, take-back, approve/deny, remove/block, end, position, token refresh, QR issue) resolves the owner from the task's registry with an exact `attachId` match. The local fast path may only **deny**. Test: drop the pub/sub link to B and resume the leader on A. Then every leader action from B's old session gets `NOT_IN_GROUP` / `NOT_LEADER`, and no `token.refreshed` is sent to it. |
| F20 | Medium | 12.7 at-most-once rule | The resync rule fires on subscriber `end` / `reconnecting`. A black-holed subscriber (no RST) sends no commands, so PR 1's command timeout never trips and no event fires. Effects are lost silently: removed members stay attached locally, and clients see no positions. This is the C4 stall case on the second link. | Part of C15: probe the subscriber link every heartbeat tick (`PING` is allowed in subscribed mode) with the command timeout. A failed probe counts as a drop: replace the link and resync with `1001`. Test with the per-instance TCP proxy, stopping forwarding for the subscriber only. |
| F21 | Low | 12.3, 12.5, 12.9 | The lease token, instance ID and `attachId` must be unguessable and unique. Request IDs come from `newRequestId()` with a local `has()` loop, which does not prevent a collision across instances. The registry's `a` object, keyed by pid, is parsed from JSON. | C16: `crypto.randomBytes` for all four. The request write carries an `absent(P:ap:...)` check. The registry is parsed with `z.record(PARTICIPANT_ID_PATTERN, ...)` into a `Map`, so no `__proto__` key reaches an object. |
| F22 | Medium (advisory) | 12.11, Q-B6 | The per-app join budget (600/min) multiplies by the number of instances, and so does the guessing budget for alphanumeric and group codes. The global door-failure rotation still bounds door codes. | Accept for 9a as planned (README note, follow-up issue). I support Q-B6 = yes. |
| F23 | Low | PR 1 `ClientLink` timeout, `RedisCodeIndex.claim` `onAbandon` | A `COMMIT` that times out locally may still run on Redis. The task is then abandoned and its fresh code claims are compare-and-deleted, although the committed document now uses them. Lookups fail (fails closed), and the code can later be claimed by another group while both documents list it. Rare: it needs a timeout after a successful write. | On a timeout (outcome unknown), skip the `onAbandon` releases: the claims expire with their TTL, and the next task on the group corrects them. Or re-read the document before releasing. |
| F24 | Low | 12.7 `forget` | `forget` carries no generation. Suppose a group ends and the same `gid` is quickly recreated (recovery). A late `forget`, applied after the receiver's own recreation task, wipes the new leader's refresher and limiter state. The impact is availability and limiter resets only. | Carry the ended `term` (or `createdAt`) in `forget`, and drop it when the local state is newer. |
| F25 | Low | 12.18 "per-instance iat floors follow on their next read" | After a flush, instance A sets a new epoch, but instance B raises its `iat` floor only when B reads that epoch. With clock skew, B can issue a token for a post-flush group with `iat < epoch`. Once that group ends and its ended entry is evicted, the epoch fence classifies the token `recoverable` instead of `ended`. | Read `P:epoch` in the preload `MGET` (one more key), and raise the floor from it in every task that issues a token. |
| F26 | Low | 12.16 ACL example | `+@pubsub` also grants `PUBSUB`, `PSUBSCRIBE` and `SPUBLISH`. | ACL example: `+publish +subscribe +unsubscribe +ping` with `&<prefix>:v1:ch:*` instead of the whole category. |

Not a security finding, noted for QA (AC17): a remote effect from an earlier
commit can reach a receiver's sessions **after** the local flush of a later
commit made on that receiver. The receiver's local task finishes first, and
the received message waits behind it in `runLocal`. Example: B's members see
position 6 and then 5. Worth a test, or a per-group commit sequence number
that receivers use to drop stale `deliver` frames.

## 7.4 Required controls (part of the PR 2 plan)

- **C11 Instance fence (F16, P2-3).**
  - Every `COMMIT` that writes group-scoped keys checks, before any write,
    `eq P:lock... token` **and** `EXISTS P:inst:<self>`. Group-scoped keys:
    document, position, registry, `P:ig`, approvals, parking, timers, ended
    entries.
  - This covers commits outside a task too: `endInvalid`, sweeps, the
    recreation commit, `within`. Only compare-and-delete code releases and
    the instance scripts may commit without these checks.
  - A synchronous `fenced()` guard runs at lease acquire, before a local
    outbox flush and before a received effect is applied.
  - Tests: a fenced instance's commit aborts with nothing written or
    published. An instance paused past 15 s (fake monotonic clock, or a
    blocked proxy) writes no registry entry for its old ID.
- **C12 Liveness from Redis for removals (F17).** `sweepGroup`, `reconcile`,
  `disconnectStale` and the legacy pass decide "dead" from Redis inside the
  task, never from the live cache. Publishes go to every instance the
  registry names. Test: a third instance that registered just before a sweep
  keeps its participants.
- **C13 Registry-based reconcile and a quiet self-fence (F18).** As in F18:
  reconcile and the attachment checks use the registry; the self-fence closes
  sessions without disconnect rules and clears the replay queue; busy or
  failed receiver-side leased tasks are re-queued. Test: as in F18.
- **C14 Allow decisions only under the lease, from the registry (F19, M4).**
  As in F19, with its test. The engineer's PR list of task entry points (12.4)
  also says, for each one, where ownership is decided.
- **C15 Pub/sub path (P2-4, F20).**
  - The byte length is checked before `JSON.parse`, and the schema is strict,
    with `v: 1` only.
  - Effects match on `ns` + `gid` + `pid` + `attachId`; `admit` and `settle`
    match on `ns` + `gid` + `rid` + `pendingJoin`.
  - No message content or frame in logs.
  - In `COMMIT`, all `pub` ops come after every write, and the op list is
    validated before the first write.
  - The subscriber link is probed each tick and resyncs on a failed probe.
    It uses C9 and C10 (the same redaction and TLS options as the command
    link).
- **C16 Randomness and parsing (F21).** As in F21.
- **C17 #39 in `endInvalid` (Q-B1).**
  - Runs under the lease and the instance fence.
  - Code fields are read from the invalid document inside `try`/`catch`.
    Only values that match their pattern are used, and each one is deleted
    with `deleq(key, gid)`.
  - `P:a`, `P:aq` and the `P:ap:<rid>` keys listed in a **valid** `P:aq` are
    deleted (no pattern scan, C6). Anything that cannot be parsed expires by
    its TTL.
  - The plan's test is required, including "a code key pointing at another
    group stays".

Plan items I will also verify in code mode:

- lease acquire, renew, release (compare-and-delete) and the 30 s hold cap;
- `StorageBusyError` closes only the requester, and `LeaseLostError` only the
  group's local sessions (C8);
- the heartbeat uses `SET XX`, and `FORGET_INSTANCE` runs only while the key
  is absent;
- keys come only from `keys.ts`, with the new part checks (C6);
- new keys have TTLs `<= E` (`P:ap` `<=` its deadline), and everything is
  deleted at group end (AC24);
- no full instance ID, pid, name, code or group-ID key in logs (AC25);
- `compose.multi.yaml` and nginx per 12.14, with hygiene assertions;
- the README P2-5 and P2-6 notes and the ACL example.

Advisories the user may accept as is: F22 (with the Q-B6 follow-up), F23-F26.

## 7.5 Gate 2 questions, security view

- **Q-B1 (fold #39 in): yes.** PR 2 rewrites `endInvalid` anyway, and C17
  keeps the lenient parse from touching another group's codes.
- **Q-B2 (ADR refinements): yes.** All three stay inside the accepted
  decisions:
  - the registry in its own key keeps the same atomicity;
  - `PUBLISH` inside `COMMIT` removes a crash window and keeps commit order;
  - busy closing only the requester keeps the C8 / P2-7 property (one client
    cannot drop a group).
- **Q-B3: accept.** The admitted-then-removed member goes through the normal
  rules. The block-list and size checks run in A's commit, so nothing is
  bypassed.
- **Q-B4: yes** (same as C8).
- **Q-B5 (fixed timings; an outage over 10 s closes sessions even with one
  instance): accept.**
  - It fails safe. Without it, a single instance cannot tell "Redis was slow"
    from "another instance swept me", and a Redis restart without
    persistence loses every `P:inst` key anyway.
  - The cost is availability only: every client gets `1001` and resumes. The
    client already backs off with full jitter, which spreads the reconnect
    burst.
  - The README must state it (planned).
- **Q-B6: yes** (F22).
- **Q-B7: yes.** A PR 1 instance takes no lease, so mixing versions breaks
  every "exactly one wins" rule, leader resumes included. PR 1 instances
  can't be detected, so the README rule is the control.
- **Q-B8: `nginx-unprivileged`, yes** (non-root, pinned by digest).
- **Q-B9: document only, yes.** A config fingerprint derived from the token
  secret would need its own review. Config drift fails closed (refusals).

## 7.6 What I will check in code mode (PR 2)

- `scripts.ts`, `unit-of-work.ts`: C11 checks come first in every
  group-scoped commit, `pub` ops come last, and there is no unfenced writer
  besides the ones listed.
- `lease-lock.ts`, `group-lock.ts`, `ws/connection.ts`: P2-7, the busy and
  lease-lost scopes, and the list of awaits in the PR.
- `instance.ts`, `redis-storage.ts`: P2-3 margins on the monotonic clock, the
  `fenced()` guard, a new ID after a fence, the quiet self-fence (C13), the
  startup order.
- `cluster-notifier.ts`, `recipients.ts`, `group-service.ts`,
  `leader-guard.ts`, `leader-controls.ts`, `join-service.ts`: C12-C14.
- `pubsub.ts`, `remote-effects.ts`, `connect.ts`: C15, and C9 and C10 on the
  subscriber link.
- `approvals.ts`, `parking.ts`, `attachments.ts`, `keys.ts`, `ended.ts`: C1, C6,
  C16, C17, AC24 lifetimes.
- `compose.multi.yaml`, `config/nginx-multi.conf`, `repo-hygiene.test.ts`,
  README: P2-5, P2-6, P2-8, F26.
- Scanners: gitleaks on the PR range, semgrep on changed files, `pnpm audit
  --audit-level=high`.

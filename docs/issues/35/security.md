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

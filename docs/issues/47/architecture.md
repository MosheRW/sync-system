# Architecture: #47 fix(storage): bound create-budget key TTL and batch expired live-group cleanup

Path: fast. Spec: [spec.md](spec.md). Follow-up to #12 (PR #46), security
advisories A1 and A2 (QA A3 = A2).

## Repo layout

- Layout: `monorepo` (pnpm workspace `apps/*`, `packages/*`; no submodules,
  `git submodule status` is empty).
- Affected package: `apps/sync-server` only (storage layer, scope `storage`).
  Checks: `pnpm --filter @mosherw/sync-system-server test` (with
  `TEST_REDIS_URL` set so the `*.redis.test.ts` suites run), plus the root
  `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- No other repo, no linked issue.

## Decisions

Decisions: none open. No ADR: the AC1 choice is not a trade-off for the
user (see below), so it is recorded here.

### AC1: cap the `lb:<ns>` TTL (chosen) vs. document `lb` outside #35 AC24

**Chosen: cap the TTL.** The bucket key now expires 1 ms after `u`, the end
bound of the app's latest charged group, instead of at
`max(time to full, u - now)`.

Why this is safe and nearly free:

- `u` is the largest end bound of every group the bucket charged (each
  charge sets `u = max(u, score)` while `now < u`, else `u = score`). When
  the key expires, every charged group is past its end bound, so its slot is
  pruned (`score < now`) before the cap is counted. A fresh full bucket then
  never shares the live set with a group it charged. Live creates stay at
  most `burst + rate x L <= cap / 2` (the #12 H1 bound).
- At `now >= u` the script already resets `r`, `b`, `u` to the caller's
  values (R13/L6), so the strict values lapse at `u` anyway. The only state
  lost early is the partial token count.
- **No change at the defaults or for any burst `<= cap / 4`.** With the
  derived rate, time to full is `b x L / (cap/2 - b)`, which is `<= L <= u -
  now` exactly when `b <= cap/4`. The old `max(...)` already picked `u - now`
  there. The new TTL differs only when `burst > cap / 4`.
- Visible effect when `burst > cap / 4`: after an app has been idle until its
  last group's end (at least `L`), the budget is full again instead of
  holding `rate x L` tokens. Live creates still stay under `cap / 2`; the
  operator guide already advises a burst of at most a quarter of the limit.

The extra 1 ms (expiry at `ceil(u) + 1`, not `ceil(u)`): prune drops only
scores `< now`, so a group whose end bound is exactly `now` is still live. If
the bucket were gone at that same millisecond, a full burst could be admitted
next to the previous full burst (in the "tightest headroom" config, cap 100
000 and burst 49 999, a retry lands exactly on `u`, so this is reachable and
would roughly double the live creates). Expiring at `ceil(u) + 1` keeps the
bucket through `u` on every server, whatever its expiry comparison (`>` or
`>=`). So the key's TTL is `<= u - now + 1 ms`: 1 ms past the AC's
`max(u - now, L)` wording, and 1 ms past E for the group it belongs to.
**Gate 2 note:** this 1 ms is a deliberate deviation from the AC's literal
bound; the alternative (`ceil(u)` exactly, plus `<=` in the memory store)
relies on Redis/Valkey treating a key as present at its expiry millisecond,
and is rejected as fragile.

Absolute expiry in Redis: the script uses `PEXPIREAT` with a target computed
from Redis `TIME`, not `PEXPIRE` with a relative TTL. A relative `PEXPIRE`
inside a script counts from the script's start time snapshot, which can be
1 ms before the `TIME` the TTL was computed from, so the key could end 1 ms
before `u`. This is the same reason `extend_set` already uses `PEXPIREAT`.

Rejected: **document `lb` as an app-level counter outside AC24.** No code
change, but the key can live up to the 1e13 ms clamp (about 317 years) after
the app's last group, and it weakens AC24 for a fix that costs a few lines.

### AC2: batched expired-member cleanup in `CLAIM_DUE`

The unbounded `ZRANGEBYSCORE live -inf (now` plus `ZREMRANGEBYSCORE` becomes
one bounded read: `ZRANGEBYSCORE live -inf (now LIMIT 0 <batch>`, and for each
member read, `ZREM` from its app's `lg:<ns>` set (as now) **and** `ZREM` from
`live` (members without `:` too, as the range remove did). The batch size is
the existing `ARGV[4]` (`CLAIM_BATCH`, 64), so the script's arguments do not
change. The script reply gains one leading element, the number of expired
members it freed, so the poller can run again at once while a backlog
remains (like it already does when 64 timers were claimed). A large backlog
after an outage is then drained in many short script calls, with other
commands served in between, instead of one long one.

Rejected: a separate prune batch argument (no need: the per-member work is
two `ZREM`s, 64 is small); draining one batch per poll without the `again`
signal (a backlog of 10^6 members would take about 4 hours at one batch per
second, keeping group IDs in `live`/`lg:<ns>` past their end).

## Files to change

| Path | Change |
| --- | --- |
| `apps/sync-server/src/storage/redis/scripts.ts` | `RESERVE_LIVE`: replace the `ttl` + `PEXPIRE` lines with `PEXPIREAT bucket int(max(min(ceil(u) + 1, now + MAXT), now + 1))`; update the doc comment. `CLAIM_DUE`: bounded expired read with `LIMIT 0 limit`, per-member `ZREM` from `lg:<ns>` and `live`, drop the `ZREMRANGEBYSCORE`; reply `{freed, member, timerJson, ...}`; update the doc comment |
| `apps/sync-server/src/groups/live-groups.ts` | `bucketStep`: `ttlMs = max(1, min(ceil(u - now) + 1, MAX_RETRY_AFTER_MS))` (same instant as the script); comment. `MemoryLiveGroups.tidy`: treat a bucket past `bucketUntil` as idle (`bucketIdle(now < app.bucketUntil ? app.bucket : undefined, now)`), so the entry goes once the key would be gone in Redis |
| `apps/sync-server/src/storage/redis/timers.ts` | `claimDue` reads `freed = Number(items[0])` and the pairs from index 1; `pollLoop` sets `again` when `claimed >= CLAIM_BATCH` **or** `freed >= CLAIM_BATCH` (return both from `claimDue`, e.g. `{ claimed, freed }`) |
| `apps/sync-server/test/live-groups.test.ts` | Update the TTL test; add the `burst > cap/4` and boundary tests; add the tightest-headroom flood case (test plan) |
| `apps/sync-server/test/live-groups.redis.test.ts` | Update the first test's TTL bound; add the `burst > cap/4` Redis test |
| `apps/sync-server/test/redis-timers.redis.test.ts` | Add the script-level batch test and the poller backlog test |
| `docs/operator-guide.md` | Two sentences in the "app's budget" paragraph (Docs impact) |
| `.changeset/<slug>.md` | Patch changeset for `@mosherw/sync-system-server` |

No change to `keys.ts`, `live-groups.ts` (Redis store), the unit of work or
the sweeper.

## Contracts

No wire, API or env change. Internal script contracts:

- `RESERVE_LIVE`: same KEYS, ARGV and replies. Only the bucket key's expiry
  changes (absolute, `ceil(u) + 1`, clamped to `[now + 1, now + 1e13]`).
- `CLAIM_DUE`: same KEYS and ARGV (`ARGV[4]` now bounds both loops). Reply
  changes from `{member, timerJson, ...}` to `{freed, member, timerJson,
  ...}`; the only caller is `RedisTimerBackend.claimDue`. Scripts are loaded
  per instance (EVALSHA of each instance's own text), so instances of
  different versions during a rolling upgrade each get the reply shape they
  expect.

Docker impact: none.

Docs impact: `docs/operator-guide.md`, the budget paragraph after the rate
table ("Keep the burst well below half the limit ..."): add that the budget
state lives no longer than the app's latest group (Redis key `lb:<ns>` ends
1 ms after its end bound), so after every group of the app has ended the
budget is full again; with a burst above a quarter of the limit this refills
sooner than the sustained rate alone, still never past half the limit. The
README is not touched (#48 follows in the same area). `docs/roadmap.md` is
not touched. Changeset: patch for the server (fixed group).

## Risks and edge cases

- H1 bound at the boundary: covered by the `+1 ms` and by the new boundary
  and tightest-headroom tests. The engineer must not use relative `PEXPIRE`.
- `u <= now` (a group with no remaining life): target clamps to `now + 1`, as
  the old `max(ttl, 1)`.
- Clamp: `u` is at most `now + MAXT` (scores are clamped), so `ceil(u) + 1`
  can exceed `now + MAXT` by 1 ms; the `min(..., now + MAXT)` keeps the
  existing tiny-rate test (`ttl <= MAX_RETRY_AFTER_MS`) green.
- Existing `redis-privacy` AC24 test reads the `lb` PTTL after many round
  trips against bound `E`: `u - now + 1 - elapsed <= E` holds once 1 ms has
  passed, which it always has there. If it ever flakes, compare
  `pExpireTime` against the group's end instead of loosening the bound.
- `CLAIM_DUE` `now` is still the instance clock (unchanged, F13).
- Members of `live` past their end but beyond the first batch stay until the
  next loop iteration (milliseconds): `RESERVE_LIVE` prunes `lg:<ns>` by
  score anyway, so cap counting is unaffected.
- Behaviour otherwise unchanged: rate/cap formulas, refusal paths, `register`,
  the due-timer loop.

## Security-sensitive areas

Security-sensitive: yes

- `RESERVE_LIVE` / `bucketStep` (`scripts.ts`, `groups/live-groups.ts`): the
  per-app create budget is the #12 H1 abuse control (app-wide create DoS,
  code-space squatting); this changes when its state is forgotten. The
  boundary analysis above is what security should check.
- `CLAIM_DUE` (`scripts.ts`, `storage/redis/timers.ts`): Redis queries over
  stored group IDs (#35 AC24 retention of user data past the end bound) and
  Redis availability (A2).
- No auth, endpoints, input handling, secrets, crypto or dependencies change.

## Implementer model

Implementer model: opus
Reason: security-sensitive rate-limit state in two Lua scripts with
millisecond boundary semantics and memory/Redis parity; small diff, but an
off-by-one breaks the H1 bound.

## Test plan

| AC | Test | File |
| --- | --- | --- |
| AC1 | `bucketStep` TTL test updated: `{ expiresAt: T0 + 5_000, burst: 3, refill: 7 }` gives `ttlMs: 5_001` (was 8 572, the time to full); the 6e16 case still `MAX_RETRY_AFTER_MS` | `live-groups.test.ts` |
| AC1 | New: `burst > cap/4` with the derived rate (`cap 12, burst 4`, `appCreateRefillPerMinute` for 60 min): after 4 charges, time to full is about 2 L but `ttlMs <= u - now + 1` | `live-groups.test.ts` |
| AC1 | New boundary test on `MemoryLiveGroups` (`cap 12, burst 5`, derived rate, life L): burst of 5 at T0 (`u = T0 + L`); at exactly `T0 + L` five more reserves admit only 1 (the bucket is kept and holds `rate x L = 1` token, not a fresh burst) and `count()` is `<= cap / 2` (6), although the T0 groups are still live at their end bound. A second app idle past `u + 1` gets its full burst back with `count()` at most 5 | `live-groups.test.ts` |
| AC1 | H1 flood: add `cap 100 000, burst 49 999 at 180 min` to `CASES` (no reset): peak `<= cap / 2`, no cap refusal | `live-groups.test.ts` |
| AC1 | New Redis test at `burst > cap/4` (`cap 12, burst 4`, derived rate for 1 h): after 4 reserves, `pExpireTime(lb) === ceil(HGET u) + 1`, `pExpireTime(lb) <= pExpireTime(lg) + 1`, and `pTTL(lb) <= HOUR + 1` (old code: about 2 h) | `live-groups.redis.test.ts` |
| AC1 | Existing first Redis test: bound becomes `<= 2 * HOUR + 1` (comment: `u - now`, not `max(...)`) | `live-groups.redis.test.ts` |
| AC2 | New script-level test: seed `live` with 5 expired members `app-a:<id>` (and the same IDs in `lg:app-a`), one member without `:`, and one not expired; call `CLAIM_DUE` with batch 2: each call frees at most 2 (reply `[0] <= 2`, `zCard(live)` drops by that much); after enough calls every expired member is gone from both sets, the malformed one from `live`, the live one kept in both | `redis-timers.redis.test.ts` |
| AC2 | New poller test: seed `2 x 64 + 1` expired members; one `backend.runDue()` frees all (`zCard(live)` and `zCard(lg:app-a)` are 0) | `redis-timers.redis.test.ts` |
| AC3 | Existing #12 and #35 suites unchanged and green: `live-groups*.test.ts`, `group-create-limits*.test.ts`, `redis-timers`, `redis-privacy` (AC24), `redis-group-store`, `multi-*.redis` | all |
| AC4 | `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `TEST_REDIS_URL`), `pnpm build`; `package.json` files unchanged | root |

## Implementation chunks

1. `fix(storage): end the create budget key with the app's last group`
   (`scripts.ts` RESERVE_LIVE, `groups/live-groups.ts` bucketStep and tidy,
   and the two existing tests whose TTL numbers change)
2. `test(storage): cover the create budget TTL above a quarter of the cap`
   (new unit, boundary, flood and Redis tests for AC1)
3. `fix(storage): free expired live groups in bounded batches`
   (`scripts.ts` CLAIM_DUE, `timers.ts`)
4. `test(storage): cover a live-set backlog larger than one batch`
5. `docs: note when the create budget refills after an idle app`
   (`docs/operator-guide.md`, `.changeset/<slug>.md`)

All commits in this repo, scope per `docs/conventions.md`.

import { LuaScript } from './connect.js';

/**
 * Ended groups in Redis (#13 6.9 layer 3, #35 AC13), the same order as
 * `EndedGroups`: an entry `<base>:e:<ref>` = `{ns, d: deadline, g?: guard}`
 * (times in the server's clock), refs in insertion order in the `plain` and
 * `guarded` sets (score = sequence), closures per namespace in `closed`.
 * At the cap: (a) the oldest plain entry, else a guarded one whose guard
 * passed; (b) only if none, the oldest guarded entry of the namespace with
 * the most guarded entries, closing its recovery until that guard. Entry
 * keys are built here from the base passed in ARGV (`ep`) and refs read
 * from the sets, which only ever hold checked 32-hex refs.
 */
const ENDED_FUNCTIONS = `
local function entry_of(ep, ref)
  local raw = redis.call('GET', ep .. ref)
  if not raw then return nil end
  local ok, e = pcall(cjson.decode, raw)
  if not ok or type(e) ~= 'table' or type(e.ns) ~= 'string' then return false end
  return e
end
local function drop_ref(pl, gu, ep, ref)
  redis.call('ZREM', pl, ref)
  redis.call('ZREM', gu, ref)
  redis.call('DEL', ep .. ref)
end
local function evict_one(pl, gu, cl, ep, now)
  local oldest = redis.call('ZRANGE', pl, 0, 0)
  if #oldest > 0 then
    local live = redis.call('EXISTS', ep .. oldest[1]) == 1
    drop_ref(pl, gu, ep, oldest[1])
    if live then evicted = evicted + 1 end
    return true
  end
  local members = redis.call('ZRANGE', gu, 0, -1)
  local entries = {}
  for i, ref in ipairs(members) do
    local e = entry_of(ep, ref)
    if e == nil then
      drop_ref(pl, gu, ep, ref)
      return true
    end
    if e == false or (tonumber(e.g) or 0) <= now then
      drop_ref(pl, gu, ep, ref)
      evicted = evicted + 1
      return true
    end
    entries[i] = e
  end
  local counts, order = {}, {}
  for i = 1, #members do
    local ns = entries[i].ns
    if counts[ns] == nil then
      counts[ns] = 0
      table.insert(order, ns)
    end
    counts[ns] = counts[ns] + 1
  end
  local best, most = nil, 0
  for _, ns in ipairs(order) do
    if counts[ns] > most then
      best = ns
      most = counts[ns]
    end
  end
  if best == nil then return false end
  for i, ref in ipairs(members) do
    if entries[i].ns == best then
      drop_ref(pl, gu, ep, ref)
      evicted = evicted + 1
      local current = tonumber(redis.call('HGET', cl, best)) or 0
      local guard = tonumber(entries[i].g) or 0
      redis.call('HSET', cl, best, tostring(math.max(current, guard)))
      table.insert(closed, best)
      return true
    end
  end
  return false
end
local function remember(w, redis_now)
  local e, pl, gu, cl, sq = KEYS[w.e], KEYS[w.pl], KEYS[w.gu], KEYS[w.cl], KEYS[w.sq]
  local now = tonumber(w.now)
  drop_ref(pl, gu, w.ep, w.ref)
  while redis.call('ZCARD', pl) + redis.call('ZCARD', gu) >= tonumber(w.cap) do
    if not evict_one(pl, gu, cl, w.ep, now) then break end
  end
  local seq = redis.call('INCR', sq)
  local guard = tonumber(w.g)
  local value
  if guard ~= nil and guard > now then
    redis.call('ZADD', gu, seq, w.ref)
    value = cjson.encode({ns = w.ns, d = tonumber(w.d), g = guard})
  else
    redis.call('ZADD', pl, seq, w.ref)
    value = cjson.encode({ns = w.ns, d = tonumber(w.d)})
  end
  redis.call('SET', e, value, 'PX', w.x)
  local target = redis_now + tonumber(w.x)
  for _, k in ipairs({pl, gu, cl, sq}) do
    local current = redis.call('PEXPIRETIME', k)
    if current == -1 or (current >= 0 and target > current) then
      redis.call('PEXPIREAT', k, target)
    end
  end
end
`;

/**
 * The Lua scripts (#35 architecture 4.4, security C6). Constant source
 * text; every key comes through KEYS and every value through ARGV.
 */

/**
 * The commit of one unit of work (ADR 0011), as one atomic script (so the
 * checks and the writes are one step; security P2-1, C7). ARGV[1] is JSON
 * `{c: checks, w: writes}`; `k` is a 1-based index into KEYS. Checks run
 * first; the first failed check aborts with `{'abort', reason}` and nothing
 * is written. Numbers travel as strings. Expiries travel as time-to-live
 * in ms from now (`x`), turned into Redis time with TIME here, so the
 * server's and Redis's clocks never need to agree.
 *
 * Checks: `absent` (key must not exist), `eq` (GET must equal `v`).
 * Writes: `set` (SET PX), `setnx` (SET NX), `del`, `deleq`
 * (compare-and-delete), `hset`, `hdel`, `zadd`, `zrem`, `zremif` (only
 * while the score is still `s`), `keep` (PEXPIRE if the key exists),
 * `extend` (a shared key's expiry only moves later; a key without one gets
 * it), `remember` (an ended group, see ENDED_FUNCTIONS), `consume` (a fired
 * timer: removed from the due set and its hash only while still leased).
 * Returns `{'ok', evicted, closedNamespaces}` (the ended-groups warnings).
 */
export const COMMIT = new LuaScript(
  `
local spec = cjson.decode(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local evicted = 0
local closed = {}
` +
    ENDED_FUNCTIONS +
    `
for _, c in ipairs(spec.c) do
  local k = KEYS[c.k]
  if c.o == 'absent' then
    if redis.call('EXISTS', k) == 1 then return {'abort', c.r} end
  elseif c.o == 'eq' then
    if redis.call('GET', k) ~= c.v then return {'abort', c.r} end
  else
    return redis.error_reply('ERR unknown check')
  end
end
for _, w in ipairs(spec.w) do
  local k = KEYS[w.k]
  local o = w.o
  if o == 'set' then
    redis.call('SET', k, w.v, 'PX', w.x)
  elseif o == 'setnx' then
    redis.call('SET', k, w.v, 'NX')
  elseif o == 'del' then
    redis.call('DEL', k)
  elseif o == 'deleq' then
    if redis.call('GET', k) == w.v then redis.call('DEL', k) end
  elseif o == 'hset' then
    redis.call('HSET', k, w.f, w.v)
  elseif o == 'hdel' then
    redis.call('HDEL', k, w.f)
  elseif o == 'zadd' then
    redis.call('ZADD', k, w.s, w.m)
  elseif o == 'zrem' then
    redis.call('ZREM', k, w.m)
  elseif o == 'zremif' then
    local s = redis.call('ZSCORE', k, w.m)
    if s and tonumber(s) == tonumber(w.s) then redis.call('ZREM', k, w.m) end
  elseif o == 'keep' then
    if redis.call('EXISTS', k) == 1 then redis.call('PEXPIRE', k, w.x) end
  elseif o == 'extend' then
    local target = now + tonumber(w.x)
    local current = redis.call('PEXPIRETIME', k)
    if current == -1 or (current >= 0 and target > current) then
      redis.call('PEXPIREAT', k, target)
    end
  elseif o == 'remember' then
    remember(w, now)
  elseif o == 'consume' then
    local s = redis.call('ZSCORE', k, w.m)
    if s and tonumber(s) == tonumber(w.s) then
      redis.call('ZREM', k, w.m)
      redis.call('HDEL', KEYS[w.h], w.f)
    end
  else
    return redis.error_reply('ERR unknown write')
  end
end
return {'ok', tostring(evicted), table.concat(closed, ',')}
`,
);

/**
 * Claims join codes for a group, all or none (#10 R14, #35 architecture
 * 4.4): every key must be free or already this group's. KEYS: the code
 * keys; ARGV: group ID, time to live (ms). Returns `{1, new...}` (1 for each
 * key newly set) or `{0}`.
 */
export const CLAIM = new LuaScript(`
for _, k in ipairs(KEYS) do
  local holder = redis.call('GET', k)
  if holder and holder ~= ARGV[1] then return {0} end
end
local result = {1}
for _, k in ipairs(KEYS) do
  if redis.call('GET', k) == ARGV[1] then
    table.insert(result, 0)
  else
    redis.call('SET', k, ARGV[1], 'PX', ARGV[2])
    table.insert(result, 1)
  end
end
return result
`);

/**
 * Drops ended-group refs whose entry expired or passed its deadline, and
 * passed closures (#35 F13). KEYS: plain, guarded, closed; ARGV: entry key
 * base, now (server clock), how many refs per set to look at.
 */
export const PRUNE_ENDED = new LuaScript(`
local pl, gu, cl = KEYS[1], KEYS[2], KEYS[3]
local ep, now, limit = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local dropped = 0
for _, set in ipairs({pl, gu}) do
  for _, ref in ipairs(redis.call('ZRANGE', set, 0, limit - 1)) do
    local raw = redis.call('GET', ep .. ref)
    local ok, e = false, nil
    if raw then ok, e = pcall(cjson.decode, raw) end
    if not raw or (ok and type(e) == 'table' and (tonumber(e.d) or 0) <= now) then
      redis.call('ZREM', pl, ref)
      redis.call('ZREM', gu, ref)
      redis.call('DEL', ep .. ref)
      dropped = dropped + 1
    end
  end
end
local fields = redis.call('HGETALL', cl)
for i = 1, #fields, 2 do
  local untilAt = tonumber(fields[i + 1])
  if untilAt ~= nil and untilAt <= now then redis.call('HDEL', cl, fields[i]) end
end
return dropped
`);

/**
 * Claims due timers (#35 ADR 0013): every member of the due set with a
 * score at or before `now` whose timer still exists gets the lease end as
 * its score; members whose group's timer hash entry is gone are dropped,
 * and live-group members past their end bound too (F13). KEYS: due, live;
 * ARGV: timer hash key base, now, lease end, batch size. Returns
 * `{member, timerJson, ...}`. Hash keys are built from members of the due
 * set, which only ever hold checked `ns:gid:kind` members.
 */
export const CLAIM_DUE = new LuaScript(`
local due, live = KEYS[1], KEYS[2]
local tp, now, lease, limit = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', live, '-inf', '(' .. now)
local out = {}
for _, m in ipairs(redis.call('ZRANGEBYSCORE', due, '-inf', now, 'LIMIT', 0, limit)) do
  local i = string.find(m, ':[^:]*$')
  if i == nil then
    redis.call('ZREM', due, m)
  else
    local data = redis.call('HGET', tp .. string.sub(m, 1, i - 1), string.sub(m, i + 1))
    if not data then
      redis.call('ZREM', due, m)
    else
      redis.call('ZADD', due, 'XX', lease, m)
      table.insert(out, m)
      table.insert(out, data)
    end
  end
end
return out
`);

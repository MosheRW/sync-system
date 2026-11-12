import { LuaScript } from './connect.js';

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
 * it), `remember` (an ended group, see ENDED_REMEMBER below).
 */
export const COMMIT = new LuaScript(`
local spec = cjson.decode(ARGV[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
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
  else
    return redis.error_reply('ERR unknown write')
  end
end
return 'OK'
`);

import { describe, expect, it } from 'vitest';
import { TIMER_KINDS, type TimerKind } from '../src/groups/group-timers.js';
import { KeyPartError, RedisKeys, parseMember } from '../src/storage/redis/keys.js';

const NS = 'app-a';
const ID = 'G'.repeat(43);
const REF = 'a'.repeat(32);

/** Parts that must never reach a key: separators, glob characters, spaces, case, length. */
const HOSTILE = ['', ':', '*', '?', '[', ' ', 'a:b', 'a*', 'a b', 'a\n', '{a}', 'é'];

/**
 * Every Redis key part is checked against its format (#35 security C6):
 * no `:`, no glob character, no client text unchecked.
 */
describe('RedisKeys (#35 security C6)', () => {
  const keys = new RedisKeys('sync');

  it('builds the documented keys', () => {
    expect(keys.base).toBe('sync:v1');
    expect(keys.epoch()).toBe('sync:v1:epoch');
    expect(keys.group(NS, ID)).toBe(`sync:v1:g:${NS}:${ID}`);
    expect(keys.position(NS, ID)).toBe(`sync:v1:p:${NS}:${ID}`);
    expect(keys.groupCode(NS, '123456')).toBe(`sync:v1:c:${NS}:g:123456`);
    expect(keys.alphaCode(NS, 'ABCDEFGH')).toBe(`sync:v1:c:${NS}:a:ABCDEFGH`);
    expect(keys.timers(NS, ID)).toBe(`sync:v1:t:${NS}:${ID}`);
    expect(keys.due()).toBe('sync:v1:due');
    expect(keys.dueMember(NS, ID, 'grace')).toBe(`${NS}:${ID}:grace`);
    expect(keys.live()).toBe('sync:v1:live');
    expect(keys.liveMember(NS, ID)).toBe(`${NS}:${ID}`);
    expect(keys.ended(REF)).toBe(`sync:v1:e:${REF}`);
  });

  it.each([...HOSTILE, 'Sync', '-sync', 'a'.repeat(33)])('rejects the prefix %j', (prefix) => {
    expect(() => new RedisKeys(prefix)).toThrow(KeyPartError);
  });

  it.each([...HOSTILE, 'App', '-app', 'a'.repeat(64)])('rejects the namespace %j', (ns) => {
    for (const build of [
      () => keys.group(ns, ID),
      () => keys.position(ns, ID),
      () => keys.groupCode(ns, '123456'),
      () => keys.alphaCode(ns, 'ABCDEFGH'),
      () => keys.timers(ns, ID),
      () => keys.dueMember(ns, ID, 'grace'),
      () => keys.liveMember(ns, ID),
    ]) {
      expect(build).toThrow(KeyPartError);
    }
  });

  it.each([...HOSTILE, 'G'.repeat(42), 'G'.repeat(44), `${'G'.repeat(42)}:`, `${'G'.repeat(42)}*`])(
    'rejects the group ID %j',
    (id) => {
      for (const build of [
        () => keys.group(NS, id),
        () => keys.position(NS, id),
        () => keys.timers(NS, id),
        () => keys.dueMember(NS, id, 'grace'),
        () => keys.liveMember(NS, id),
      ]) {
        expect(build).toThrow(KeyPartError);
      }
    },
  );

  it.each([...HOSTILE, '12345', '1234567', '12345:', '12345*', 'abcdef'])(
    'rejects the group code %j',
    (code) => {
      expect(() => keys.groupCode(NS, code)).toThrow(KeyPartError);
    },
  );

  it.each([...HOSTILE, 'ABCDEFG', 'ABCDEFGHJ', 'ABCDEFG:', 'ABCDEFG*', 'abcdefgh', 'ABCDEFG1'])(
    'rejects the alphanumeric code %j',
    (code) => {
      expect(() => keys.alphaCode(NS, code)).toThrow(KeyPartError);
    },
  );

  it.each([...HOSTILE, 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), `${'a'.repeat(31)}:`])(
    'rejects the ended ref %j',
    (ref) => {
      expect(() => keys.ended(ref)).toThrow(KeyPartError);
    },
  );

  it.each(['', 'unknown', 'grace:x', '*', 'GRACE'])('rejects the timer kind %j', (kind) => {
    expect(() => keys.dueMember(NS, ID, kind as TimerKind)).toThrow(KeyPartError);
  });

  it('accepts every timer kind', () => {
    for (const kind of TIMER_KINDS) {
      expect(keys.dueMember(NS, ID, kind)).toBe(`${NS}:${ID}:${kind}`);
    }
  });

  it('keeps two prefixes apart (AC5)', () => {
    const other = new RedisKeys('sync2');
    expect(other.group(NS, ID)).not.toBe(keys.group(NS, ID));
    expect(other.group(NS, ID).startsWith(`${keys.base}:`)).toBe(false);
  });

  it('never names a key part or value in the error', () => {
    try {
      keys.group(NS, 'secret:value');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe('invalid redis key part: groupId');
    }
  });
});

describe('parseMember (#35 security C1, C6)', () => {
  it('splits a live member and a due member', () => {
    expect(parseMember(`${NS}:${ID}`)).toEqual({ namespace: NS, groupId: ID });
    for (const kind of TIMER_KINDS) {
      expect(parseMember(`${NS}:${ID}:${kind}`)).toEqual({ namespace: NS, groupId: ID, kind });
    }
  });

  it.each([
    '',
    NS,
    `${NS}:`,
    `:${ID}`,
    `${NS}:${ID}:`,
    `${NS}:${ID}:grace:extra`,
    `${NS}:${ID}:unknown`,
    `${NS}:${ID}:GRACE`,
    `App:${ID}`,
    `${NS}:${'G'.repeat(42)}`,
    `${NS}:${'G'.repeat(44)}`,
    `${NS}*:${ID}`,
    `${NS}:${ID}*`,
    `${NS} :${ID}`,
  ])('rejects %j', (member) => {
    expect(parseMember(member)).toBeUndefined();
  });
});

describe('RedisKeys for several instances (#35 architecture 12.3, security C6)', () => {
  const keys = new RedisKeys('sync');
  const INSTANCE = 'ab'.repeat(16);

  it('builds the instance keys and channel', () => {
    expect(keys.instance(INSTANCE)).toBe(`sync:v1:inst:${INSTANCE}`);
    expect(keys.instances()).toBe('sync:v1:insts');
    expect(keys.instanceGroups(INSTANCE)).toBe(`sync:v1:ig:${INSTANCE}`);
    expect(keys.channel(INSTANCE)).toBe(`sync:v1:ch:${INSTANCE}`);
  });

  it.each(['', 'AB'.repeat(16), 'ab'.repeat(15), 'ab'.repeat(17), `${'ab'.repeat(15)}a:`, '*'])(
    'rejects the instance ID %j',
    (id) => {
      for (const build of [
        () => keys.instance(id),
        () => keys.instanceGroups(id),
        () => keys.channel(id),
      ]) {
        expect(build).toThrow(KeyPartError);
      }
    },
  );
});

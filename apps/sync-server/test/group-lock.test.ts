import { describe, expect, it } from 'vitest';
import { EffectOutbox } from '../src/groups/effects.js';
import { GroupLock, type UnitOfWorkSource } from '../src/groups/group-lock.js';

function source(commit: () => Promise<void>, transactional = true) {
  const calls: string[] = [];
  const value: UnitOfWorkSource = {
    transactional,
    begin: (namespace, groupId) => {
      calls.push(`begin ${namespace}:${groupId}`);
      return {
        commit: async () => {
          calls.push('commit');
          await commit();
        },
        abandon: () => {
          calls.push('abandon');
          return Promise.resolve();
        },
      };
    },
  };
  return { value, calls };
}

describe('EffectOutbox (#35 ADR 0011)', () => {
  it('flushes in queue order and only once', () => {
    const outbox = new EffectOutbox();
    const seen: number[] = [];
    outbox.add(() => seen.push(1));
    outbox.add(() => seen.push(2));
    expect(outbox.size).toBe(2);
    outbox.flush();
    outbox.flush();
    expect(seen).toEqual([1, 2]);
  });

  it('drops everything on drop', () => {
    const outbox = new EffectOutbox();
    const seen: number[] = [];
    outbox.add(() => seen.push(1));
    outbox.drop();
    outbox.flush();
    expect(seen).toEqual([]);
  });
});

describe('GroupLock (#35 ADR 0011)', () => {
  it('runs effects after the commit, in queue order', async () => {
    const seen: string[] = [];
    const { value, calls } = source(() => {
      seen.push('committed');
      return Promise.resolve();
    });
    const lock = new GroupLock(value);
    const result = await lock.run('ns', 'g1', async () => {
      lock.effect(() => seen.push('a'));
      await Promise.resolve();
      lock.effect(() => seen.push('b'));
      expect(lock.current()?.groupId).toBe('g1');
      return 7;
    });
    expect(result).toBe(7);
    expect(seen).toEqual(['committed', 'a', 'b']);
    expect(calls).toEqual(['begin ns:g1', 'commit']);
    expect(lock.current()).toBeUndefined();
  });

  it('runs an effect at once outside a task', () => {
    const lock = new GroupLock();
    const seen: string[] = [];
    lock.effect(() => seen.push('now'));
    expect(seen).toEqual(['now']);
  });

  it('drops the effects and reports a failed commit', async () => {
    const failure = new Error('commit failed');
    const { value, calls } = source(() => Promise.reject(failure));
    const reported: unknown[] = [];
    const lock = new GroupLock(value, (namespace, groupId, err, sessions) =>
      reported.push([namespace, groupId, err, sessions]),
    );
    const seen: string[] = [];
    await expect(
      lock.run('ns', 'g1', () => {
        lock.effect(() => seen.push('a'));
        return Promise.resolve();
      }),
    ).rejects.toBe(failure);
    expect(seen).toEqual([]);
    expect(calls).toEqual(['begin ns:g1', 'commit', 'abandon']);
    expect(reported).toEqual([['ns', 'g1', failure, new Set()]]);
  });

  it('drops the effects of a failed task on a transactional store', async () => {
    const { value, calls } = source(() => Promise.resolve());
    const lock = new GroupLock(value);
    const seen: string[] = [];
    await expect(
      lock.run('ns', 'g1', () => {
        lock.effect(() => seen.push('a'));
        return Promise.reject(new Error('bug'));
      }),
    ).rejects.toThrow('bug');
    expect(seen).toEqual([]);
    expect(calls).toEqual(['begin ns:g1', 'abandon']);
  });

  it('flushes the effects of a failed task on the in-memory store (already applied)', async () => {
    const lock = new GroupLock();
    const seen: string[] = [];
    await expect(
      lock.run('ns', 'g1', () => {
        lock.effect(() => seen.push('a'));
        return Promise.reject(new Error('bug'));
      }),
    ).rejects.toThrow('bug');
    expect(seen).toEqual(['a']);
  });

  it('serializes tasks of one group and keeps their effects apart', async () => {
    const lock = new GroupLock();
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = lock.run('ns', 'g1', async () => {
      lock.effect(() => seen.push('first'));
      await gate;
    });
    const second = lock.run('ns', 'g1', () => {
      seen.push('second runs');
      lock.effect(() => seen.push('second'));
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(seen).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(['first', 'second runs', 'second']);
  });
});

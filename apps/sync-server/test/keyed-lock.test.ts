import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../src/groups/keyed-lock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('KeyedLock', () => {
  it('runs tasks for the same key one at a time, in call order', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const gate = deferred();
    const first = lock.run('k', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
      return 1;
    });
    const second = lock.run('k', () => {
      order.push('second');
      return Promise.resolve(2);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['first:start']);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not block other keys', async () => {
    const lock = new KeyedLock();
    const gate = deferred();
    const held = lock.run('a', () => gate.promise);
    expect(await lock.run('b', () => Promise.resolve('b'))).toBe('b');
    gate.resolve();
    await held;
  });

  it('releases the key when a task throws', async () => {
    const lock = new KeyedLock();
    await expect(lock.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await lock.run('k', () => Promise.resolve('next'))).toBe('next');
  });

  it('forgets idle keys, so it does not grow with every group', async () => {
    const lock = new KeyedLock();
    await Promise.all([
      lock.run('a', () => Promise.resolve(1)),
      lock.run('a', () => Promise.resolve(2)),
    ]);
    await lock.run('b', () => Promise.resolve(3));
    expect(lock.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { GroupTimers, MemoryTimerBackend } from '../src/groups/group-timers.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

function setup() {
  const scheduler = new ManualScheduler(0);
  const backend = new MemoryTimerBackend(scheduler);
  const timers = new GroupTimers(backend);
  const fired: string[] = [];
  timers.on('maxSession', (ns, id) => fired.push(`max ${ns}:${id}`));
  timers.on('frozenEnd', (ns, id) => fired.push(`frozen ${ns}:${id}`));
  timers.on('grace', (ns, id, data) => fired.push(`grace ${ns}:${id} ${JSON.stringify(data)}`));
  return { scheduler, backend, timers, fired };
}

describe('GroupTimers (architecture 6.3, #35 ADR 0013)', () => {
  it('dispatches each kind once at its time to its handler and forgets it', () => {
    const { scheduler, timers, fired } = setup();
    timers.arm('ns', 'g', 'maxSession', 100);
    timers.arm('ns', 'g', 'frozenEnd', 50);
    expect(timers.size).toBe(1);
    scheduler.advance(50);
    expect(fired).toEqual(['frozen ns:g']);
    scheduler.advance(50);
    expect(fired).toEqual(['frozen ns:g', 'max ns:g']);
    expect(timers.size).toBe(0);
  });

  it('passes the plain data of the timer', () => {
    const { scheduler, timers, fired } = setup();
    timers.arm('ns', 'g', 'grace', 10, { term: 5, at: 10 });
    scheduler.advance(10);
    expect(fired).toEqual(['grace ns:g {"term":5,"at":10}']);
  });

  it('replaces a timer of the same kind', () => {
    const { scheduler, timers, fired } = setup();
    timers.arm('ns', 'g', 'frozenEnd', 10);
    timers.arm('ns', 'g', 'frozenEnd', 20);
    scheduler.advance(15);
    expect(fired).toEqual([]);
    scheduler.advance(10);
    expect(fired).toEqual(['frozen ns:g']);
  });

  it('clears one kind, one group or everything', () => {
    const { scheduler, backend, timers, fired } = setup();
    timers.arm('ns', 'a', 'maxSession', 10);
    timers.arm('ns', 'a', 'frozenEnd', 10);
    timers.arm('ns', 'b', 'maxSession', 10);
    timers.arm('ns', 'c', 'maxSession', 10);
    timers.clear('ns', 'a', 'frozenEnd');
    expect(backend.has('ns', 'a', 'frozenEnd')).toBe(false);
    expect(backend.has('ns', 'a', 'maxSession')).toBe(true);
    expect(scheduler.pending).toBe(3);
    timers.clearGroup('ns', 'b');
    expect(scheduler.pending).toBe(2);
    timers.clearAll();
    expect(scheduler.pending).toBe(0);
    expect(timers.size).toBe(0);
    scheduler.advance(100);
    expect(fired).toEqual([]);
  });

  it('ignores a kind without a handler', () => {
    const { scheduler, timers, fired } = setup();
    timers.arm('ns', 'g', 'doorPauseEnd', 10);
    scheduler.advance(10);
    expect(fired).toEqual([]);
    expect(timers.size).toBe(0);
  });
});

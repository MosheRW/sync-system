import type { ServerMessage } from '@mosherw/sync-system-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncClientError } from '../src/errors.js';
import { type PendingRequest, RequestTracker } from '../src/requests.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function callbacks() {
  return {
    resolve: vi.fn<(m: ServerMessage) => void>(),
    reject: vi.fn<(e: SyncClientError) => void>(),
  };
}

describe('RequestTracker (AC17)', () => {
  it('hands out c1, c2, ... reqIds', () => {
    const tracker = new RequestTracker(() => {});
    expect([tracker.nextId(), tracker.nextId(), tracker.nextId()]).toEqual(['c1', 'c2', 'c3']);
  });

  it('matches replies answered in reverse order', () => {
    const tracker = new RequestTracker(() => {});
    const join = callbacks();
    const update = callbacks();
    const joinId = tracker.nextId();
    const updateId = tracker.nextId();
    tracker.add(joinId, {
      kind: 'group.joinByCode',
      timeoutKind: 'drop',
      timeoutMs: 1000,
      ...join,
    });
    tracker.add(updateId, {
      kind: 'position.update',
      timeoutKind: 'ack',
      timeoutMs: 2000,
      position: { page: 1 },
      ...update,
    });
    expect(tracker.get(updateId)?.position).toEqual({ page: 1 });
    tracker.take(updateId)?.resolve({ type: 'position.ack' });
    expect(update.resolve).toHaveBeenCalledWith({ type: 'position.ack' });
    expect(join.resolve).not.toHaveBeenCalled();
    expect(tracker.take(joinId)?.kind).toBe('group.joinByCode');
    expect(tracker.take(joinId)).toBeUndefined();
    expect(tracker.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with REQUEST_TIMEOUT and reports the timeout kind (M4)', () => {
    const timeouts: PendingRequest[] = [];
    const tracker = new RequestTracker((request) => timeouts.push(request));
    const create = callbacks();
    const update = callbacks();
    tracker.add(tracker.nextId(), {
      kind: 'group.create',
      timeoutKind: 'drop',
      timeoutMs: 10_000,
      ...create,
    });
    tracker.add(tracker.nextId(), {
      kind: 'position.update',
      timeoutKind: 'ack',
      timeoutMs: 20_000,
      ...update,
    });

    vi.advanceTimersByTime(10_000);
    expect(create.reject).toHaveBeenCalledTimes(1);
    const error = create.reject.mock.calls[0]![0];
    expect(error.code).toBe('REQUEST_TIMEOUT');
    expect(error.request).toBe('group.create');
    expect(timeouts.map((t) => t.timeoutKind)).toEqual(['drop']);

    vi.advanceTimersByTime(10_000);
    expect(update.reject).toHaveBeenCalledTimes(1);
    expect(timeouts.map((t) => t.timeoutKind)).toEqual(['drop', 'ack']);
    expect(tracker.size).toBe(0);
  });

  it('rejectAll rejects every pending request and clears the timers', () => {
    const tracker = new RequestTracker(() => {});
    const a = callbacks();
    const b = callbacks();
    tracker.add(tracker.nextId(), {
      kind: 'group.joinByCode',
      timeoutKind: 'drop',
      timeoutMs: 1000,
      ...a,
    });
    tracker.add(tracker.nextId(), {
      kind: 'position.update',
      timeoutKind: 'ack',
      timeoutMs: 1000,
      ...b,
    });
    const lost = new SyncClientError('CONNECTION_LOST');
    tracker.rejectAll(lost);
    expect(a.reject).toHaveBeenCalledWith(lost);
    expect(b.reject).toHaveBeenCalledWith(lost);
    expect(tracker.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

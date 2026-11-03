import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/apps/app-registry.js';
import { ParkingLot } from '../src/groups/parking-lot.js';
import type { Session } from '../src/groups/session.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

function session(): Session {
  return {
    connectionId: 'c',
    app: { namespace: 'app-a' } as AppConfig,
    membership: undefined,
    deliver: () => undefined,
    afterPending: (task) => task(),
    isOpen: () => true,
  };
}

describe('ParkingLot (Q7, M5)', () => {
  it('parks a session for one group and drains in arrival order', () => {
    const lot = new ParkingLot(new ManualScheduler(0));
    const [a, b, c] = [session(), session(), session()];
    lot.park(a, 'k', 'g', 'p1', 100, vi.fn());
    lot.park(b, 'k', 'g', 'p2', 100, vi.fn());
    lot.park(c, 'other', 'h', 'p1', 100, vi.fn());
    expect(a.parked).toEqual({ groupKey: 'k', groupId: 'g', participantId: 'p1' });
    expect(lot.size).toBe(3);
    expect(lot.drain('k')).toEqual([
      { session: a, participantId: 'p1' },
      { session: b, participantId: 'p2' },
    ]);
    expect(a.parked).toBeUndefined();
    expect(lot.size).toBe(1);
    expect(lot.drain('k')).toEqual([]);
  });

  it('keeps one session per participant: newest wins and the older is returned', () => {
    const scheduler = new ManualScheduler(0);
    const lot = new ParkingLot(scheduler);
    const older = session();
    const newer = session();
    const expireOlder = vi.fn();
    lot.park(older, 'k', 'g', 'p', 100, expireOlder);
    expect(lot.park(newer, 'k', 'g', 'p', 100, vi.fn())).toBe(older);
    expect(older.parked).toBeUndefined();
    expect(lot.size).toBe(1);
    scheduler.advance(200);
    expect(expireOlder).not.toHaveBeenCalled();
  });

  it('runs the expiry callback at the deadline unless unparked', () => {
    const scheduler = new ManualScheduler(0);
    const lot = new ParkingLot(scheduler);
    const a = session();
    const b = session();
    const expireA = vi.fn();
    const expireB = vi.fn();
    lot.park(a, 'k', 'g', 'p1', 100, expireA);
    lot.park(b, 'k', 'g', 'p2', 100, expireB);
    expect(lot.unpark(b)).toBe(true);
    expect(lot.unpark(b)).toBe(false);
    scheduler.advance(100);
    expect(expireA).toHaveBeenCalledOnce();
    expect(expireB).not.toHaveBeenCalled();
  });

  it('clears everything on shutdown', () => {
    const scheduler = new ManualScheduler(0);
    const lot = new ParkingLot(scheduler);
    const a = session();
    lot.park(a, 'k', 'g', 'p', 100, vi.fn());
    lot.clearAll();
    expect(scheduler.pending).toBe(0);
    expect(lot.size).toBe(0);
    expect(a.parked).toBeUndefined();
  });
});

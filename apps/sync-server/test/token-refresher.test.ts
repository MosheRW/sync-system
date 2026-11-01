import { describe, expect, it, vi } from 'vitest';
import { TokenRefresher } from '../src/groups/token-refresher.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

const POLICY = { activities: 10, minMs: 60_000, maxMs: 300_000 };

function setup() {
  const scheduler = new ManualScheduler(0);
  const refresher = new TokenRefresher(scheduler, POLICY);
  const refreshed: number[] = [];
  refresher.reset('g', 0, (at) => refreshed.push(at));
  return { scheduler, refresher, refreshed };
}

describe('TokenRefresher (#5 AC12)', () => {
  it('does not refresh before the min interval, even after N activities', () => {
    const { scheduler, refresher, refreshed } = setup();
    for (let i = 0; i < 15; i++) {
      scheduler.advance(1_000);
      refresher.activity('g', scheduler.now());
    }
    expect(refreshed).toEqual([]);
  });

  it('refreshes after N activities once the min interval passed (timer-driven)', () => {
    const { scheduler, refresher, refreshed } = setup();
    for (let i = 0; i < 10; i++) {
      scheduler.advance(1_000);
      refresher.activity('g', scheduler.now());
    }
    scheduler.advanceTo(59_999);
    expect(refreshed).toEqual([]);
    scheduler.advanceTo(60_000);
    expect(refreshed).toEqual([60_000]);
  });

  it('refreshes on the activity that reaches N after the min interval', () => {
    const { scheduler, refresher, refreshed } = setup();
    for (let i = 0; i < 9; i++) refresher.activity('g', 0);
    scheduler.advanceTo(70_000);
    refresher.activity('g', 70_000);
    expect(refreshed).toEqual([70_000]);
  });

  it('refreshes at the max interval after a single activity, without more activity', () => {
    const { scheduler, refresher, refreshed } = setup();
    scheduler.advance(5_000);
    refresher.activity('g', scheduler.now());
    scheduler.advanceTo(299_999);
    expect(refreshed).toEqual([]);
    scheduler.advanceTo(300_000);
    expect(refreshed).toEqual([300_000]);
  });

  it('never refreshes without activity', () => {
    const { scheduler, refreshed } = setup();
    scheduler.advance(10 * 300_000);
    expect(refreshed).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it('starts counting again after a refresh and after reset', () => {
    const { scheduler, refresher, refreshed } = setup();
    refresher.activity('g', 0);
    scheduler.advanceTo(300_000);
    expect(refreshed).toEqual([300_000]);
    // No activity since the refresh: nothing more.
    scheduler.advanceTo(350_000);
    expect(refreshed).toEqual([300_000]);
    // An activity schedules the next refresh; a reset (fresh token) cancels it.
    refresher.activity('g', 350_000);
    expect(scheduler.pending).toBe(1);
    const callback = vi.fn();
    refresher.reset('g', 400_000, callback);
    expect(scheduler.pending).toBe(0);
    scheduler.advanceTo(3_000_000);
    expect(callback).not.toHaveBeenCalled();
    expect(refreshed).toEqual([300_000]);
  });

  it('ignores activity without state and clears timers', () => {
    const { scheduler, refresher, refreshed } = setup();
    refresher.activity('other', 0);
    refresher.activity('g', 0);
    expect(scheduler.pending).toBe(1);
    refresher.clear('g');
    expect(scheduler.pending).toBe(0);
    refresher.activity('g', 1);
    scheduler.advance(1_000_000);
    expect(refreshed).toEqual([]);
    expect(refresher.size).toBe(0);
  });
});

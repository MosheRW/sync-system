import { SyncClientError } from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type LeaderCodes, useLeaderCodes } from '../src/hooks/leader.js';
import { FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

function track<T>(use: () => T, client: FakeSyncClient): T[] {
  const values: T[] = [];
  function Probe(): ReactNode {
    values.push(use());
    return null;
  }
  renderWithProvider(<Probe />, { client });
  return values;
}

const CODES = Object.freeze({ generation: 3, groupCode: '123456', alphaCode: 'ABCDEFGH' });

describe('useLeaderCodes (AC18, Q-A)', () => {
  it('exposes the codes while leading, keeps their identity, and nothing otherwise', () => {
    const client = new FakeSyncClient();
    client.codes = CODES;
    const values = track(useLeaderCodes, client);
    expect(values.at(-1)?.codes).toBeNull();
    act(() => client.lead('g-1'));
    const value = values.at(-1) as LeaderCodes;
    expect(value.codes).toBe(CODES);
    expect(value.joiningEnabled).toBe(true);
    act(() => client.emit('rosterChanged', { groupId: 'g-1', roster: [] }));
    expect(values.at(-1)).toBe(value);
    act(() => client.follow('g-1'));
    expect(values.at(-1)?.codes).toBeNull();
    expect(values.at(-1)?.joiningEnabled).toBe(false);
  });

  it('rotate calls the core; the value is dropped on demotion (R3)', async () => {
    const client = new FakeSyncClient();
    const next = { generation: 4, groupCode: '999999' };
    client.impl.rotateCodes = () => next;
    const values = track(useLeaderCodes, client);
    act(() => client.lead('g-1'));
    await act(async () => {
      await values.at(-1)!.rotate.run();
    });
    expect(values.at(-1)?.rotate.value).toBe(next);
    act(() => client.lead('g-2'));
    expect(values.at(-1)?.rotate.value).toBeUndefined();
  });

  it('setJoiningEnabled maps to unlock/lock of all joining', async () => {
    const client = new FakeSyncClient();
    client.impl.lockGroup = () => client.lead('g-1', { locked: true });
    client.impl.unlockGroup = () => client.lead('g-1', { locked: false });
    const values = track(useLeaderCodes, client);
    act(() => client.lead('g-1'));
    await act(async () => {
      await values.at(-1)!.setJoiningEnabled.run(false);
    });
    expect(client.count('lockGroup')).toBe(1);
    expect(values.at(-1)?.joiningEnabled).toBe(false);
    await act(async () => {
      await values.at(-1)!.setJoiningEnabled.run(true);
    });
    expect(client.count('unlockGroup')).toBe(1);
    expect(values.at(-1)?.joiningEnabled).toBe(true);
  });

  it('exposes a door-code pause until resumed', () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const client = new FakeSyncClient();
      const values = track(useLeaderCodes, client);
      act(() => client.lead('g-1'));
      act(() => client.emit('joinPaused', { groupId: 'g-1', retryAfterMs: 30_000 }));
      expect(values.at(-1)?.joinPaused).toEqual({ retryAt: 40_000 });
      act(() => client.emit('joinResumed', { groupId: 'g-1' }));
      expect(values.at(-1)?.joinPaused).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a member gets the core typed NOT_LEADER error', async () => {
    const client = new FakeSyncClient();
    client.impl.rotateCodes = () =>
      Promise.reject(new SyncClientError('NOT_LEADER', { request: 'codes.rotate' }));
    const values = track(useLeaderCodes, client);
    act(() => client.follow('g-1'));
    let result: unknown;
    await act(async () => {
      result = await values.at(-1)!.rotate.run();
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_LEADER' } });
  });
});

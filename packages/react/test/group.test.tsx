import { SyncClientError } from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import {
  useGroup,
  useGroupEnded,
  useGroupExit,
  useLeaderStatus,
  usePosition,
  useRemoved,
} from '../src/hooks/group.js';
import { CONNECTED, FakeSyncClient } from './helpers/fake-client.js';
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

describe('useGroup', () => {
  it('is the snapshot group', () => {
    const client = new FakeSyncClient();
    const values = track(useGroup, client);
    expect(values.at(-1)).toBeNull();
    act(() => client.follow('g-1'));
    expect(values.at(-1)).toBe(client.snapshot.group);
  });
});

describe('usePosition (AC23)', () => {
  it('the leader updates the position', () => {
    const client = new FakeSyncClient();
    const values = track(usePosition, client);
    act(() => client.lead('g-1'));
    expect(values.at(-1)).toMatchObject({ hasPosition: false, canUpdate: true });
    let result: unknown;
    act(() => {
      result = values.at(-1)!.updatePosition({ page: 3 });
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(values.at(-1)).toMatchObject({ hasPosition: true, position: { page: 3 }, error: null });
  });

  it('a member gets a typed NOT_LEADER result, not a throw', () => {
    const client = new FakeSyncClient();
    const values = track(usePosition, client);
    act(() => client.follow('g-1', { hasPosition: true, position: 7 }));
    expect(values.at(-1)).toMatchObject({ hasPosition: true, position: 7, canUpdate: false });
    let result: { ok: boolean; error?: SyncClientError } | undefined;
    act(() => {
      result = values.at(-1)!.updatePosition(8);
    });
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe('NOT_LEADER');
    expect(values.at(-1)?.error?.code).toBe('NOT_LEADER');
  });

  it('keeps its identity while nothing relevant changes', () => {
    const client = new FakeSyncClient();
    const values = track(usePosition, client);
    act(() => client.follow('g-1', { hasPosition: true, position: 7 }));
    const value = values.at(-1);
    act(() => client.emit('rosterChanged', { groupId: 'g-1', roster: [] }));
    expect(values.at(-1)).toBe(value);
  });
});

describe('useGroupEnded (AC23)', () => {
  it.each(['leader_timeout', 'inactivity', 'removed', 'ended_by_leader', 'max_session'] as const)(
    'exposes the end reason %s',
    (reason) => {
      const client = new FakeSyncClient();
      const values = track(useGroupEnded, client);
      act(() => client.follow('g-1'));
      expect(values.at(-1)).toBeNull();
      act(() => client.setGroup({ status: 'ended', groupId: 'g-1', reason }));
      expect(values.at(-1)).toEqual({ reason });
    },
  );

  it('includes the error code of a failed rejoin', () => {
    const client = new FakeSyncClient();
    const values = track(useGroupEnded, client);
    act(() =>
      client.setGroup({
        status: 'ended',
        groupId: 'g-1',
        reason: 'rejoin_failed',
        code: 'GROUP_ENDED',
      }),
    );
    expect(values.at(-1)).toEqual({ reason: 'rejoin_failed', code: 'GROUP_ENDED' });
  });
});

describe('useLeaderStatus', () => {
  it('follows the leader lifecycle of an active group', () => {
    const client = new FakeSyncClient();
    const values = track(useLeaderStatus, client);
    expect(values.at(-1)).toBeNull();
    act(() =>
      client.follow('g-1', {
        leaderOnline: false,
        leader: { status: 'offline', graceEndsAt: 10 },
      }),
    );
    expect(values.at(-1)).toEqual({
      online: false,
      lifecycle: { status: 'offline', graceEndsAt: 10 },
    });
  });
});

describe('useRemoved (AC22)', () => {
  it('is true after close 4004 and after a removed group end', () => {
    const client = new FakeSyncClient();
    const values = track(useRemoved, client);
    act(() => client.follow('g-1'));
    expect(values.at(-1)).toBe(false);
    act(() => client.setGroup({ status: 'ended', groupId: 'g-1', reason: 'removed' }));
    expect(values.at(-1)).toBe(true);
    act(() => client.setGroup(null));
    act(() =>
      client.setConnection({
        status: 'closed',
        reason: 'removed',
        error: new SyncClientError('REMOVED'),
      }),
    );
    expect(values.at(-1)).toBe(true);
  });
});

describe('useGroupExit', () => {
  it('end and leave call the core', async () => {
    const client = new FakeSyncClient();
    client.impl.endGroup = () => Promise.resolve();
    client.impl.leaveGroup = () => Promise.reject(new SyncClientError('LEADER_CANNOT_LEAVE'));
    const values = track(useGroupExit, client);
    act(() => client.setConnection(CONNECTED));
    let left: unknown;
    await act(async () => {
      await values.at(-1)!.end.run();
      left = await values.at(-1)!.leave.run();
    });
    expect(client.count('endGroup')).toBe(1);
    expect(left).toMatchObject({ ok: false, error: { code: 'LEADER_CANNOT_LEAVE' } });
    expect(values.at(-1)?.leave.error?.code).toBe('LEADER_CANNOT_LEAVE');
  });
});

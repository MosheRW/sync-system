import { SyncClientError } from '@mosherw/sync-system-client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRemoved } from '../src/hooks/group.js';
import { useJoinByCode } from '../src/hooks/join.js';
import { useKeepAlive } from '../src/hooks/leader.js';
import { useLeadership } from '../src/hooks/leadership.js';
import { useStoredGroups } from '../src/hooks/stored-groups.js';
import { FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

afterEach(() => {
  vi.useRealTimers();
});

function track<T>(use: () => T, client: FakeSyncClient): T[] {
  const values: T[] = [];
  function Probe(): ReactNode {
    values.push(use());
    return null;
  }
  renderWithProvider(<Probe />, { client });
  return values;
}

describe('useKeepAlive (AC21)', () => {
  it('sets and clears the prompt; answer calls the core', async () => {
    const client = new FakeSyncClient();
    client.impl.answerKeepAlive = () => client.emit('keepAliveCleared', { groupId: 'g-1' });
    const values = track(useKeepAlive, client);
    act(() => client.lead('g-1'));
    expect(values.at(-1)?.prompt).toBeNull();
    const prompt = { groupId: 'g-1', countdownMs: 30_000, deadlineAt: 99 };
    act(() => client.emit('keepAlive', prompt));
    expect(values.at(-1)?.prompt).toEqual(prompt);
    await act(async () => {
      await values.at(-1)!.answer.run();
    });
    expect(client.count('answerKeepAlive')).toBe(1);
    expect(values.at(-1)?.prompt).toBeNull();
  });

  it('drops the prompt when leadership is lost', () => {
    const client = new FakeSyncClient();
    const values = track(useKeepAlive, client);
    act(() => client.lead('g-1'));
    act(() => client.emit('keepAlive', { groupId: 'g-1', countdownMs: 1, deadlineAt: 2 }));
    act(() => {
      client.follow('g-1');
      client.emit('leadershipLost', {
        groupId: 'g-1',
        reason: 'handoff_inactivity',
        takeBackAvailable: true,
      });
    });
    expect(values.at(-1)?.prompt).toBeNull();
  });
});

describe('useLeadership (AC21)', () => {
  it('now leading, lost and changed', () => {
    vi.useFakeTimers({ now: 500 });
    const client = new FakeSyncClient();
    const values = track(useLeadership, client);
    act(() => client.follow('g-1'));
    expect(values.at(-1)).toMatchObject({ role: 'member', isLeader: false, lastChange: null });
    act(() => {
      client.lead('g-1');
      client.emit('nowLeading', { groupId: 'g-1', reason: 'handoff_disconnect' });
    });
    expect(values.at(-1)).toMatchObject({
      role: 'leader',
      isLeader: true,
      lastChange: { kind: 'now_leading', reason: 'handoff_disconnect', at: 500 },
    });
    act(() => {
      client.follow('g-1', { takeBackAvailable: true });
      client.emit('leadershipLost', {
        groupId: 'g-1',
        reason: 'handoff_inactivity',
        takeBackAvailable: true,
      });
    });
    expect(values.at(-1)).toMatchObject({
      isLeader: false,
      takeBackAvailable: true,
      lastChange: { kind: 'lost', takeBackAvailable: true },
    });
    act(() => client.emit('leaderChanged', { groupId: 'g-1', reason: 'take_back' }));
    expect(values.at(-1)?.lastChange).toMatchObject({ kind: 'changed', reason: 'take_back' });
    act(() => values.at(-1)!.dismiss());
    expect(values.at(-1)?.lastChange).toBeNull();
  });

  it('takeBack calls the core takeBackLeadership', async () => {
    const client = new FakeSyncClient();
    client.impl.takeBackLeadership = () => {
      client.lead('g-1');
      client.emit('nowLeading', { groupId: 'g-1', reason: 'take_back' });
    };
    const values = track(useLeadership, client);
    act(() => client.follow('g-1', { takeBackAvailable: true }));
    await act(async () => {
      await values.at(-1)!.takeBack.run();
    });
    expect(client.count('takeBackLeadership')).toBe(1);
    expect(values.at(-1)).toMatchObject({
      isLeader: true,
      takeBackAvailable: false,
      lastChange: { kind: 'now_leading', reason: 'take_back' },
    });
  });

  it('resets the last change when the group ends', () => {
    const client = new FakeSyncClient();
    const values = track(useLeadership, client);
    act(() => client.follow('g-1'));
    act(() => client.emit('leaderChanged', { groupId: 'g-1', reason: 'superseded' }));
    act(() => client.setGroup({ status: 'ended', groupId: 'g-1', reason: 'ended_by_leader' }));
    expect(values.at(-1)).toMatchObject({ role: null, lastChange: null });
  });
});

describe('removal is terminal (AC22)', () => {
  it('nothing connects, resumes or joins after close 4004', async () => {
    vi.useFakeTimers();
    const client = new FakeSyncClient();
    client.impl.checkTokens = () => [{ groupId: 'g-1', role: 'member', status: 'blocked' }];
    const removed: boolean[] = [];
    function Member(): ReactNode {
      removed.push(useRemoved());
      useStoredGroups({ checkOnConnect: true });
      useJoinByCode();
      useLeadership();
      return null;
    }
    const view = renderWithProvider(<Member />, { client });
    act(() => client.follow('g-1'));
    const connects = client.count('connect');
    act(() => {
      client.emit('removed', { groupId: 'g-1' });
      client.setSnapshot({
        connection: { status: 'closed', reason: 'removed', error: new SyncClientError('REMOVED') },
        group: { status: 'ended', groupId: 'g-1', reason: 'removed' },
      });
    });
    expect(removed.at(-1)).toBe(true);
    for (let i = 0; i < 10; i += 1) view.rerenderWith(<Member />, { client });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(client.count('connect')).toBe(connects);
    expect(client.count('resumeGroup')).toBe(0);
    expect(client.count('joinByCode')).toBe(0);
    expect(client.count('joinByQr')).toBe(0);
  });
});

import { SyncClientError } from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type LeaderCodes,
  useGroupLock,
  useHandoffMode,
  useJoinRequests,
  useLeaderCodes,
  useMemberRemoval,
  useQrTicket,
  useRoster,
  useViceLeader,
} from '../src/hooks/leader.js';
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
    const from = values.length;
    act(() => client.lead('g-2'));
    // Not even the first render after the switch returns the old codes.
    for (const value of values.slice(from)) expect(value.rotate.value).toBeUndefined();
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

const REQUEST = Object.freeze({ requestId: 'r-1', displayName: 'Bo', expiresAt: 5 });
const ENTRY = Object.freeze({
  participantId: 'p-1',
  displayName: '<b>Ana</b>',
  generated: false,
  role: 'member' as const,
  connected: true,
  joinedAt: 1,
});

describe('useJoinRequests (AC19)', () => {
  it('follows joinRequested, joinWithdrawn, joinPaused and joinResumed', () => {
    const client = new FakeSyncClient();
    const values = track(useJoinRequests, client);
    act(() => client.lead('g-1'));
    expect(values.at(-1)?.requests).toEqual([]);
    act(() => {
      client.requests = [REQUEST];
      client.emit('joinRequested', { ...REQUEST, groupId: 'g-1' });
    });
    expect(values.at(-1)?.requests).toEqual([REQUEST]);
    const list = values.at(-1)?.requests;
    act(() => client.emit('joinPaused', { groupId: 'g-1', retryAfterMs: 1 }));
    act(() => client.emit('joinResumed', { groupId: 'g-1' }));
    expect(values.at(-1)?.requests).toBe(list);
    act(() => {
      client.requests = [];
      client.emit('joinWithdrawn', { groupId: 'g-1', requestId: 'r-1', reason: 'timeout' });
    });
    expect(values.at(-1)?.requests).toEqual([]);
  });

  it('approve and deny call the core and re-read the list', async () => {
    const client = new FakeSyncClient();
    client.impl.approveJoin = () => {
      client.requests = [];
      return 'admitted';
    };
    client.impl.denyJoin = () => undefined;
    const values = track(useJoinRequests, client);
    act(() => {
      client.requests = [REQUEST];
      client.lead('g-1');
    });
    let approved: unknown;
    await act(async () => {
      approved = await values.at(-1)!.approve.run('r-1');
      await values.at(-1)!.deny.run('r-2');
    });
    expect(approved).toEqual({ ok: true, value: 'admitted' });
    expect(client.calls.get('approveJoin')).toEqual([['r-1']]);
    expect(client.calls.get('denyJoin')).toEqual([['r-2']]);
    expect(values.at(-1)?.requests).toEqual([]);
  });
});

describe('roster, vice, lock and removal (AC20)', () => {
  it('roster keeps its identity until rosterChanged changes it', () => {
    const client = new FakeSyncClient();
    client.roster = [ENTRY];
    const values = track(useRoster, client);
    expect(values.at(-1)).toEqual([]);
    act(() => client.lead('g-1'));
    const roster = values.at(-1);
    expect(roster).toEqual([ENTRY]);
    act(() => client.emit('rosterChanged', { groupId: 'g-1', roster: [ENTRY] }));
    expect(values.at(-1)).toBe(roster);
    act(() => {
      client.roster = [ENTRY, { ...ENTRY, participantId: 'p-2' }];
      client.emit('rosterChanged', { groupId: 'g-1', roster: client.roster });
    });
    expect(values.at(-1)).toHaveLength(2);
  });

  it('vice: leader viceId, member isVice, set and clear', async () => {
    const client = new FakeSyncClient();
    client.leaderState = { blockList: [], locked: false, handoff: 'auto' };
    client.impl.setViceLeader = (id: string) => {
      client.leaderState = { ...client.leaderState!, viceId: id };
      return id;
    };
    client.impl.clearViceLeader = () => {
      client.leaderState = { blockList: [], locked: false, handoff: 'auto' };
    };
    const values = track(useViceLeader, client);
    act(() => client.lead('g-1'));
    await act(async () => {
      await values.at(-1)!.setVice.run('p-1');
    });
    expect(values.at(-1)?.viceId).toBe('p-1');
    expect(values.at(-1)?.setVice.value).toBe('p-1');
    await act(async () => {
      await values.at(-1)!.clearVice.run();
    });
    expect(values.at(-1)?.viceId).toBeNull();

    const member = new FakeSyncClient();
    const memberValues = track(useViceLeader, member);
    act(() => member.follow('g-1'));
    act(() => member.emit('viceChanged', { groupId: 'g-1', isVice: true }));
    expect(memberValues.at(-1)?.isVice).toBe(true);
    expect(memberValues.at(-1)?.viceId).toBeNull();
  });

  it('lock and unlock', async () => {
    const client = new FakeSyncClient();
    client.impl.lockGroup = () => client.lead('g-1', { locked: true });
    const values = track(useGroupLock, client);
    act(() => client.lead('g-1'));
    expect(values.at(-1)?.locked).toBe(false);
    await act(async () => {
      await values.at(-1)!.lock.run();
    });
    expect(values.at(-1)?.locked).toBe(true);
    await act(async () => {
      const pending = values.at(-1)!.unlock.run();
      client.lastPending('unlockGroup').resolve(undefined);
      await pending;
    });
    expect(client.count('unlockGroup')).toBe(1);
  });

  it('remove and addToBlockList update the block list of the led group', async () => {
    const client = new FakeSyncClient();
    client.leaderState = { blockList: ['p-0'], locked: false, handoff: 'auto' };
    client.impl.removeMember = () => ['p-0', 'p-1'];
    client.impl.addToBlockList = (_g: string, ids: readonly string[]) => ['p-0', 'p-1', ...ids];
    const values = track(useMemberRemoval, client);
    act(() => client.lead('g-1'));
    expect(values.at(-1)?.blockList).toEqual(['p-0']);
    await act(async () => {
      await values.at(-1)!.remove.run('p-1');
    });
    expect(values.at(-1)?.blockList).toEqual(['p-0', 'p-1']);
    await act(async () => {
      await values.at(-1)!.addToBlockList.run(['p-7']);
    });
    expect(client.calls.get('addToBlockList')).toEqual([['g-1', ['p-7']]]);
    expect(values.at(-1)?.blockList).toEqual(['p-0', 'p-1', 'p-7']);
  });

  it('a member gets the core typed NOT_LEADER result', async () => {
    const client = new FakeSyncClient();
    client.impl.removeMember = () =>
      Promise.reject(new SyncClientError('NOT_LEADER', { request: 'member.remove' }));
    client.impl.lockGroup = () =>
      Promise.reject(new SyncClientError('NOT_LEADER', { request: 'group.lock' }));
    const values = track(() => ({ removal: useMemberRemoval(), lock: useGroupLock() }), client);
    act(() => client.follow('g-1'));
    let removed: unknown;
    let locked: unknown;
    await act(async () => {
      removed = await values.at(-1)!.removal.remove.run('p-1');
      locked = await values.at(-1)!.lock.lock.run();
    });
    expect(removed).toMatchObject({ ok: false, error: { code: 'NOT_LEADER' } });
    expect(locked).toMatchObject({ ok: false, error: { code: 'NOT_LEADER' } });
    expect(values.at(-1)?.removal.blockList).toEqual([]);
  });
});

describe('useHandoffMode (D2a)', () => {
  it('is the led group handoff mode when created, granted or resumed, and null otherwise', () => {
    const client = new FakeSyncClient();
    client.leaderState = { blockList: [], locked: false, handoff: 'auto' };
    const values = track(() => useHandoffMode(), client);
    expect(values.at(-1)).toBeNull();
    act(() => client.follow('g-1'));
    expect(values.at(-1)).toBeNull();
    // created / resumed as the leader
    act(() => client.lead('g-1'));
    expect(values.at(-1)).toBe('auto');
    // demoted
    act(() => {
      client.follow('g-1');
      client.emit('leadershipLost', {
        groupId: 'g-1',
        reason: 'take_back',
        takeBackAvailable: true,
      });
    });
    expect(values.at(-1)).toBeNull();
    // granted the lead of a frozen group
    client.leaderState = { blockList: [], locked: false, handoff: 'frozen' };
    act(() => {
      client.lead('g-1');
      client.emit('nowLeading', { groupId: 'g-1', reason: 'handoff_disconnect' });
    });
    expect(values.at(-1)).toBe('frozen');
    // resumed leading another group
    client.leaderState = { blockList: [], locked: true, handoff: 'auto' };
    act(() => client.lead('g-2'));
    expect(values.at(-1)).toBe('auto');
    for (const value of values) expect([null, 'auto', 'frozen']).toContain(value);
  });
});

describe('leader-only data and action values never outlive the role (R3, M3)', () => {
  type Everything = {
    codes: LeaderCodes;
    requests: ReturnType<typeof useJoinRequests>;
    roster: ReturnType<typeof useRoster>;
    vice: ReturnType<typeof useViceLeader>;
    removal: ReturnType<typeof useMemberRemoval>;
    qr: ReturnType<typeof useQrTicket>;
  };

  async function leadingWithValues(): Promise<{ client: FakeSyncClient; values: Everything[] }> {
    const client = new FakeSyncClient();
    client.codes = CODES;
    client.roster = [ENTRY];
    client.requests = [REQUEST];
    client.leaderState = { blockList: ['p-9'], locked: false, handoff: 'auto', viceId: 'p-1' };
    client.impl.rotateCodes = () => ({ generation: 9, groupCode: '777777' });
    client.impl.removeMember = () => ['p-9', 'p-1'];
    client.impl.setViceLeader = (id: string) => id;
    client.impl.approveJoin = () => 'admitted';
    client.impl.issueQrTicket = () => ({ ticket: 'tk-1', expiresAt: Date.now() + 60_000 });
    const values = track(
      (): Everything => ({
        codes: useLeaderCodes(),
        requests: useJoinRequests(),
        roster: useRoster(),
        vice: useViceLeader(),
        removal: useMemberRemoval(),
        qr: useQrTicket(),
      }),
      client,
    );
    act(() => client.lead('g-1'));
    await act(async () => {
      const v = values.at(-1)!;
      await v.codes.rotate.run();
      await v.removal.remove.run('p-1');
      await v.vice.setVice.run('p-1');
      await v.requests.approve.run('r-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const v = values.at(-1)!;
    expect(v.codes.codes).not.toBeNull();
    expect(v.codes.rotate.value).toBeDefined();
    expect(v.removal.remove.value).toBeDefined();
    expect(v.vice.setVice.value).toBe('p-1');
    expect(v.requests.approve.value).toBe('admitted');
    expect(v.roster).toHaveLength(1);
    expect(v.qr.state.status).toBe('ready');
    return { client, values };
  }

  /** No render from `from` on returns an old action value, not even for one commit. */
  function expectNoStaleValue(values: Everything[], from: number): void {
    expect(values.length).toBeGreaterThan(from);
    for (const [index, v] of values.slice(from).entries()) {
      const at = `render ${from + index}`;
      expect(v.codes.rotate.value, at).toBeUndefined();
      expect(v.requests.approve.value, at).toBeUndefined();
      expect(v.vice.setVice.value, at).toBeUndefined();
      expect(v.removal.remove.value, at).toBeUndefined();
    }
  }

  function expectNothingLeft(values: Everything[], from: number): void {
    expectNoStaleValue(values, from);
    const v = values.at(-1)!;
    expect(v.codes.codes).toBeNull();
    expect(v.codes.rotate.value).toBeUndefined();
    expect(v.requests.requests).toEqual([]);
    expect(v.requests.approve.value).toBeUndefined();
    expect(v.roster).toEqual([]);
    expect(v.vice.viceId).toBeNull();
    expect(v.vice.setVice.value).toBeUndefined();
    expect(v.removal.blockList).toEqual([]);
    expect(v.removal.remove.value).toBeUndefined();
    expect(v.qr.state).toEqual({ status: 'idle' });
  }

  it('demotion (leadershipLost)', async () => {
    const { client, values } = await leadingWithValues();
    const from = values.length;
    act(() => {
      client.follow('g-1');
      client.emit('leadershipLost', {
        groupId: 'g-1',
        reason: 'superseded',
        takeBackAvailable: false,
      });
    });
    expectNothingLeft(values, from);
  });

  it('removal (close 4004)', async () => {
    const { client, values } = await leadingWithValues();
    const from = values.length;
    act(() => {
      client.emit('removed', { groupId: 'g-1' });
      client.setSnapshot({
        connection: { status: 'closed', reason: 'removed', error: new SyncClientError('REMOVED') },
        group: { status: 'ended', groupId: 'g-1', reason: 'removed' },
      });
    });
    expectNothingLeft(values, from);
  });

  it('group end', async () => {
    const { client, values } = await leadingWithValues();
    const from = values.length;
    act(() => {
      client.setGroup({ status: 'ended', groupId: 'g-1', reason: 'ended_by_leader' });
      client.emit('groupEnded', { groupId: 'g-1', reason: 'ended_by_leader' });
    });
    expectNothingLeft(values, from);
  });

  it('group A -> group B', async () => {
    const { client, values } = await leadingWithValues();
    const before = values.at(-1)!.qr.state;
    const from = values.length;
    act(() => {
      client.codes = null;
      client.roster = [];
      client.requests = [];
      client.leaderState = null;
      client.lead('g-2');
    });
    expectNoStaleValue(values, from);
    const v = values.at(-1)!;
    expect(v.codes.codes).toBeNull();
    expect(v.codes.rotate.value).toBeUndefined();
    expect(v.requests.requests).toEqual([]);
    expect(v.requests.approve.value).toBeUndefined();
    expect(v.roster).toEqual([]);
    expect(v.vice.viceId).toBeNull();
    expect(v.vice.setVice.value).toBeUndefined();
    expect(v.removal.blockList).toEqual([]);
    expect(v.removal.remove.value).toBeUndefined();
    // Group A's ticket is gone; B gets its own (issued after the 10 s
    // floor), so the QR reads loading meanwhile.
    expect(v.qr.state).not.toBe(before);
    expect(v.qr.state).toEqual({ status: 'loading', ticket: null });
  });
});

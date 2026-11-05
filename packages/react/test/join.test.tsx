import { SyncClientError } from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useCreateGroup, useJoinApproval, useJoinByCode, useJoinByQr } from '../src/hooks/join.js';
import * as api from '../src/index.js';
import { CONNECTED, FakeSyncClient, activeGroup } from './helpers/fake-client.js';
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

const JOINED = Object.freeze({
  groupId: 'g-1',
  role: 'member' as const,
  participantId: 'p-1',
  metadata: {},
  hasPosition: false,
});

const CREATED = Object.freeze({
  groupId: 'g-1',
  role: 'leader' as const,
  participantId: 'p-self',
  joinMethods: ['C' as const],
  codes: { generation: 1, alphaCode: 'ABCDEFGH' },
});

describe('create and join actions (AC15)', () => {
  it('createGroup: pending -> value', async () => {
    const client = new FakeSyncClient();
    const values = track(useCreateGroup, client);
    act(() => client.setConnection(CONNECTED));
    let result: Promise<unknown> | undefined;
    act(() => {
      result = values.at(-1)!.run({ title: 'Book' }, { page: 1 }, { joinMethods: ['C'] });
    });
    expect(values.at(-1)?.pending).toBe(true);
    expect(client.calls.get('createGroup')?.[0]).toEqual([
      { title: 'Book' },
      { page: 1 },
      { joinMethods: ['C'] },
    ]);
    await act(async () => {
      client.lead('g-1');
      client.lastPending('createGroup').resolve(CREATED);
      await result;
    });
    expect(values.at(-1)).toMatchObject({ pending: false, value: CREATED, error: null });
  });

  it('createGroup value (codes) is dropped when this client stops leading (R3)', async () => {
    const client = new FakeSyncClient();
    client.impl.createGroup = () => {
      client.lead('g-1');
      return CREATED;
    };
    const values = track(useCreateGroup, client);
    act(() => client.setConnection(CONNECTED));
    await act(async () => {
      await values.at(-1)!.run({});
    });
    expect(values.at(-1)?.value).toBe(CREATED);
    const from = values.length;
    act(() => client.follow('g-1'));
    // Not even the first render after the demotion returns the codes.
    expect(values.length).toBeGreaterThan(from);
    for (const value of values.slice(from)) expect(value.value).toBeUndefined();
  });

  it.each([
    ['joinByCode', useJoinByCode, ['123456', { doorCode: '654321' }]],
    ['joinByQr', useJoinByQr, ['ticket-xyz', { displayName: 'Ana' }]],
  ] as const)('%s: value, and a rejection is a typed result', async (method, hook, args) => {
    const client = new FakeSyncClient();
    const values = track(hook, client);
    act(() => client.setConnection(CONNECTED));
    let ok: unknown;
    await act(async () => {
      const pending = values.at(-1)!.run(...(args as unknown as [string]));
      client.lastPending(method).resolve(JOINED);
      ok = await pending;
    });
    expect(ok).toEqual({ ok: true, value: JOINED });
    expect(client.calls.get(method)?.[0]).toEqual(args);

    const error = new SyncClientError('CODE_NOT_FOUND', { source: 'server' });
    let failed: unknown;
    await act(async () => {
      const pending = values.at(-1)!.run(...(args as unknown as [string]));
      client.lastPending(method).reject(error);
      failed = await pending;
    });
    expect(failed).toEqual({ ok: false, error });
    expect(values.at(-1)?.error).toBe(error);
  });

  it('exports no join by group ID (#10, BREAKING)', () => {
    const names = Object.keys(api);
    expect(names.filter((name) => /joinGroup|ByGroupId|ByGroup\b/i.test(name))).toEqual([]);
    expect(names).toContain('useJoinByCode');
    expect(names).toContain('useJoinByQr');
  });
});

describe('approval flow (AC17)', () => {
  function setup(): {
    client: FakeSyncClient;
    approval: ReturnType<typeof useJoinApproval>[];
    join: ReturnType<typeof useJoinByCode>[];
  } {
    const client = new FakeSyncClient();
    const approval: ReturnType<typeof useJoinApproval>[] = [];
    const join: ReturnType<typeof useJoinByCode>[] = [];
    function Probe(): ReactNode {
      approval.push(useJoinApproval());
      join.push(useJoinByCode());
      return null;
    }
    renderWithProvider(<Probe />, { client });
    act(() => client.setConnection(CONNECTED));
    return { client, approval, join };
  }

  it('waiting -> approved', async () => {
    const { client, approval, join } = setup();
    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = join.at(-1)!.run('123456', { displayName: 'Ana' });
    });
    expect(approval.at(-1)?.flow).toEqual({ status: 'joining' });
    act(() => client.setGroup({ status: 'awaiting_approval', requestId: 'r-1', expiresAt: 99 }));
    expect(approval.at(-1)?.flow).toEqual({ status: 'waiting', requestId: 'r-1', expiresAt: 99 });
    await act(async () => {
      client.setGroup(activeGroup('member'));
      client.lastPending('joinByCode').resolve(JOINED);
      await pending;
    });
    expect(approval.at(-1)?.flow).toEqual({ status: 'approved', group: JOINED });
    act(() => approval.at(-1)!.reset());
    expect(approval.at(-1)?.flow).toEqual({ status: 'idle' });
  });

  it.each([
    [new SyncClientError('JOIN_PAUSED', { details: { retryAfterMs: 0 } }), 'paused'],
    [new SyncClientError('JOIN_DENIED'), 'denied'],
    [new SyncClientError('APPROVAL_TIMEOUT'), 'withdrawn'],
    [new SyncClientError('JOIN_CANCELLED'), 'withdrawn'],
  ])('%s -> %s', async (error, status) => {
    const { client, approval, join } = setup();
    await act(async () => {
      const pending = join.at(-1)!.run('123456');
      client.lastPending('joinByCode').reject(error);
      await pending;
    });
    expect(approval.at(-1)?.flow.status).toBe(status);
  });

  it('cancel calls the core cancelJoin', async () => {
    const { client, approval, join } = setup();
    client.impl.cancelJoin = () => {
      client.lastPending('joinByCode').reject(new SyncClientError('JOIN_CANCELLED'));
      client.setGroup(null);
    };
    act(() => {
      void join.at(-1)!.run('123456', { displayName: 'Ana' });
    });
    act(() => client.setGroup({ status: 'awaiting_approval', requestId: 'r-1', expiresAt: 99 }));
    await act(async () => {
      await approval.at(-1)!.cancel.run();
    });
    expect(client.count('cancelJoin')).toBe(1);
    expect(approval.at(-1)?.flow).toEqual({ status: 'withdrawn', reason: 'cancelled' });
  });
});

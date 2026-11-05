import type { StoredGroupStatus } from '@sync-system/client';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useStoredGroups } from '../src/hooks/stored-groups.js';
import { SyncProvider } from '../src/provider.js';
import { CONNECTED, FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

const STATUSES: StoredGroupStatus[] = [
  { groupId: 'g-live', role: 'member', status: 'live' },
  { groupId: 'g-rec', role: 'leader', status: 'recoverable' },
  { groupId: 'g-wait', role: 'member', status: 'waiting' },
  { groupId: 'g-blk', role: 'member', status: 'blocked' },
  { groupId: 'g-end', role: 'member', status: 'ended' },
  { groupId: 'g-exp', role: 'member', status: 'expired' },
  { groupId: 'g-inv', role: 'member', status: 'invalid' },
];

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function track(
  client: FakeSyncClient,
  options?: Parameters<typeof useStoredGroups>[0],
): ReturnType<typeof useStoredGroups>[] {
  const values: ReturnType<typeof useStoredGroups>[] = [];
  function Probe(): ReactNode {
    values.push(useStoredGroups(options));
    return null;
  }
  renderWithProvider(<Probe />, { client });
  return values;
}

describe('useStoredGroups (AC16)', () => {
  it('maps all seven statuses to live, resumable or gone', async () => {
    const client = new FakeSyncClient();
    client.impl.checkTokens = () => STATUSES;
    const values = track(client);
    act(() => client.setConnection(CONNECTED));
    expect(values.at(-1)?.groups).toBeNull();
    await act(async () => {
      await values.at(-1)!.check.run();
    });
    expect(values.at(-1)?.groups?.map((g) => [g.groupId, g.availability])).toEqual([
      ['g-live', 'live'],
      ['g-rec', 'resumable'],
      ['g-wait', 'resumable'],
      ['g-blk', 'gone'],
      ['g-end', 'gone'],
      ['g-exp', 'gone'],
      ['g-inv', 'gone'],
    ]);
  });

  it('resume calls the core resumeGroup, never on its own', async () => {
    const client = new FakeSyncClient();
    client.impl.checkTokens = () => STATUSES;
    client.impl.resumeGroup = () => ({
      groupId: 'g-rec',
      role: 'leader',
      participantId: 'p-self',
      status: 'active',
      recreated: true,
      leaderOnline: true,
      hasPosition: false,
    });
    const values = track(client, { checkOnConnect: true });
    act(() => client.setConnection(CONNECTED));
    await flush();
    expect(client.count('resumeGroup')).toBe(0);
    let result: unknown;
    await act(async () => {
      result = await values.at(-1)!.resume.run('g-rec', { position: 2 });
    });
    expect(client.calls.get('resumeGroup')).toEqual([['g-rec', { position: 2 }]]);
    expect(result).toMatchObject({ ok: true, value: { recreated: true } });
  });

  it('makes no check unless checkOnConnect (Q-D)', async () => {
    const client = new FakeSyncClient();
    client.impl.checkTokens = () => STATUSES;
    track(client);
    act(() => client.setConnection(CONNECTED));
    await flush();
    expect(client.count('checkTokens')).toBe(0);
  });

  it('checkOnConnect checks once per connected session, under StrictMode', async () => {
    const client = new FakeSyncClient();
    client.impl.checkTokens = () => STATUSES;
    const values = track(client, { checkOnConnect: true });
    act(() => client.setConnection(CONNECTED));
    await flush();
    expect(client.count('checkTokens')).toBe(1);
    expect(values.at(-1)?.groups).toHaveLength(7);
    act(() => client.setConnection({ ...CONNECTED }));
    await flush();
    expect(client.count('checkTokens')).toBe(1);
    act(() =>
      client.setConnection({
        status: 'reconnecting',
        attempt: 1,
        delayMs: 1,
        retryAt: 1,
        attempting: true,
      }),
    );
    act(() => client.setConnection(CONNECTED));
    await flush();
    expect(client.count('checkTokens')).toBe(2);
  });

  it('does nothing without a client (server, before mount)', async () => {
    const values: ReturnType<typeof useStoredGroups>[] = [];
    function Probe(): ReactNode {
      values.push(useStoredGroups({ checkOnConnect: true }));
      return null;
    }
    render(
      <SyncProvider options={{ url: 'not a url', apiKey: 'test-key', appVersion: '1.0.0' }}>
        <Probe />
      </SyncProvider>,
    );
    let result: unknown;
    await act(async () => {
      result = await values.at(-1)!.resume.run('g-1');
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
    expect(values.at(-1)?.groups).toBeNull();
  });
});

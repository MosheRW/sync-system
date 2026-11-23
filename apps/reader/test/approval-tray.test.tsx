import { type JoinRequest, SyncClientError } from '@mosherw/sync-system-react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeSyncClient } from './helpers/fake-sync-client.js';
import { GROUP_ID } from './helpers/fake-sync-client.js';
import { createAsLeader, largeScreen, renderGroupApp } from './helpers/group.js';

afterEach(() => vi.unstubAllGlobals());

function request(id: string, displayName?: string): JoinRequest {
  return {
    requestId: id.padEnd(22, 'x'),
    expiresAt: Date.now() + 120_000,
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

function arrive(client: FakeSyncClient, ...list: JoinRequest[]) {
  act(() => {
    client.requests = [...client.requests, ...list];
    for (const r of list) client.emit('joinRequested', { ...r, groupId: GROUP_ID });
  });
}

function withdraw(client: FakeSyncClient, r: JoinRequest) {
  act(() => {
    client.requests = client.requests.filter((x) => x.requestId !== r.requestId);
    client.emit('joinWithdrawn', {
      groupId: GROUP_ID,
      requestId: r.requestId,
      reason: 'cancelled',
    });
  });
}

async function leaderWithTray() {
  const { client } = await renderGroupApp();
  await createAsLeader(client, ['B']);
  fireEvent.click(screen.getByRole('button', { name: 'Start reading' }));
  return client;
}

describe('approval tray (#24 AC20, design F9, 6.15)', () => {
  it('shows the oldest request, all on Show all, names as plain text', async () => {
    const client = await leaderWithTray();
    const before = document.activeElement;
    arrive(client, request('a', '<b>x</b>'), request('b', '‮evil'), request('c'));
    const tray = screen.getByRole('region', { name: 'Join requests' });
    expect(document.activeElement).toBe(before);
    expect(tray.querySelector('b')).toBeNull();
    expect(within(tray).getByText('<b>x</b>').tagName).toBe('BDI');
    expect(within(tray).getByText('<b>x</b>').getAttribute('dir')).toBe('auto');
    expect(within(tray).getByRole('button', { name: 'Let <b>x</b> in' })).toBeDefined();
    fireEvent.click(within(tray).getByRole('button', { name: '2 more waiting · Show all' }));
    expect(within(tray).getAllByRole('listitem')).toHaveLength(3);
    expect(within(tray).getByText('Someone wants to join')).toBeDefined();
    expect(
      screen.getAllByRole('status').some((el) => el.textContent === 'Someone wants to join'),
    ).toBe(true);
  });

  it('approves and denies; a withdrawn request disappears and focus moves on', async () => {
    const client = await leaderWithTray();
    const a = request('a', 'Dana');
    const b = request('b', 'Lee');
    arrive(client, a, b);
    const tray = screen.getByRole('region', { name: 'Join requests' });
    fireEvent.click(within(tray).getByRole('button', { name: '1 more waiting · Show all' }));
    client.impl.approveJoin = () => 'admitted';
    const letIn = within(tray).getByRole('button', { name: 'Let Dana in' });
    letIn.focus();
    await act(async () => {
      fireEvent.click(letIn);
      await Promise.resolve();
    });
    expect(client.args('approveJoin')).toEqual([a.requestId]);
    withdraw(client, a);
    expect(within(tray).queryByText('Dana')).toBeNull();
    expect(document.activeElement).toBe(within(tray).getByRole('button', { name: 'Let Lee in' }));
    client.impl.denyJoin = () => {
      throw new SyncClientError('CONNECTION_LOST');
    };
    await act(async () => {
      fireEvent.click(within(tray).getByRole('button', { name: 'Deny Lee' }));
      await Promise.resolve();
    });
    expect(within(tray).getByRole('alert').textContent).toBe(
      "Couldn't answer this request. Try again.",
    );
  });

  it('sits at the top of the panel on large screens', async () => {
    largeScreen();
    const client = await leaderWithTray();
    arrive(client, request('a', 'Dana'));
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    expect(within(panel).getByRole('region', { name: 'Join requests' })).toBeDefined();
  });

  it('goes with the lead (AC13)', async () => {
    const client = await leaderWithTray();
    arrive(client, request('a', 'Dana'));
    act(() => client.patchGroup({ role: 'member' }));
    expect(screen.queryByRole('region', { name: 'Join requests' })).toBeNull();
  });
});

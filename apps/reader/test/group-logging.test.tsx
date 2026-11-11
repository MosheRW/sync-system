import { SyncClientError } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripLaterTickets } from '../src/group/deep-link.js';
import { createPastedLinkSignal } from '../src/group/pasted-link.js';
import { FakeSyncClient, GROUP_ID, connected } from './helpers/fake-sync-client.js';
import {
  CODES,
  createAsLeader,
  largeScreen,
  localMetadata,
  renderGroupApp,
  rosterEntry,
} from './helpers/group.js';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('the reader logs nothing about groups (#24 AC54, R9)', () => {
  it('stays silent through create, codes, join errors and end', async () => {
    const spies = METHODS.map((method) => vi.spyOn(console, method));
    const { client } = await renderGroupApp();
    await createAsLeader(client);
    act(() =>
      client.emit('codesChanged', {
        groupId: GROUP_ID,
        codes: { generation: 2, groupCode: '111222', doorCode: '333444' },
        reason: 'rotated',
      }),
    );
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'ended_by_leader' }));

    act(() => client.setConnection(connected()));
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Join a group' }));
    const dialog = screen.getByRole('dialog', { name: 'Join a group' });
    client.impl.joinByCode = () => {
      throw new SyncClientError('CODE_NOT_FOUND');
    };
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Code' }), {
      target: { value: '482913' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
      await Promise.resolve();
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the group UI in Hebrew (#24 AC50)', () => {
  it('is right to left with Hebrew text, while codes and inputs stay left to right', async () => {
    const { client } = await renderGroupApp({ uiLang: 'he' });
    act(() => client.setConnection(connected()));
    fireEvent.click(screen.getByRole('button', { name: 'קבוצה, אפשרויות קבוצה' }));
    expect(screen.getByRole('dialog', { name: 'קריאה משותפת' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'הצטרפות לקבוצה' }));
    const field = screen.getByRole('textbox', { name: 'קוד' });
    expect(field.getAttribute('dir')).toBe('ltr');
  });
});

describe('the reader logs nothing about 8b flows (#25 AC54, R19)', () => {
  it('stays silent through roster, vice, remove, lock, preview, keep-alive, leadership and QR pasted', async () => {
    const spies = METHODS.map((method) => vi.spyOn(console, method));
    const pastedLinks = createPastedLinkSignal();
    const stop = stripLaterTickets(window, pastedLinks.notify);
    largeScreen();
    const client = new FakeSyncClient();
    client.codes = CODES;
    client.leaderState = { blockList: [], locked: false, handoff: 'auto' };
    const metadata = await localMetadata();
    await renderGroupApp({ client, pastedLinks });
    act(() => client.follow({ metadata, hasPosition: true, position: { v: 1, pageIndex: 0 } }));
    act(() => client.emit('leaderChanged', { groupId: GROUP_ID, reason: 'superseded' }));
    act(() => client.emit('viceChanged', { groupId: GROUP_ID, isVice: true }));
    act(() => client.emit('lockChanged', { groupId: GROUP_ID, locked: true }));
    // now leading
    act(() => {
      client.patchGroup({ role: 'leader' });
      client.emit('nowLeading', { groupId: GROUP_ID, reason: 'handoff_disconnect' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    act(() =>
      client.setRoster([
        rosterEntry('p-self', { role: 'leader' }),
        rosterEntry('p-a', { displayName: '<b>Dana</b>' }),
      ]),
    );
    // vice, remove, lock
    const list = screen.getByRole('region', { name: 'People (2)' });
    fireEvent.click(within(list).getByRole('button', { name: /^<b>Dana<\/b>/ }));
    client.impl.setViceLeader = () => 'p-a';
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Make vice-leader' }));
      await Promise.resolve();
    });
    fireEvent.click(within(list).getByRole('button', { name: /^<b>Dana<\/b>/ }));
    fireEvent.click(within(list).getByRole('button', { name: 'Remove from group' }));
    client.impl.removeMember = () => {
      throw new SyncClientError('BLOCK_LIST_FULL');
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    client.impl.lockGroup = () => undefined;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Lock group' }));
      await Promise.resolve();
    });
    // preview: start, move, bring, return
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview pages' }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Bring group here' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview pages' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Return to group' }));
    // keep-alive
    act(() =>
      client.emit('keepAlive', {
        groupId: GROUP_ID,
        countdownMs: 60_000,
        deadlineAt: Date.now() + 60_000,
      }),
    );
    client.impl.answerKeepAlive = () => undefined;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
      await Promise.resolve();
    });
    // lost, take-back
    act(() => {
      client.patchGroup({ role: 'member', takeBackAvailable: true });
      client.emit('leadershipLost', {
        groupId: GROUP_ID,
        reason: 'handoff_disconnect',
        takeBackAvailable: true,
      });
    });
    client.impl.takeBackLeadership = () => {
      throw new SyncClientError('NOT_ALLOWED');
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take the lead' }));
      await Promise.resolve();
    });
    // lost while away (Q-A1)
    act(() => {
      client.patchGroup({ role: 'leader' });
      client.emit('nowLeading', { groupId: GROUP_ID, reason: 'take_back' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    act(() => {
      client.patchGroup({ role: 'member' });
      client.emit('rejoined', {
        groupId: GROUP_ID,
        role: 'member',
        participantId: 'p-self',
        status: 'active',
        recreated: false,
        leaderOnline: true,
        hasPosition: false,
      });
    });
    // QR pasted
    act(() => {
      history.replaceState(null, '', `/#t=eyJnIjoxfQ.${'s'.repeat(43)}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    stop();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

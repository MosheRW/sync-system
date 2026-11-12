import { type RosterEntry, SyncClientError } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSyncClient, GROUP_ID } from './helpers/fake-sync-client.js';
import {
  CODES,
  getNotice,
  largeScreen,
  localMetadata,
  renderGroupApp,
  rosterEntry,
} from './helpers/group.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ME = rosterEntry('p-self', { role: 'leader', displayName: 'Dana' });
const YOSSI = rosterEntry('p-yossi', { displayName: 'Yossi' });
const AWAY = rosterEntry('p-away', { displayName: 'Rina', connected: false });
const GUEST = rosterEntry('p-guest', { displayName: 'Guest 4', generated: true, guestNumber: 4 });

async function leaderWith(roster: readonly RosterEntry[], uiLang: 'en' | 'he' = 'en') {
  largeScreen();
  const client = new FakeSyncClient();
  client.codes = CODES;
  client.leaderState = { blockList: [], locked: false, handoff: 'auto' };
  await renderGroupApp({ client, uiLang });
  act(() => client.lead());
  act(() => client.setRoster(roster));
  return client;
}

const list = () => screen.getByRole('region', { name: /^People \(/ });
const toggle = (name: string) =>
  within(list()).getByRole('button', { name: new RegExp(`^${name}`) });
const live = () => document.querySelector('[aria-live="polite"]')!.textContent;

async function settle(promise: { resolve: (v: unknown) => void } | (() => void), value?: unknown) {
  await act(async () => {
    if (typeof promise === 'function') promise();
    else promise.resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function fail(
  client: FakeSyncClient,
  method: Parameters<FakeSyncClient['lastPending']>[0],
  error: SyncClientError,
) {
  await act(async () => {
    client.lastPending(method).reject(error);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('rows and their actions (#25 AC42, design 6.2)', () => {
  it('a row toggle is named by the name and details elements, one row open at a time', async () => {
    await leaderWith([ME, YOSSI, AWAY]);
    const yossi = toggle('Yossi');
    expect(yossi.getAttribute('aria-labelledby')!.split(' ')).toHaveLength(2);
    expect(yossi.getAttribute('aria-label')).toBeNull();
    expect(yossi.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(yossi);
    expect(yossi.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(yossi.getAttribute('aria-controls')!)).not.toBeNull();
    fireEvent.click(toggle('Rina'));
    expect(yossi.getAttribute('aria-expanded')).toBe('false');
    expect(within(list()).queryByRole('button', { name: /^Dana/ })).toBeNull();
  });

  it('makes a vice-leader with the ID of the row, replaces one, and clears it', async () => {
    const client = await leaderWith([ME, YOSSI, GUEST]);
    fireEvent.click(toggle('Yossi'));
    fireEvent.click(within(list()).getByRole('button', { name: 'Make vice-leader' }));
    expect(client.args('setViceLeader')).toEqual(['p-yossi']);
    expect(within(list()).getByRole('button', { name: 'Making vice-leader…' })).toBeDefined();
    expect(
      within(list())
        .getByRole('button', { name: 'Remove from group' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    client.leaderState = { ...client.leaderState!, viceId: 'p-yossi' };
    await settle(client.lastPending('setViceLeader'), 'p-yossi');
    act(() => client.setRoster([ME, YOSSI, GUEST]));
    expect(live()).toBe('Vice-leader now: ⁨Yossi⁩.');
    expect(document.activeElement).toBe(toggle('Yossi'));
    expect(toggle('Yossi').textContent).toContain('Vice-leader · Here');
    // replace: Guest 4 becomes vice
    fireEvent.click(toggle('Guest 4'));
    fireEvent.click(within(list()).getByRole('button', { name: 'Make vice-leader' }));
    expect(client.args('setViceLeader')).toEqual(['p-guest']);
    client.leaderState = { ...client.leaderState, viceId: 'p-guest' };
    await settle(client.lastPending('setViceLeader'), 'p-guest');
    act(() => client.setRoster([ME, YOSSI, GUEST]));
    expect(toggle('Yossi').textContent).toContain('Member · Here');
    expect(toggle('Guest 4').textContent).toContain('Vice-leader · Here · Auto name');
    // clear
    fireEvent.click(toggle('Guest 4'));
    fireEvent.click(within(list()).getByRole('button', { name: 'Remove as vice-leader' }));
    expect(client.count('clearViceLeader')).toBe(1);
    expect(within(list()).getByRole('button', { name: 'Removing as vice-leader…' })).toBeDefined();
    await settle(client.lastPending('clearViceLeader'));
    expect(live()).toBe("There's no vice-leader now.");
  });

  it('an away member cannot be made vice-leader: inactive with a hint', async () => {
    const client = await leaderWith([ME, AWAY]);
    fireEvent.click(toggle('Rina'));
    const make = within(list()).getByRole('button', { name: 'Make vice-leader' });
    expect(make.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(make.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe("Only someone who's here can be vice-leader.");
    fireEvent.click(make);
    expect(client.count('setViceLeader')).toBe(0);
  });

  it.each([
    ['NOT_ALLOWED', "Yossi isn't here, so they can't be vice-leader."],
    ['PARTICIPANT_NOT_FOUND', 'Yossi has already left the group.'],
    ['NOT_LEADER', "You're not leading any more, so nothing changed."],
    ['NOT_CONNECTED', "Can't reach the group service. Check your connection, then try again."],
  ])('says why making a vice-leader failed: %s', async (code, text) => {
    const client = await leaderWith([ME, YOSSI]);
    fireEvent.click(toggle('Yossi'));
    fireEvent.click(within(list()).getByRole('button', { name: 'Make vice-leader' }));
    await fail(client, 'setViceLeader', new SyncClientError(code as never));
    const alert = within(list()).getByRole('alert');
    expect(alert.textContent).toBe(text);
    if (code !== 'NOT_LEADER' && code !== 'NOT_CONNECTED') {
      expect(alert.querySelector('bdi')?.textContent).toBe('Yossi');
    }
  });

  it('RATE_LIMITED counts down with the button inactive, then says you can try now (AC53)', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });
    const client = await leaderWith([ME, YOSSI]);
    fireEvent.click(toggle('Yossi'));
    fireEvent.click(within(list()).getByRole('button', { name: 'Make vice-leader' }));
    await fail(
      client,
      'setViceLeader',
      new SyncClientError('RATE_LIMITED', { details: { retryAfterMs: 3000 } }),
    );
    expect(within(list()).getByRole('alert').textContent).toBe(
      'Too many tries. Try again in 3 seconds.',
    );
    const make = within(list()).getByRole('button', { name: 'Make vice-leader' });
    expect(make.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(3250);
    });
    expect(within(list()).getByRole('alert').textContent).toBe('You can try again now.');
    expect(make.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('remove a member (#25 AC43, design F17, 6.6)', () => {
  function openRemove(name: string) {
    fireEvent.click(toggle(name));
    const button = within(list()).getByRole('button', { name: 'Remove from group' });
    act(() => button.focus());
    fireEvent.click(button);
    return button;
  }

  it('names the person and their details, focus on Cancel, Esc returns focus', async () => {
    await leaderWith([ME, GUEST]);
    const opener = openRemove('Guest 4');
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Guest 4?' });
    expect(dialog.textContent).toContain('Member · Here · Auto name');
    expect(dialog.textContent).toContain("They can't come back to this group.");
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('removes by the row ID; the row goes, focus to the next row, announced', async () => {
    const client = await leaderWith([ME, YOSSI, GUEST, AWAY]);
    openRemove('Guest 4');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(client.args('removeMember')).toEqual(['p-guest']);
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDefined();
    await settle(client.lastPending('removeMember'), ['p-guest']);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(toggle('Rina'));
    expect(live()).toBe('⁨Guest 4⁩ was removed from the group.');
    act(() => client.setRoster([ME, YOSSI, AWAY]));
    act(() =>
      client.emit('codesChanged', {
        groupId: GROUP_ID,
        codes: { generation: 2, groupCode: '111222' },
        reason: 'member_removed',
      }),
    );
    expect(getNotice('The codes changed')).toBeDefined();
  });

  it('moves focus to the previous row, else the heading', async () => {
    const client = await leaderWith([ME, YOSSI, GUEST]);
    openRemove('Guest 4');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await settle(client.lastPending('removeMember'), []);
    expect(document.activeElement).toBe(toggle('Yossi'));
    act(() => client.setRoster([ME, YOSSI]));
    openRemove('Yossi');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await settle(client.lastPending('removeMember'), []);
    act(() => client.setRoster([ME]));
    expect(document.activeElement).toBe(
      within(list()).getByRole('heading', { name: 'People (1)' }),
    );
  });

  it.each([
    ['BLOCK_LIST_FULL', "You can't remove anyone else from this group."],
    ['CODES_EXHAUSTED', "Couldn't make new codes, so nobody was removed."],
    ['RATE_LIMITED', 'Too many tries. Wait a moment, then try again.'],
  ])('keeps the dialog open on %s', async (code, text) => {
    const client = await leaderWith([ME, YOSSI]);
    openRemove('Yossi');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await Promise.resolve();
    });
    await fail(client, 'removeMember', new SyncClientError(code as never));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('alert').textContent).toContain(text);
  });

  it('PARTICIPANT_NOT_FOUND closes the dialog with a message above the list', async () => {
    const client = await leaderWith([ME, YOSSI]);
    openRemove('Yossi');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await fail(client, 'removeMember', new SyncClientError('PARTICIPANT_NOT_FOUND'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(list()).getByRole('alert').textContent).toBe('Yossi has already left the group.');
  });

  it('a person who leaves while the dialog is open closes it with the same message', async () => {
    const client = await leaderWith([ME, YOSSI, AWAY]);
    openRemove('Yossi');
    act(() => client.setRoster([ME, AWAY]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(list()).getByRole('alert').textContent).toBe('Yossi has already left the group.');
    expect(document.activeElement).toBe(toggle('Rina'));
  });
});

describe('lock and unlock (#25 AC44, design F18, 6.5)', () => {
  it('locks with a pending label, then shows the lock line and Unlock', async () => {
    const client = await leaderWith([ME]);
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    const lock = within(panel).getByRole('button', { name: 'Lock group' });
    const hint = document.getElementById(lock.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain('Nobody new can join until you unlock it.');
    fireEvent.click(lock);
    expect(within(panel).getByRole('button', { name: 'Locking…' })).toBeDefined();
    await settle(() => {
      client.lastPending('lockGroup').resolve(undefined);
      client.patchGroup({ locked: true });
    });
    expect(live()).toBe('The group is locked.');
    expect(panel.textContent).toContain('Locked: nobody new can join.');
    fireEvent.click(within(panel).getByRole('button', { name: 'Unlock group' }));
    expect(within(panel).getByRole('button', { name: 'Unlocking…' })).toBeDefined();
    await settle(() => {
      client.lastPending('unlockGroup').resolve(undefined);
      client.patchGroup({ locked: false });
    });
    expect(live()).toBe('The group is open to new people again.');
    expect(panel.textContent).not.toContain('Locked: nobody new can join.');
  });

  it('shows errors under the button', async () => {
    const client = await leaderWith([ME]);
    fireEvent.click(screen.getByRole('button', { name: 'Lock group' }));
    await fail(client, 'lockGroup', new SyncClientError('NOT_CONNECTED'));
    expect(screen.getByRole('alert').textContent).toContain("Can't reach the group service.");
  });

  it('shows the lock line in the strip and the leader sheet on phones', async () => {
    const client = new FakeSyncClient();
    client.codes = CODES;
    await renderGroupApp({ client });
    act(() => client.lead({ locked: true }));
    const strip = screen.getByRole('region', { name: 'Group codes' });
    expect(strip.textContent).toContain('Locked: nobody new can join.');
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    const sheet = screen.getByRole('dialog', { name: 'Your group' });
    expect(sheet.textContent).toContain('Locked: nobody new can join.');
    expect(within(sheet).getByRole('button', { name: 'Unlock group' })).toBeDefined();
  });
});

describe('member side of lock and vice (#25 AC44, AC60)', () => {
  async function member(extra = {}) {
    const client = new FakeSyncClient();
    const metadata = await localMetadata();
    await renderGroupApp({ client });
    act(() => client.follow({ metadata, ...extra }));
    return client;
  }

  it('a lock change shows a notice; the member sheet says the group is locked', async () => {
    const client = await member();
    act(() => {
      client.patchGroup({ locked: true });
      client.emit('lockChanged', { groupId: GROUP_ID, locked: true });
    });
    expect(getNotice('The leader locked the group. Nobody new can join.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    expect(screen.getByRole('dialog').textContent).toContain(
      'The group is locked. Nobody new can join.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => {
      client.patchGroup({ locked: false });
      client.emit('lockChanged', { groupId: GROUP_ID, locked: false });
    });
    expect(getNotice('The leader unlocked the group. New people can join again.')).toBeDefined();
  });

  it('no banner for a member who joined a locked group', async () => {
    await member({ locked: true });
    expect(screen.queryByText(/The leader locked the group/)).toBeNull();
  });

  it('vice set and cleared: notices and the member sheet line', async () => {
    const client = await member();
    act(() => client.emit('viceChanged', { groupId: GROUP_ID, isVice: true }));
    expect(
      getNotice("You're the vice-leader. If the leader drops, you'll lead the group."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    expect(screen.getByRole('dialog').textContent).toContain('Your role: vice-leader.');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => client.emit('viceChanged', { groupId: GROUP_ID, isVice: false }));
    expect(getNotice("You're no longer the vice-leader.")).toBeDefined();
  });

  it('no "no longer vice" when the vice becomes leader; the inherited lock shows with no notice', async () => {
    const client = await member({ locked: true });
    act(() => client.emit('viceChanged', { groupId: GROUP_ID, isVice: true }));
    client.codes = CODES;
    act(() => {
      client.lead({ locked: true });
      client.emit('viceChanged', { groupId: GROUP_ID, isVice: false });
    });
    expect(screen.queryByText("You're no longer the vice-leader.")).toBeNull();
    expect(screen.queryByText(/You're the vice-leader/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Group codes' }).textContent).toContain(
      'Locked: nobody new can join.',
    );
  });
});

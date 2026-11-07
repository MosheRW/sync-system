import { type JoinedGroup, SyncClientError } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/group/browser.js';
import { POINTER_KEY, SYNC, readingReady, renderApp, testConfig } from './helpers/app.js';
import { FakeSyncClient, GROUP_ID, OTHER_GROUP_ID, connected } from './helpers/fake-sync-client.js';
import { PRIDE } from './helpers/group.js';
import { MemoryStorage } from './helpers/storage.js';

const TICKET = `eyJnIjoxfQ.${'s'.repeat(43)}`;
const META = {
  contentId: 'samples/pride-and-prejudice-en',
  fingerprint: 'a'.repeat(64),
  schemaVersion: 1,
};

afterEach(() => vi.restoreAllMocks());

function joinedAs(client: FakeSyncClient, metadata = META): JoinedGroup {
  client.follow({ metadata });
  return {
    groupId: GROUP_ID,
    role: 'member',
    participantId: 'p-self',
    metadata,
    hasPosition: false,
  };
}

async function land(
  landing: { kind: 'ticket'; ticket: string } | { kind: 'invalid' },
  storage = new MemoryStorage(),
) {
  const client = new FakeSyncClient();
  renderApp({
    config: testConfig('library', 'on', { sync: SYNC }),
    location: PRIDE,
    storage,
    syncClient: client,
    qrLanding: landing,
  });
  await readingReady();
  return { client, storage };
}

describe('joining from a QR deep link (#24 AC17, design F5)', () => {
  it('opens "Joining the group…" with zero taps and joins once connected', async () => {
    const { client, storage } = await land({ kind: 'ticket', ticket: TICKET });
    expect(screen.getByRole('dialog', { name: 'Joining the group…' })).toBeDefined();
    expect(client.count('joinByQr')).toBe(0);
    client.impl.joinByQr = () => joinedAs(client);
    await act(async () => {
      client.setConnection(connected());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.args('joinByQr')).toEqual([TICKET, undefined]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(JSON.parse(storage.getItem(POINTER_KEY)!)).toMatchObject({ groupId: GROUP_ID });
    // The ticket lives in memory only (R3).
    expect(document.documentElement.outerHTML).not.toContain(TICKET);
    expect([...storage.items.values()].join()).not.toContain(TICKET);
  });

  it.each([
    [
      'QR_EXPIRED',
      "This QR code has expired. Scan the leader's current code, or join with a code.",
    ],
    ['QR_INVALID', "This QR code doesn't work. Scan the leader's code again, or join with a code."],
    ['GROUP_FULL', 'This group is full. Ask the leader.'],
  ] as const)('%s: "Couldn\'t join the group" with next steps', async (code, message) => {
    const { client } = await land({ kind: 'ticket', ticket: TICKET });
    client.impl.joinByQr = () => {
      throw new SyncClientError(code);
    };
    await act(async () => {
      client.setConnection(connected());
      await Promise.resolve();
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: "Couldn't join the group" });
    expect(within(dialog).getByRole('alert').textContent).toBe(message);
    expect(within(dialog).getByRole('alert').textContent).not.toContain(TICKET);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Join with a code' }));
    expect(screen.getByRole('dialog', { name: 'Join a group' })).toBeDefined();
  });

  it('fails a malformed ticket at once, sends nothing, and Read on my own closes', async () => {
    const { client } = await land({ kind: 'invalid' });
    const dialog = screen.getByRole('dialog', { name: "Couldn't join the group" });
    act(() => client.setConnection(connected()));
    expect(client.count('joinByQr')).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Read on my own' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/^1 \/ \d+$/)).toBeDefined();
  });
});

describe('a QR ticket in a tab that already has a group (security L3)', () => {
  function withPointer() {
    const storage = new MemoryStorage();
    storage.setItem(
      POINTER_KEY,
      JSON.stringify({
        v: 1,
        groupId: OTHER_GROUP_ID,
        mode: 'following',
        ack: null,
        qrShown: false,
      }),
    );
    return storage;
  }

  it('asks once; Stay in my group drops the ticket', async () => {
    const { client } = await land({ kind: 'ticket', ticket: TICKET }, withPointer());
    const ask = screen.getByRole('alertdialog', {
      name: 'Leave your current group and join this one?',
    });
    expect(document.activeElement).toBe(
      within(ask).getByRole('button', { name: 'Stay in my group' }),
    );
    fireEvent.click(within(ask).getByRole('button', { name: 'Stay in my group' }));
    act(() => client.setConnection(connected()));
    expect(client.count('joinByQr')).toBe(0);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Join this group leaves the stored group first, then joins', async () => {
    const { client, storage } = await land({ kind: 'ticket', ticket: TICKET }, withPointer());
    act(() => client.setConnection(connected()));
    client.impl.resumeGroup = () => {
      client.follow({ groupId: OTHER_GROUP_ID });
      return {
        groupId: OTHER_GROUP_ID,
        role: 'member',
        participantId: 'p',
        status: 'active',
        recreated: false,
        leaderOnline: true,
        hasPosition: false,
      };
    };
    client.impl.leaveGroup = () => {
      client.setGroup({ status: 'ended', groupId: OTHER_GROUP_ID, reason: 'left' });
    };
    client.impl.joinByQr = () => joinedAs(client);
    const ask = screen.getByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(ask).getByRole('button', { name: 'Join this group' }));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(client.args('resumeGroup')).toEqual([OTHER_GROUP_ID, undefined]);
    expect(client.count('leaveGroup')).toBe(1);
    expect(client.args('joinByQr')).toEqual([TICKET, undefined]);
    expect(JSON.parse(storage.getItem(POINTER_KEY)!)).toMatchObject({ groupId: GROUP_ID });
  });
});

describe('joining from the library (#24 design F4, 6.10)', () => {
  async function library(withSync = true) {
    const client = new FakeSyncClient();
    renderApp({
      config: testConfig('library', 'on', withSync ? { sync: SYNC } : {}),
      location: { pathname: '/library' },
      storage: new MemoryStorage(),
      syncClient: client,
    });
    await screen.findByRole('heading', { level: 1 });
    return client;
  }

  async function joinFromLibrary(client: FakeSyncClient) {
    act(() => client.setConnection(connected()));
    fireEvent.click(screen.getByRole('button', { name: 'Join a group' }));
    const dialog = screen.getByRole('dialog', { name: 'Join a group' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Code' }), {
      target: { value: 'K7MQ9XPR' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
  }

  it('has no Join a group without sync', async () => {
    await library(false);
    expect(screen.queryByRole('button', { name: 'Join a group' })).toBeNull();
  });

  it("opens the group's bundled book by navigating, keeping the membership", async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    const client = await library();
    client.impl.joinByCode = () => joinedAs(client);
    await joinFromLibrary(client);
    expect(screen.getByRole('dialog', { name: "Opening the group's book…" })).toBeDefined();
    expect(client.count('close')).toBe(1);
    expect(assign).toHaveBeenCalledWith('/?book=samples%2Fpride-and-prejudice-en');
  });

  it('says the app does not have a book it cannot open, with Leave group', async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    const client = await library();
    const id = `<b>acme</b>/${'x'.repeat(60)}`;
    client.impl.joinByCode = () => joinedAs(client, { ...META, contentId: id });
    await joinFromLibrary(client);
    const dialog = screen.getByRole('dialog', { name: "This app doesn't have the group's book" });
    expect(assign).not.toHaveBeenCalled();
    expect(dialog.querySelector('b')).toBeNull();
    client.impl.leaveGroup = () => undefined;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(client.count('leaveGroup')).toBe(1);
  });
});

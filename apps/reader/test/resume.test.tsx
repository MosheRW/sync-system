import { type JsonObject, type ResumedGroup, SyncClientError } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { POINTER_KEY, testLoader } from './helpers/app.js';
import { FakeSyncClient, GROUP_ID, connected } from './helpers/fake-sync-client.js';
import { getNotice, renderGroupApp } from './helpers/group.js';
import { MemoryStorage } from './helpers/storage.js';

const BOOK_ID = 'samples/pride-and-prejudice-en';
const counter = () => screen.getByText(/^\d+ \/ \d+$/).textContent;

async function local() {
  const result = await testLoader().load({ kind: 'bundled', contentId: BOOK_ID });
  if (!result.ok) throw new Error('load');
  return { ...result.content.metadata };
}

async function reloadWith(options: {
  mode?: 'following' | 'browsing';
  page?: number;
  resume?: (client: FakeSyncClient, metadata: JsonObject) => unknown;
}) {
  const metadata = await local();
  const storage = new MemoryStorage();
  storage.setItem(
    POINTER_KEY,
    JSON.stringify({
      v: 1,
      groupId: GROUP_ID,
      mode: options.mode ?? 'following',
      ack: null,
      qrShown: false,
    }),
  );
  if (options.page !== undefined) {
    storage.setItem(
      `reader:v1:page:${BOOK_ID}:${metadata.fingerprint}`,
      JSON.stringify({ v: 1, pageIndex: options.page }),
    );
  }
  const client = new FakeSyncClient();
  if (options.resume) client.impl.resumeGroup = () => options.resume!(client, metadata);
  await renderGroupApp({ client, storage });
  return { client, storage, metadata };
}

async function connect(client: FakeSyncClient) {
  await act(async () => {
    client.setConnection(connected());
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

function resumedAs(role: 'member' | 'leader', pageIndex: number): ResumedGroup {
  return {
    groupId: GROUP_ID,
    role,
    participantId: 'p-self',
    status: 'active',
    recreated: false,
    leaderOnline: true,
    hasPosition: true,
    position: { v: 1, pageIndex },
  };
}

describe('resume after a reload (#24 AC34, AC36)', () => {
  it('shows Reconnecting… at once and resumes the stored group once connected', async () => {
    const { client } = await reloadWith({});
    expect(client.count('connect')).toBe(1);
    expect(screen.getByRole('button', { name: 'Reconnecting…, group options' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    await connect(client);
    expect(client.args('resumeGroup')).toEqual([GROUP_ID, undefined]);
  });

  it('a following member returns to the group page', async () => {
    const { client } = await reloadWith({
      page: 0,
      resume: (c, metadata) => {
        c.follow({ metadata, hasPosition: true, position: { v: 1, pageIndex: 2 } });
        return resumedAs('member', 2);
      },
    });
    await connect(client);
    expect(counter()).toMatch(/^3 \//);
    expect(screen.getByRole('button', { name: 'Following, group options' })).toBeDefined();
  });

  it('a browsing member returns to their own page with the jump prompt, no countdown (Q3)', async () => {
    const { client } = await reloadWith({
      mode: 'browsing',
      page: 1,
      resume: (c, metadata) => {
        c.follow({ metadata, hasPosition: true, position: { v: 1, pageIndex: 2 } });
        return resumedAs('member', 2);
      },
    });
    await connect(client);
    expect(counter()).toMatch(/^2 \//);
    const prompt = screen.getByRole('region', { name: 'Group page' });
    expect(prompt.textContent).toContain('The group is on page 3.');
    expect(prompt.textContent).not.toMatch(/Going there/);
  });

  it('a leader returns to the group page, leading, without codes being asked', async () => {
    const { client } = await reloadWith({
      page: 0,
      resume: (c) => {
        c.codes = { generation: 1, groupCode: '482913', doorCode: '205118' };
        c.lead({ hasPosition: true, position: { v: 1, pageIndex: 1 } });
        return resumedAs('leader', 1);
      },
    });
    await connect(client);
    expect(counter()).toMatch(/^2 \//);
    expect(screen.getByRole('button', { name: 'Leading, group options' })).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

describe('a stored group that is gone (#24 AC37)', () => {
  it.each([
    'TOKEN_NOT_FOUND',
    'TOKEN_INVALID',
    'TOKEN_EXPIRED',
    'GROUP_ENDED',
    'PARTICIPANT_BLOCKED',
    'GROUP_FULL',
  ] as const)('%s: forgotten with one notice, never retried', async (code) => {
    const { client, storage } = await reloadWith({
      resume: () => {
        throw new SyncClientError(code);
      },
    });
    await connect(client);
    expect(storage.getItem(POINTER_KEY)).toBeNull();
    // No token is left behind for a group this tab gave up on (security R5).
    expect(client.args('forgetGroup')).toEqual([GROUP_ID]);
    expect(client.storedTokens.has(GROUP_ID)).toBe(false);
    expect(getNotice('Your group has ended.')).toBeDefined();
    await connect(client);
    expect(client.count('resumeGroup')).toBe(1);
    expect(screen.getByRole('button', { name: 'Group, group options' })).toBeDefined();
  });

  it('retries a network failure at most 3 times, then offers Try again and Leave group', async () => {
    const { client, storage } = await reloadWith({
      resume: () => {
        throw new SyncClientError('REQUEST_TIMEOUT');
      },
    });
    await connect(client);
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(client.count('resumeGroup')).toBe(3);
    const button = screen.getByRole('button', { name: 'Not connected, group options' });
    fireEvent.click(button);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Try again' })).toBeDefined();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Leave group' }));
    expect(storage.getItem(POINTER_KEY)).toBeNull();
    expect(getNotice('You left the group.')).toBeDefined();
  });
});

describe('leaving and group end (#24 AC32, AC33)', () => {
  async function member() {
    const metadata = await local();
    const { client, storage } = await renderGroupApp();
    storage.setItem(
      POINTER_KEY,
      JSON.stringify({ v: 1, groupId: GROUP_ID, mode: 'following', ack: null, qrShown: false }),
    );
    act(() => client.follow({ metadata, hasPosition: true, position: { v: 1, pageIndex: 1 } }));
    return { client, storage };
  }

  it('a member leaves with no confirmation and keeps reading on the same page', async () => {
    const { client, storage } = await member();
    client.impl.leaveGroup = () => {
      client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'left' });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Following, group options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(getNotice('You left the group.')).toBeDefined();
    expect(storage.getItem(POINTER_KEY)).toBeNull();
    expect(counter()).toMatch(/^2 \//);
  });

  it('a failed leave says so in the sheet and keeps the group (design 7.5)', async () => {
    const { client, storage } = await member();
    client.impl.leaveGroup = () => {
      throw new SyncClientError('REQUEST_TIMEOUT');
    };
    fireEvent.click(screen.getByRole('button', { name: 'Following, group options' }));
    const sheet = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(within(sheet).getByRole('alert').textContent).toBe(
      "Couldn't leave the group. Try again.",
    );
    expect(storage.getItem(POINTER_KEY)).not.toBeNull();
    // Trying again clears the message; a success leaves.
    client.impl.leaveGroup = () => {
      client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'left' });
    };
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getNotice('You left the group.')).toBeDefined();
  });

  it.each([
    ['ended_by_leader', 'The leader ended the group. You can keep reading.'],
    ['max_session', 'The group reached its time limit and ended. You can keep reading.'],
    ['inactivity', 'The group ended after a long time with no activity. You can keep reading.'],
    [
      'leader_timeout',
      "The group ended because the leader didn't come back. You can keep reading.",
    ],
    ['removed', 'You were removed from the group.'],
    ['replaced', 'This group is open in another tab or device, so this tab left it.'],
    ['rejoin_failed', 'Your group has ended.'],
  ] as const)('%s: says why, forgets the pointer, the book stays', async (reason, text) => {
    const { client, storage } = await member();
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason }));
    const notices = screen.getAllByRole('status').filter((el) => el.textContent?.includes(text));
    expect(notices.length).toBeGreaterThan(0);
    expect(storage.getItem(POINTER_KEY)).toBeNull();
    expect(counter()).toMatch(/^2 \//);
    if (reason === 'removed') {
      expect(document.body.textContent).not.toMatch(/ended|limit|leader/i);
    }
  });

  it('closed: no notice, the pointer stays (a deliberate navigation)', async () => {
    const { client, storage } = await member();
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'closed' }));
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(storage.getItem(POINTER_KEY)).not.toBeNull();
  });

  it('Dismiss returns focus to the article', async () => {
    const { client } = await member();
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'ended_by_leader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(document.activeElement?.tagName).toBe('ARTICLE');
  });
});

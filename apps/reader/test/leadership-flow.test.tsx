import { type LeadershipReason, SyncClientError } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POINTER_KEY } from './helpers/app.js';
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

const at = (pageIndex: number) => ({ hasPosition: true, position: { v: 1, pageIndex } });
const counter = () => screen.getByText(/^\d+ \/ \d+$/).textContent;
const live = () => document.querySelector('[aria-live="polite"]')!.textContent;
const indicator = (state: string) =>
  screen.getByRole('button', { name: `${state}, group options` });
const takeBack = () => screen.queryByRole('region', { name: 'Take the lead back' });

async function member(extra = {}) {
  const client = new FakeSyncClient();
  client.codes = CODES;
  const metadata = await localMetadata();
  const view = await renderGroupApp({ client });
  act(() => client.follow({ metadata, ...at(0), ...extra }));
  return { client, metadata, view };
}

/** Like the core: the snapshot changes first, then the event. */
function becomeLeader(
  client: FakeSyncClient,
  reason: 'handoff_disconnect' | 'handoff_inactivity' | 'take_back',
  extra = {},
) {
  act(() => {
    client.patchGroup({ role: 'leader', takeBackAvailable: false, ...extra });
    client.emit('nowLeading', { groupId: GROUP_ID, reason });
  });
}

function loseLead(client: FakeSyncClient, reason: LeadershipReason, takeBackAvailable = false) {
  act(() => {
    client.patchGroup({ role: 'member', takeBackAvailable });
    client.emit('leadershipLost', { groupId: GROUP_ID, reason, takeBackAvailable });
  });
}

describe('"You\'re leading the group now" (#25 AC46, design F22, 6.8)', () => {
  it.each([
    ['handoff_disconnect', 'The leader lost connection, so the lead passed to you.'],
    ['handoff_inactivity', 'The leader was inactive for a long time, so the lead passed to you.'],
    ['take_back', 'You took the lead back.'],
  ] as const)(
    '%s: says why, takes focus on its heading, Start leading closes it',
    async (reason, line) => {
      const { client } = await member();
      becomeLeader(client, reason);
      const dialog = screen.getByRole('alertdialog', { name: "You're leading the group now" });
      expect(dialog.textContent).toContain(line);
      expect(dialog.textContent).toContain('Everyone follows your page now.');
      expect(dialog.textContent).not.toContain("You're on page");
      expect(document.activeElement).toBe(within(dialog).getByRole('heading'));
      expect(
        document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent,
      ).toContain(line);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start leading' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(indicator('Leading')).toBeDefined();
      expect(screen.getByRole('region', { name: 'Group codes' })).toBeDefined();
      expect(live()).not.toBe("You're leading the group.");
    },
  );

  it('Esc is Start leading; the full leader view is there after (panel, roster)', async () => {
    largeScreen();
    const { client } = await member();
    becomeLeader(client, 'handoff_disconnect');
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => client.setRoster([rosterEntry('p-self', { role: 'leader' })]));
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    expect(within(panel).getByRole('region', { name: 'People (1)' })).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Show QR code' })).toBeDefined();
  });

  it('off the group page: both pages in the dialog, nothing sent, then preview at the own page (U7)', async () => {
    const { client } = await member();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(counter()).toMatch(/^3 \//);
    becomeLeader(client, 'handoff_disconnect');
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain(
      "You're on page 3 and the group is on page 1. Your page turns won't move the group until you choose.",
    );
    expect([...dialog.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['3', '1']);
    expect(client.count('updatePosition')).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start leading' }));
    expect(client.args('previewStart')).toEqual([{ v: 1, pageIndex: 2 }]);
    expect(indicator('Previewing')).toBeDefined();
    expect(screen.getByRole('region', { name: 'Preview' }).textContent).toContain(
      "The group is on page 1. You're viewing page 3.",
    );
    expect(client.count('updatePosition')).toBe(0);
    expect(counter()).toMatch(/^3 \//);
  });

  it('a second nowLeading while open replaces the reason in place', async () => {
    const { client } = await member();
    becomeLeader(client, 'handoff_disconnect');
    act(() => client.emit('nowLeading', { groupId: GROUP_ID, reason: 'take_back' }));
    const dialogs = screen.getAllByRole('alertdialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.textContent).toContain('You took the lead back.');
  });

  it('adds the mismatch line for a member on another version of the book (U11)', async () => {
    const { client, metadata } = await member();
    act(() => client.patchGroup({ metadata: { ...metadata, fingerprint: 'f'.repeat(64) } }));
    expect(screen.getByRole('alertdialog')).toBeDefined(); // the version warning
    becomeLeader(client, 'handoff_disconnect');
    const dialogs = screen.getAllByRole('alertdialog');
    expect(dialogs.at(-1)!.textContent).toContain(
      "Your copy of the book isn't the same as the group's",
    );
  });
});

describe('lead lost (#25 AC47, design F20)', () => {
  async function leader(large = false) {
    if (large) largeScreen();
    const { client } = await member();
    becomeLeader(client, 'handoff_disconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    act(() => client.setRoster([rosterEntry('p-self', { role: 'leader' }), rosterEntry('a')]));
    return client;
  }

  it.each([
    ['handoff_disconnect', 'You were away too long, so someone else is leading now.'],
    ['handoff_inactivity', 'You were inactive too long, so someone else is leading now.'],
    ['take_back', 'The previous leader took the lead back.'],
    ['superseded', 'Someone else is leading this group now.'],
  ] as const)('%s: leader UI gone, sticky warning banner', async (reason, text) => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });
    const client = await leader(true);
    act(() => {
      client.emit('keepAlive', {
        groupId: GROUP_ID,
        countdownMs: 60_000,
        deadlineAt: Date.now() + 60_000,
      });
    });
    expect(screen.getByRole('region', { name: 'Keep the group going' })).toBeDefined();
    loseLead(client, reason);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('region', { name: /^People/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Keep the group going' })).toBeNull();
    const notice = getNotice(text);
    expect(notice.textContent).toContain('You can keep reading with the group.');
    expect(notice.className).toContain('noticeWarning');
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(getNotice(text)).toBeDefined();
    expect(indicator('Following')).toBeDefined();
  });

  it('focus inside a closed part goes to the banner Dismiss', async () => {
    const client = await leader(true);
    act(() => screen.getByRole('button', { name: 'Get new codes' }).focus());
    loseLead(client, 'superseded');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
  });

  it('open confirmations and the people view close', async () => {
    const client = await leader();
    fireEvent.click(screen.getByRole('button', { name: /^People: / }));
    expect(screen.getByRole('dialog', { name: 'People in the group' })).toBeDefined();
    loseLead(client, 'take_back');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a previewing leader stays on its page, Not following, prompted on the next move (U14)', async () => {
    const client = await leader();
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview pages' }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    loseLead(client, 'superseded');
    expect(counter()).toMatch(/^3 \//);
    expect(indicator('Not following')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
    act(() => client.patchGroup(at(1)));
    expect(counter()).toMatch(/^3 \//);
    expect(screen.getByRole('region', { name: 'Group page' }).textContent).toContain('page 2');
    expect(client.count('updatePosition')).toBe(0);
  });

  it('not previewing: follows the group as before', async () => {
    const client = await leader();
    loseLead(client, 'superseded');
    act(() => client.patchGroup(at(2)));
    expect(counter()).toMatch(/^3 \//);
  });

  it('lost while away (Q-A1): back as a member, the lostDisconnect banner and the take-back card', async () => {
    // As leader(), keeping the storage the app was given.
    const {
      client,
      view: { storage },
    } = await member();
    // The pointer a joined tab has (written on join, which the fake skips).
    storage.setItem(
      POINTER_KEY,
      JSON.stringify({ v: 1, groupId: GROUP_ID, mode: 'following', ack: null, qrShown: false }),
    );
    becomeLeader(client, 'handoff_disconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    act(() => client.setRoster([rosterEntry('p-self', { role: 'leader' }), rosterEntry('a')]));
    act(() => {
      client.patchGroup({ role: 'member', takeBackAvailable: false });
      client.emit('rejoined', {
        groupId: GROUP_ID,
        role: 'member',
        participantId: 'p-self',
        status: 'active',
        recreated: false,
        leaderOnline: true,
        hasPosition: true,
        position: { v: 1, pageIndex: 0 },
      });
    });
    expect(getNotice('You were away too long, so someone else is leading now.')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Group codes' })).toBeNull();
    act(() => {
      client.patchGroup({ takeBackAvailable: true });
      client.emit('takeBackOffered', { groupId: GROUP_ID });
    });
    expect(takeBack()).not.toBeNull();
    // The reader's own tab storage (the group pointer) never holds the codes
    // (#25 R16); the member token without recovery data is the core
    // client's part, covered in packages/client/test/client.rejoin.test.ts.
    expect(JSON.parse(storage.getItem(POINTER_KEY)!)).toMatchObject({ groupId: GROUP_ID });
    const stored = [...storage.items.values()].join();
    expect(stored).not.toContain(CODES.groupCode);
    expect(stored).not.toContain(CODES.doorCode);
  });
});

describe('take the lead back (#25 AC48, design F21)', () => {
  async function displaced(takeBackAvailable = true) {
    const { client } = await member();
    becomeLeader(client, 'handoff_disconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    loseLead(client, 'handoff_disconnect', takeBackAvailable);
    return client;
  }

  it('shows the card with the loss, announced, without taking focus', async () => {
    await displaced();
    const card = takeBack()!;
    expect(card.textContent).toContain('You led this group before. You can lead it again.');
    expect(card.contains(document.activeElement)).toBe(false);
  });

  it('shows the card from takeBackOffered too', async () => {
    const client = await displaced(false);
    expect(takeBack()).toBeNull();
    act(() => {
      client.patchGroup({ takeBackAvailable: true });
      client.emit('takeBackOffered', { groupId: GROUP_ID });
    });
    expect(takeBack()).not.toBeNull();
    expect(live()).toBe('You can take the lead back. Use Take the lead or Keep following.');
  });

  it('Take the lead -> takeBackLeadership -> the now-leading dialog for take_back', async () => {
    const client = await displaced();
    fireEvent.click(within(takeBack()!).getByRole('button', { name: 'Take the lead' }));
    expect(client.count('takeBackLeadership')).toBe(1);
    expect(within(takeBack()!).getByRole('button', { name: 'Taking the lead…' })).toBeDefined();
    expect(
      within(takeBack()!)
        .getByRole('button', { name: 'Keep following' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    await act(async () => {
      client.lastPending('takeBackLeadership').resolve(undefined);
      await Promise.resolve();
    });
    becomeLeader(client, 'take_back');
    expect(takeBack()).toBeNull();
    expect(screen.getByRole('alertdialog').textContent).toContain('You took the lead back.');
  });

  it('Keep following: not asked again for this offer, asked again after a later loss', async () => {
    const client = await displaced();
    fireEvent.click(within(takeBack()!).getByRole('button', { name: 'Keep following' }));
    expect(takeBack()).toBeNull();
    act(() => client.emit('takeBackOffered', { groupId: GROUP_ID }));
    expect(takeBack()).toBeNull();
    becomeLeader(client, 'handoff_disconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    loseLead(client, 'handoff_inactivity', true);
    expect(takeBack()).not.toBeNull();
  });

  it('closes silently when the offer is withdrawn (Gap 1) or the group ends', async () => {
    const client = await displaced();
    act(() => {
      client.patchGroup({ takeBackAvailable: false });
      client.emit('leaderChanged', { groupId: GROUP_ID, reason: 'superseded' });
    });
    expect(takeBack()).toBeNull();
    act(() => client.patchGroup({ takeBackAvailable: true }));
    expect(takeBack()).not.toBeNull();
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'ended_by_leader' }));
    expect(takeBack()).toBeNull();
  });

  it('NOT_ALLOWED closes the card with a sticky banner; RATE_LIMITED stays inline', async () => {
    const client = await displaced();
    fireEvent.click(within(takeBack()!).getByRole('button', { name: 'Take the lead' }));
    await act(async () => {
      client.lastPending('takeBackLeadership').reject(new SyncClientError('RATE_LIMITED'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(takeBack()!).getByRole('alert').textContent).toBe(
      'Too many tries. Wait a moment, then try again.',
    );
    fireEvent.click(within(takeBack()!).getByRole('button', { name: 'Take the lead' }));
    await act(async () => {
      client.lastPending('takeBackLeadership').reject(new SyncClientError('NOT_ALLOWED'));
      client.patchGroup({ takeBackAvailable: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(takeBack()).toBeNull();
    expect(getNotice("You can't take the lead back any more.").className).toContain(
      'noticeWarning',
    );
  });

  it('is above the jump prompt; the prompt comes back when it closes', async () => {
    const client = await displaced();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    act(() => client.patchGroup(at(2)));
    expect(takeBack()).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
    fireEvent.click(within(takeBack()!).getByRole('button', { name: 'Keep following' }));
    expect(screen.getByRole('region', { name: 'Group page' })).toBeDefined();
  });

  it('no card after a take_back loss (Q-A2, #32)', async () => {
    const { client } = await member();
    becomeLeader(client, 'handoff_disconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    loseLead(client, 'take_back', true);
    expect(takeBack()).toBeNull();
    expect(getNotice('The previous leader took the lead back.')).toBeDefined();
  });
});

describe('leader changed, seen by members (#25 AC49, design F23)', () => {
  it.each([
    ['handoff_disconnect', 'The leader lost connection, so someone else is leading now.'],
    ['handoff_inactivity', 'The leader was inactive, so someone else is leading now.'],
    ['take_back', 'The previous leader is leading again.'],
    ['superseded', "The group's leader changed."],
  ] as const)('%s: a polite info notice, no name, hidden after 15 s', async (reason, text) => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });
    const { client } = await member();
    act(() => client.emit('leaderChanged', { groupId: GROUP_ID, reason }));
    const notice = getNotice(text);
    expect(notice.className).not.toContain('noticeWarning');
    expect(live()).toBe(text);
    expect(document.activeElement).not.toBe(within(notice).getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(15_250);
    });
    expect(
      screen.queryAllByRole('status').filter((el) => !el.hasAttribute('aria-live')),
    ).toHaveLength(0);
  });

  it('the vice-leader gets it too', async () => {
    const { client } = await member();
    act(() => client.emit('viceChanged', { groupId: GROUP_ID, isVice: true }));
    act(() => client.emit('leaderChanged', { groupId: GROUP_ID, reason: 'superseded' }));
    expect(getNotice("The group's leader changed.")).toBeDefined();
  });
});

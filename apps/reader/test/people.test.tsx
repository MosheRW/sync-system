import type { RosterEntry } from '@mosherw/sync-system-react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSyncClient, connected } from './helpers/fake-sync-client.js';
import {
  CODES,
  largeScreen,
  renderGroupApp,
  resizableScreen,
  rosterEntry,
} from './helpers/group.js';

afterEach(() => vi.unstubAllGlobals());

const ME = rosterEntry('p-self', { role: 'leader', displayName: 'Dana' });
const ARABIC = 'ع'.repeat(32);

/** A leader with `roster`, after the group was created. */
async function leaderWith(roster: readonly RosterEntry[], uiLang: 'en' | 'he' = 'en') {
  const client = new FakeSyncClient();
  client.codes = CODES;
  await renderGroupApp({ client, uiLang });
  act(() => client.lead());
  act(() => client.setRoster(roster));
  return client;
}

const counter = () => screen.queryByRole('button', { name: /^People: / });
const peopleList = () => screen.getByRole('region', { name: /^People \(/ });

describe('the people counter (#25 AC38, design 6.1)', () => {
  it('shows "here" and "away" without the leader, and opens the People view', async () => {
    await leaderWith([
      ME,
      rosterEntry('a'),
      rosterEntry('b', { connected: false }),
      rosterEntry('c'),
    ]);
    const button = counter()!;
    expect(button.textContent).toBe('2 here, 1 away');
    expect(button.getAttribute('aria-label')).toBe('People: 2 here, 1 away. Show people');
    expect(button.querySelectorAll('bdi')).toHaveLength(2);
    fireEvent.click(button);
    const sheet = screen.getByRole('dialog', { name: 'People in the group' });
    expect(within(sheet).getByRole('region', { name: 'People (4)' })).toBeDefined();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Your group' })).toBeDefined();
  });

  it('words nobody away and nobody here', async () => {
    const client = await leaderWith([ME, rosterEntry('a')]);
    expect(counter()!.textContent).toBe('1 here');
    act(() => client.setRoster([ME]));
    expect(counter()!.textContent).toBe('Nobody here yet');
  });

  it('is not rendered before the first roster (loading)', async () => {
    await leaderWith([]);
    expect(counter()).toBeNull();
    expect(screen.getByRole('region', { name: 'Group codes' })).toBeDefined();
  });

  it('opens from the leader sheet too (Show people)', async () => {
    await leaderWith([ME, rosterEntry('a', { connected: false })]);
    fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
    const sheet = screen.getByRole('dialog', { name: 'Your group' });
    expect(sheet.textContent).toContain('0 here, 1 away');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show people' }));
    expect(screen.getByRole('dialog', { name: 'People in the group' })).toBeDefined();
  });

  it('a member and the vice-leader see no counter and no list', async () => {
    const { client } = await renderGroupApp();
    client.roster = [ME, rosterEntry('a')];
    act(() => client.follow({}, connected()));
    act(() => client.emit('viceChanged', { groupId: 'x', isVice: true }));
    expect(counter()).toBeNull();
    expect(screen.queryByRole('region', { name: /^People \(/ })).toBeNull();
  });
});

describe('the people list (#25 AC38, AC39, AC61, design 6.2)', () => {
  it('is the last section of the panel on large screens, own row first, rows in roster order', async () => {
    largeScreen();
    await leaderWith([
      rosterEntry('b', { displayName: 'Yossi', joinedAt: 900 }),
      ME,
      rosterEntry('g', {
        displayName: 'Guest 3',
        generated: true,
        guestNumber: 3,
        connected: false,
      }),
    ]);
    expect(counter()).toBeNull();
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    const list = within(panel).getByRole('region', { name: 'People (3)' });
    expect(panel.querySelector('section:last-of-type')).toBe(list);
    expect(list.textContent).toContain('1 here, 1 away');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Dana (you)Leader · Here',
      'YossiMember · Here',
      'Guest 3Member · Away · Auto name',
    ]);
  });

  it('marks a person admitted while the group was restoring, in the list only', async () => {
    largeScreen();
    await leaderWith([ME, rosterEntry('r', { admittedSinceRecovery: true })]);
    expect(screen.getByText('Joined while the group was restoring')).toBeDefined();
  });

  it('says loading before the first roster and stale while offline', async () => {
    largeScreen();
    const client = await leaderWith([]);
    expect(within(peopleList()).getByText('Loading the people in the group…')).toBeDefined();
    act(() => client.setRoster([ME]));
    expect(
      within(peopleList()).getByText(
        'Nobody else is here yet. Share the codes so people can join.',
      ),
    ).toBeDefined();
    act(() => client.setConnection({ status: 'reconnecting', attempt: 1 } as never));
    expect(
      within(peopleList()).getByText("Can't update the list while you're offline."),
    ).toBeDefined();
  });

  it('tells generated names from chosen look-alikes, in en and he (AC39)', async () => {
    largeScreen();
    await leaderWith(
      [
        ME,
        rosterEntry('g', { displayName: 'Guest 3', generated: true, guestNumber: 3 }),
        rosterEntry('c', { displayName: 'Guest 3' }),
        rosterEntry('u', { displayName: 'Guest 7', generated: true }),
      ],
      'he',
    );
    const rows = within(screen.getByRole('region', { name: 'משתתפים (4)' })).getAllByRole(
      'listitem',
    );
    expect(rows[1]!.textContent).toBe('אורח 3משתתף · כאן · שם אוטומטי');
    expect(rows[2]!.textContent).toBe('Guest 3משתתף · כאן');
    expect(rows[3]!.textContent).toBe('אורחמשתתף · כאן · שם אוטומטי');
  });

  it.each(['<b>x</b>', '‮evil', 'דנה (Dana)', ARABIC, '{n}'])(
    'renders %j as text in its own isolate (AC51, R15)',
    async (name) => {
      largeScreen();
      await leaderWith([ME, rosterEntry('pid-secret', { displayName: name })]);
      const list = peopleList();
      expect(list.querySelector('b')).toBeNull();
      const bdi = [...list.querySelectorAll('bdi')].find((el) => el.textContent === name)!;
      expect(bdi.getAttribute('dir')).toBe('auto');
      for (const el of list.querySelectorAll('*')) {
        for (const attr of ['aria-label', 'title', 'id']) {
          expect(el.getAttribute(attr) ?? '').not.toContain(name);
          expect(el.getAttribute(attr) ?? '').not.toContain('pid-secret');
        }
      }
    },
  );

  it('switches live across 1024 px and moves focus from the list to the counter', async () => {
    const resize = resizableScreen(true);
    await leaderWith([ME, rosterEntry('a')]);
    const heading = within(peopleList()).getByRole('heading', { name: 'People (2)' });
    act(() => heading.focus());
    resize(false);
    expect(screen.queryByRole('region', { name: /^People \(/ })).toBeNull();
    expect(document.activeElement).toBe(counter());
    resize(true);
    expect(counter()).toBeNull();
    expect(peopleList()).toBeDefined();
  });

  it('closes the People view when the user stops leading', async () => {
    const client = await leaderWith([ME, rosterEntry('a')]);
    fireEvent.click(counter()!);
    expect(screen.getByRole('dialog', { name: 'People in the group' })).toBeDefined();
    act(() => client.follow());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

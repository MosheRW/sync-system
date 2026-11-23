import { type RosterEntry, SyncClientError } from '@mosherw/sync-system-react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSyncClient, GROUP_ID } from './helpers/fake-sync-client.js';
import { CODES, renderGroupApp, rosterEntry } from './helpers/group.js';

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const ME = rosterEntry('p-self', { role: 'leader' });
const at = (pageIndex: number) => ({ hasPosition: true, position: { v: 1, pageIndex } });
const card = () => screen.queryByRole('region', { name: 'Keep the group going' });
const assertive = () => document.querySelector('[aria-live="assertive"]')!.textContent;
const polite = () => document.querySelector('[aria-live="polite"]')!.textContent;
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

async function leader(
  options: { handoff?: 'auto' | 'frozen'; roster?: readonly RosterEntry[] } = {},
) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] });
  const client = new FakeSyncClient();
  client.codes = CODES;
  client.leaderState = { blockList: [], locked: false, handoff: options.handoff ?? 'auto' };
  await renderGroupApp({ client });
  act(() => client.lead(at(0)));
  act(() => client.setRoster(options.roster ?? [ME]));
  return client;
}

function prompt(client: FakeSyncClient, countdownMs = 60_000) {
  act(() =>
    client.emit('keepAlive', {
      groupId: GROUP_ID,
      countdownMs,
      deadlineAt: Date.now() + countdownMs,
    }),
  );
}

describe('the keep-alive card (#25 AC45, AC53, design F19, 6.7)', () => {
  it('counts down from the server duration and is announced assertively once', async () => {
    const client = await leader();
    prompt(client);
    const region = card()!;
    expect(region.textContent).toContain('Still reading?');
    expect(region.textContent).toContain('The group pauses in 1:00 unless you keep it going.');
    expect(region.querySelector('bdi')!.getAttribute('dir')).toBe('ltr');
    expect(assertive()).toBe(
      'The group pauses in 1 minute. Turn a page or use Keep going to keep it going.',
    );
    expect(region.contains(document.activeElement)).toBe(false);
    advance(12_000);
    expect(card()!.textContent).toContain('The group pauses in 48 s unless');
    expect(assertive()).toBe(
      'The group pauses in 1 minute. Turn a page or use Keep going to keep it going.',
    );
  });

  it('closes silently when cleared by other activity (keepAliveCleared)', async () => {
    const client = await leader();
    prompt(client);
    const before = polite();
    act(() => client.emit('keepAliveCleared', { groupId: GROUP_ID }));
    expect(card()).toBeNull();
    expect(polite()).toBe(before);
  });

  it('Keep going answers; success announces and the cleared prompt closes the card', async () => {
    const client = await leader();
    prompt(client);
    fireEvent.click(within(card()!).getByRole('button', { name: 'Keep going' }));
    expect(client.count('answerKeepAlive')).toBe(1);
    expect(within(card()!).getByRole('button', { name: 'Keeping the group going…' })).toBeDefined();
    await act(async () => {
      client.lastPending('answerKeepAlive').resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => client.emit('keepAliveCleared', { groupId: GROUP_ID }));
    expect(card()).toBeNull();
    expect(polite()).toBe('The group keeps going.');
  });

  it('shows errors inline; the countdown keeps running', async () => {
    const client = await leader();
    prompt(client);
    fireEvent.click(within(card()!).getByRole('button', { name: 'Keep going' }));
    await act(async () => {
      client.lastPending('answerKeepAlive').reject(new SyncClientError('NOT_CONNECTED'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(within(card()!).getByRole('alert').textContent).toContain(
      "Can't reach the group service.",
    );
    advance(10_000);
    expect(card()!.textContent).toContain('50 s');
  });

  it.each([
    ['auto', [ME, rosterEntry('a')], 'Someone else will lead soon. Keep going to stay the leader.'],
    ['auto', [ME, rosterEntry('a', { connected: false })], 'The group waits for you.'],
    ['frozen', [ME, rosterEntry('a')], 'The group waits for you. Keep going to carry on.'],
  ] as const)('runs out to the paused state (%s)', async (handoff, roster, line) => {
    const client = await leader({ handoff, roster });
    prompt(client);
    advance(60_250);
    const region = card()!;
    expect(region.textContent).toContain('The group is paused');
    expect(region.textContent).toContain(line);
    expect(region.querySelector('[aria-hidden="true"] > div')).toBeNull();
    expect(assertive()).toBe('The group is paused. Use Keep going to carry on.');
    fireEvent.click(within(region).getByRole('button', { name: 'Keep going' }));
    expect(client.count('answerKeepAlive')).toBe(1);
  });

  it('is right after a clock jump while the tab was hidden (AC53)', async () => {
    const client = await leader();
    prompt(client);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      vi.setSystemTime(Date.now() + 40_000);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(card()!.textContent).toContain('The group pauses in 20 s');
  });

  it('a page turn is leader activity: no stray position for the card itself', async () => {
    const client = await leader();
    prompt(client);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(client.count('updatePosition')).toBe(1);
    expect(card()).not.toBeNull();
  });

  it('last chance: "ends" wording after a handoff for inactivity, gone after any activity', async () => {
    const client = await leader();
    act(() => client.emit('nowLeading', { groupId: GROUP_ID, reason: 'handoff_inactivity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start leading' }));
    prompt(client);
    expect(card()!.textContent).toContain('The group ends in 1:00 unless you keep it going.');
    expect(assertive()).toBe(
      'The group ends in 1 minute. Turn a page or use Keep going to keep it going.',
    );
    advance(61_000);
    expect(card()!.textContent).not.toContain('The group is paused');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(card()!.textContent).toContain('The group is paused');
  });

  it('goes with the lead', async () => {
    const client = await leader();
    prompt(client);
    act(() => client.follow(at(0)));
    expect(card()).toBeNull();
  });
});

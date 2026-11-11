import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSyncClient, GROUP_ID } from './helpers/fake-sync-client.js';
import { CODES, largeScreen, renderGroupApp } from './helpers/group.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (pageIndex: number) => ({ hasPosition: true, position: { v: 1, pageIndex } });
const counter = () => screen.getByText(/^\S+ \/ \S+$/).textContent;
const live = () => document.querySelector('[aria-live="polite"]')!.textContent;
const next = () => fireEvent.keyDown(document, { key: 'ArrowRight' });
const banner = () => screen.queryByRole('region', { name: /^(Preview|תצוגה מקדימה)$/ });

async function leader(options: { uiLang?: 'en' | 'he'; search?: string; large?: boolean } = {}) {
  if (options.large === true) largeScreen();
  const client = new FakeSyncClient();
  client.codes = CODES;
  await renderGroupApp({
    client,
    uiLang: options.uiLang ?? 'en',
    ...(options.search !== undefined ? { location: { search: options.search } } : {}),
  });
  act(() => client.lead(at(0)));
  return client;
}

function startFromSheet() {
  fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
  const sheet = screen.getByRole('dialog', { name: 'Your group' });
  const start = within(sheet).getByRole('button', { name: 'Preview pages' });
  expect(document.getElementById(start.getAttribute('aria-describedby')!)!.textContent).toBe(
    'Turn pages without moving the group.',
  );
  fireEvent.click(start);
}

describe('leader preview (#25 AC40, design F15, 6.4)', () => {
  it('starts from the sheet: the sheet closes, Previewing, the same-page banner, announced', async () => {
    await leader();
    startFromSheet();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previewing, group options' })).toBeDefined();
    expect(banner()!.textContent).toContain(
      'Preview is on. Turn pages; the group stays on page 1.',
    );
    expect(within(banner()!).queryByRole('button', { name: 'Bring group here' })).toBeNull();
    expect(live()).toBe('Preview on. The group stays on page 1.');
  });

  it('shows both pages, isolated, after a turn; Return to group in the panel too', async () => {
    await leader({ large: true });
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview pages' }));
    next();
    next();
    const region = banner()!;
    expect(region.textContent).toContain("The group is on page 1. You're viewing page 3.");
    expect([...region.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['1', '3']);
    expect(within(region).getByRole('button', { name: 'Bring group here' })).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Return to group' })).toBeDefined();
    expect(within(panel).queryByRole('button', { name: 'Preview pages' })).toBeNull();
  });

  it('in Hebrew with an RTL book', async () => {
    await leader({ uiLang: 'he', search: '?book=samples%2Fpsalms-he' });
    fireEvent.click(screen.getByRole('button', { name: /אפשרויות קבוצה$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'תצוגה מקדימה של עמודים' }));
    expect(screen.getByRole('button', { name: /^תצוגה מקדימה, / })).toBeDefined();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(banner()!.textContent).toContain('הקבוצה בעמוד 1. מוצג לך עמוד 2.');
  });

  it('Return to group goes back to the group page and sends nothing', async () => {
    const client = await leader();
    startFromSheet();
    next();
    next();
    expect(counter()).toMatch(/^3 \//);
    fireEvent.click(within(banner()!).getByRole('button', { name: 'Return to group' }));
    expect(counter()).toMatch(/^1 \//);
    expect(banner()).toBeNull();
    expect(screen.getByRole('button', { name: 'Leading, group options' })).toBeDefined();
    expect(client.count('updatePosition')).toBe(0);
    expect(client.count('returnToGroup')).toBe(1);
    expect(document.activeElement?.id).toBe('reader-article');
  });

  it('banner gone on demotion and on group end', async () => {
    const client = await leader();
    startFromSheet();
    act(() => client.follow(at(0)));
    expect(banner()).toBeNull();
    act(() => client.lead(at(0)));
    startFromSheet();
    act(() => client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'ended_by_leader' }));
    expect(banner()).toBeNull();
  });
});

describe('preview never moves the group (#25 AC41, R21)', () => {
  it('no position update while previewing, one on Bring group here, none on Return', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const client = await leader();
    startFromSheet();
    next();
    next();
    expect(client.count('updatePosition')).toBe(0);
    expect(client.previewMoves).toEqual([
      { v: 1, pageIndex: 1 },
      { v: 1, pageIndex: 2 },
    ]);
    // A group message right after a page turn yields to "Page n of N" (8a 9).
    vi.setSystemTime(Date.now() + 1000);
    fireEvent.click(within(banner()!).getByRole('button', { name: 'Bring group here' }));
    expect(client.count('updatePosition')).toBe(1);
    expect(client.args('updatePosition')).toEqual([{ v: 1, pageIndex: 2 }]);
    expect(banner()).toBeNull();
    expect(counter()).toMatch(/^3 \//);
    expect(live()).toBe('The group moved to page 3.');
    expect(screen.getByRole('button', { name: 'Leading, group options' })).toBeDefined();
    // A real move after the preview is sent.
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(client.count('updatePosition')).toBe(2);
  });

  it('a turn in the same tick as start is a preview move (L3)', async () => {
    const client = await leader({ large: true });
    const panel = screen.getByRole('complementary', { name: 'Your group' });
    act(() => {
      within(panel).getByRole('button', { name: 'Preview pages' }).click();
      next();
    });
    expect(client.count('updatePosition')).toBe(0);
    expect(client.previewMoves).toHaveLength(1);
  });

  it('Bring group here offline: the preview stays on, the error shows in the banner', async () => {
    const client = await leader();
    startFromSheet();
    next();
    act(() => client.setConnection({ status: 'reconnecting', attempt: 1 } as never));
    fireEvent.click(within(banner()!).getByRole('button', { name: 'Bring group here' }));
    expect(client.count('updatePosition')).toBe(0);
    expect(within(banner()!).getByRole('alert').textContent).toBe(
      "Can't reach the group service. Check your connection, then try again.",
    );
  });

  it('a failed send restarts the preview at the same page', async () => {
    const client = await leader();
    startFromSheet();
    next();
    client.updatePosition = () => {
      throw new Error('send failed');
    };
    fireEvent.click(within(banner()!).getByRole('button', { name: 'Bring group here' }));
    expect(banner()!.textContent).toContain("You're viewing page 2.");
    expect(within(banner()!).getByRole('alert')).toBeDefined();
    expect(counter()).toMatch(/^2 \//);
  });
});

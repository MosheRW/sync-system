import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POINTER_KEY, testLoader } from './helpers/app.js';
import { FakeSyncClient, GROUP_ID, connected } from './helpers/fake-sync-client.js';
import { renderGroupApp } from './helpers/group.js';
import type { MemoryStorage } from './helpers/storage.js';

afterEach(() => vi.useRealTimers());

async function local() {
  const result = await testLoader().load({
    kind: 'bundled',
    contentId: 'samples/pride-and-prejudice-en',
  });
  if (!result.ok) throw new Error('load');
  return { ...result.content.metadata };
}

const at = (pageIndex: number) => ({ hasPosition: true, position: { v: 1, pageIndex } });
const counter = () => screen.getByText(/^\d+ \/ \d+$/).textContent;

async function joinAsMember(options: { turnFirst?: number; storage?: MemoryStorage } = {}) {
  const metadata = await local();
  const { client, storage } = await renderGroupApp(
    options.storage ? { storage: options.storage } : {},
  );
  for (let i = 0; i < (options.turnFirst ?? 0); i += 1) {
    fireEvent.keyDown(document, { key: 'ArrowRight' });
  }
  storage.setItem(
    POINTER_KEY,
    JSON.stringify({ v: 1, groupId: GROUP_ID, mode: 'following', ack: null, qrShown: false }),
  );
  return { client, storage, metadata };
}

describe('following the leader (#24 AC25-AC31)', () => {
  it('a fresh joiner jumps straight to the group page, then moves with the leader (U1, AC25)', async () => {
    const { client, metadata } = await joinAsMember();
    act(() => client.follow({ metadata, ...at(2) }));
    expect(counter()).toMatch(/^3 \//);
    expect(screen.getByRole('button', { name: 'Following, group options' })).toBeDefined();
    act(() => client.patchGroup(at(1)));
    expect(counter()).toMatch(/^2 \//);
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
  });

  it('a browsing member is told, gets one prompt with the latest page, and is never moved (AC26, AC31)', async () => {
    const { client, metadata, storage } = await joinAsMember();
    act(() => client.follow({ metadata, ...at(0) }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Not following, group options' })).toBeDefined();
    expect(JSON.parse(storage.getItem(POINTER_KEY)!)).toMatchObject({ mode: 'browsing' });
    act(() => client.patchGroup(at(0)));
    act(() => client.patchGroup(at(2)));
    expect(counter()).toMatch(/^2 \//);
    const prompts = screen.getAllByRole('region', { name: 'Group page' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.textContent).toContain('The group is on page 3.');
    expect(document.activeElement).not.toBe(within(prompts[0]!).getAllByRole('button')[0]);
    fireEvent.click(within(prompts[0]!).getByRole('button', { name: 'Go to page 3' }));
    expect(counter()).toMatch(/^3 \//);
    expect(screen.getByRole('button', { name: 'Following, group options' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
  });

  it('Stay here hides the prompt until the next move', async () => {
    const { client, metadata } = await joinAsMember();
    act(() => client.follow({ metadata, ...at(0) }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    act(() => client.patchGroup(at(2)));
    fireEvent.click(screen.getByRole('button', { name: 'Stay here' }));
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
    act(() => client.patchGroup(at(0)));
    expect(screen.getByRole('region', { name: 'Group page' }).textContent).toContain('page 1');
  });

  it.each([
    ['a wrong version', { v: 2, pageIndex: 3 }],
    ['an extra key', { v: 1, pageIndex: 3, x: 1 }],
    ['a page past the end', { v: 1, pageIndex: 9999 }],
    ['a string', 'page 3'],
  ])('ignores %s without moving, prompting or failing (AC29)', async (_name, position) => {
    const { client, metadata } = await joinAsMember();
    act(() => client.follow({ metadata, ...at(1) }));
    act(() => client.patchGroup({ hasPosition: true, position }));
    expect(counter()).toMatch(/^2 \//);
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
  });

  it('a leader preview never reaches members (AC27)', async () => {
    const { client, metadata } = await joinAsMember();
    act(() => client.follow({ metadata, ...at(1) }));
    act(() => {
      client.preview.start({ v: 1, pageIndex: 7 });
      client.preview.move({ v: 1, pageIndex: 8 });
    });
    expect(counter()).toMatch(/^2 \//);
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
  });
});

describe('the late-joiner countdown (#24 AC28, AC53)', () => {
  it('counts 10 s from config, then jumps; a leader move updates the page only', async () => {
    const { client, metadata } = await joinAsMember({ turnFirst: 1 });
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval', 'Date'] });
    act(() => client.follow({ metadata, ...at(2) }));
    const prompt = screen.getByRole('region', { name: 'Group page' });
    expect(prompt.textContent).toContain('Going there in 10 s.');
    expect(counter()).toMatch(/^2 \//);
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    act(() => client.patchGroup(at(0)));
    expect(screen.getByRole('region', { name: 'Group page' }).textContent).toContain('page 1');
    expect(screen.getByRole('region', { name: 'Group page' }).textContent).toContain('6 s');
    act(() => {
      vi.advanceTimersByTime(6_500);
    });
    expect(counter()).toMatch(/^1 \//);
    expect(screen.queryByRole('region', { name: 'Group page' })).toBeNull();
  });

  it('Go now, Stay here and a page turn end it', async () => {
    const { client, metadata } = await joinAsMember({ turnFirst: 1 });
    act(() => client.follow({ metadata, ...at(2) }));
    fireEvent.click(screen.getByRole('button', { name: 'Go now' }));
    expect(counter()).toMatch(/^3 \//);
  });
});

describe('the leader sends the page (#24 AC6, AC25)', () => {
  it('sends position v1 on every turn', async () => {
    const client = new FakeSyncClient();
    await renderGroupApp({ client });
    act(() => client.lead({}, connected()));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(client.calls.get('updatePosition')).toEqual([
      [{ v: 1, pageIndex: 1 }],
      [{ v: 1, pageIndex: 2 }],
    ]);
  });
});

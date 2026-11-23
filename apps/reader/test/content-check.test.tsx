import { SyncClientError } from '@mosherw/sync-system-react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/group/browser.js';
import {
  POINTER_KEY,
  readingReady,
  renderApp,
  SYNC,
  testConfig,
  testLoader,
} from './helpers/app.js';
import { FakeSyncClient, GROUP_ID } from './helpers/fake-sync-client.js';
import { MemoryStorage } from './helpers/storage.js';

const ID = 'samples/pride-and-prejudice-en';

afterEach(() => vi.restoreAllMocks());

async function localMetadata() {
  const result = await testLoader().load({ kind: 'bundled', contentId: ID });
  if (!result.ok) throw new Error('load');
  return { ...result.content.metadata };
}

async function member(
  metadata: unknown,
  options: { storage?: MemoryStorage; entry?: 'library' | 'single-book' } = {},
) {
  const client = new FakeSyncClient();
  const storage = options.storage ?? new MemoryStorage();
  storage.setItem(
    POINTER_KEY,
    storage.getItem(POINTER_KEY) ??
      JSON.stringify({ v: 1, groupId: GROUP_ID, mode: 'following', ack: null, qrShown: false }),
  );
  const view = renderApp({
    config: testConfig(options.entry ?? 'library', options.entry === 'single-book' ? 'off' : 'on', {
      sync: SYNC,
      ...(options.entry === 'single-book' ? { book: ID } : {}),
    }),
    location: { search: `?book=${encodeURIComponent(ID)}` },
    storage,
    syncClient: client,
  });
  await readingReady();
  act(() => client.follow({ metadata: metadata as Record<string, never> }));
  return { client, storage, view };
}

describe('content check before following (#24 AC21-AC24)', () => {
  it('match: follows', async () => {
    await member(await localMetadata());
    expect(screen.getByRole('button', { name: 'Following, group options' })).toBeDefined();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('different book: blocks with the leader ID, no header or page navigation', async () => {
    const meta = { ...(await localMetadata()), contentId: 'samples/psalms-he' };
    await member(meta);
    expect(
      screen.getByRole('heading', { name: 'This group is reading a different book' }),
    ).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    const id = document.querySelector('details bdi')!;
    expect(id.textContent).toBe('samples/psalms-he');
    expect(id.getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: "Open the group's book" })).toBeDefined();
  });

  it("Open the group's book navigates to the local book and keeps the pointer", async () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    const meta = { ...(await localMetadata()), contentId: 'samples/psalms-he' };
    const { client, storage } = await member(meta);
    fireEvent.click(screen.getByRole('button', { name: "Open the group's book" }));
    expect(client.count('close')).toBe(1);
    expect(assign).toHaveBeenCalledWith('/?book=samples%2Fpsalms-he');
    expect(storage.getItem(POINTER_KEY)).not.toBeNull();
  });

  it('offers no Open for an unbundled book, and truncates its ID to 40', async () => {
    const meta = { ...(await localMetadata()), contentId: `acme/${'x'.repeat(60)}` };
    await member(meta);
    expect(screen.queryByRole('button', { name: "Open the group's book" })).toBeNull();
    expect(screen.getByText(/Leave the group to keep reading on your own/)).toBeDefined();
    expect(Array.from(document.querySelector('details bdi')!.textContent)).toHaveLength(41);
  });

  it('offers no Open in single-book mode', async () => {
    const meta = { ...(await localMetadata()), contentId: 'samples/psalms-he' };
    await member(meta, { entry: 'single-book' });
    expect(screen.queryByRole('button', { name: "Open the group's book" })).toBeNull();
  });

  it('unsupported schema shows its version; malformed metadata says so, as text', async () => {
    const first = await member({ ...(await localMetadata()), schemaVersion: 2 });
    expect(screen.getByRole('heading', { name: "This app can't follow this group" })).toBeDefined();
    expect(document.querySelector('details')!.textContent).toContain(
      "Group's schema version 2. This app reads version 1.",
    );
    first.view.unmount();
    await member({ contentId: '<script>alert(1)</script>/x', fingerprint: 'x', schemaVersion: 1 });
    expect(document.querySelector('details')!.textContent).toContain(
      "The group sent book details this app can't read.",
    );
    expect(document.querySelector('script')).toBeNull();
  });

  it('Leave group leaves and forgets the pointer', async () => {
    const { client, storage } = await member({
      ...(await localMetadata()),
      contentId: 'samples/psalms-he',
    });
    client.impl.leaveGroup = () => {
      client.setGroup({ status: 'ended', groupId: GROUP_ID, reason: 'left' });
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(client.count('leaveGroup')).toBe(1);
    expect(storage.getItem(POINTER_KEY)).toBeNull();
    expect(screen.getByRole('navigation')).toBeDefined();
  });

  it('a failed Leave group on the block screen says so (design 7.5)', async () => {
    const { client, storage } = await member({
      ...(await localMetadata()),
      contentId: 'samples/psalms-he',
    });
    client.impl.leaveGroup = () => {
      throw new SyncClientError('REQUEST_TIMEOUT');
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toBe("Couldn't leave the group. Try again.");
    expect(storage.getItem(POINTER_KEY)).not.toBeNull();
    expect(
      screen.getByRole('heading', { name: 'This group is reading a different book' }),
    ).toBeDefined();
  });

  it('a failed Leave group in the version warning says so (design 7.5)', async () => {
    const meta = { ...(await localMetadata()), fingerprint: 'f'.repeat(64) };
    const { client } = await member(meta);
    client.impl.leaveGroup = () => {
      throw new SyncClientError('REQUEST_TIMEOUT');
    };
    const dialog = screen.getByRole('alertdialog', { name: 'Your copy is a different version' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
      await Promise.resolve();
    });
    expect(within(dialog).getByRole('alert').textContent).toBe(
      "Couldn't leave the group. Try again.",
    );
  });

  it('different version: a warning that needs an answer; Follow anyway is remembered', async () => {
    const meta = { ...(await localMetadata()), fingerprint: 'f'.repeat(64) };
    const { storage, view } = await member(meta);
    const dialog = screen.getByRole('alertdialog', { name: 'Your copy is a different version' });
    expect(document.activeElement).toBe(within(dialog).getByRole('heading'));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Not following, group options' })).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Follow anyway' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((JSON.parse(storage.getItem(POINTER_KEY)!) as { ack: string }).ack).toBe('f'.repeat(64));
    // A reload of the tab: not asked again for the same leader text.
    view.unmount();
    await member(meta, { storage });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

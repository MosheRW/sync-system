import type { JoinCodes, JoinMethod, RosterEntry } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { SYNC, readingReady, renderApp, testConfig, testLoader } from './app.js';
import { FakeSyncClient, GROUP_ID, connected } from './fake-sync-client.js';
import { MemoryStorage } from './storage.js';

export const PRIDE = { search: '?book=samples%2Fpride-and-prejudice-en' };

export const CODES: JoinCodes = Object.freeze({
  generation: 1,
  groupCode: '482913',
  doorCode: '205118',
});

/** Renders a reading page with sync on and a scripted client. */
export async function renderGroupApp(
  options: {
    client?: FakeSyncClient;
    storage?: MemoryStorage;
    location?: { search?: string; pathname?: string };
    uiLang?: 'en' | 'he';
    config?: Parameters<typeof testConfig>[2];
    entry?: Parameters<typeof testConfig>[0];
  } = {},
) {
  const client = options.client ?? new FakeSyncClient();
  const storage = options.storage ?? new MemoryStorage();
  const view = renderApp({
    config: testConfig(options.entry ?? 'library', 'on', { sync: SYNC, ...options.config }),
    location: options.location ?? PRIDE,
    storage,
    syncClient: client,
    uiLang: options.uiLang ?? 'en',
  });
  await readingReady();
  return { client, storage, view };
}

/** The leader path: connected, Start a group, Start group, with `codes`. */
export async function createAsLeader(
  client: FakeSyncClient,
  methods: readonly JoinMethod[] = ['A', 'D'],
  codes: JoinCodes = CODES,
) {
  client.impl.createGroup = () => {
    client.codes = codes;
    client.lead();
    return {
      groupId: GROUP_ID,
      role: 'leader',
      participantId: 'p-self',
      joinMethods: methods,
      codes,
    };
  };
  act(() => client.setConnection(connected()));
  fireEvent.click(screen.getByRole('button', { name: /group options$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Start a group' }));
  const dialog = screen.getByRole('dialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start group' }));
    await Promise.resolve();
  });
  await screen.findByRole('dialog', { name: 'Your group is ready' });
}

/**
 * The visible notice bar that says `text`. The shared live region may repeat
 * the same words (it drops a group message only right after a page turn), so
 * a plain `getByText` can find two elements.
 */
export function getNotice(text: string): HTMLElement {
  const notices = screen
    .getAllByRole('status')
    .filter((el) => !el.hasAttribute('aria-live') && el.textContent?.includes(text));
  if (notices.length !== 1)
    throw new Error(`expected one notice "${text}", found ${notices.length}`);
  return notices[0]!;
}

/** Stubs `matchMedia` so `(min-width: 1024px)` matches. */
export function largeScreen(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('1024'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** A `matchMedia` stub whose `(min-width: 1024px)` can be flipped live (resize). */
export function resizableScreen(large: boolean): (next: boolean) => void {
  let matches = large;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('1024') ? matches : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return (next: boolean) => {
    matches = next;
    act(() => {
      for (const listener of [...listeners]) listener();
    });
  };
}

/** A roster entry for tests (#25). */
export function rosterEntry(participantId: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return Object.freeze({
    participantId,
    displayName: participantId,
    generated: false,
    role: 'member' as const,
    connected: true,
    joinedAt: 0,
    ...extra,
  });
}

/** The bundled test book's own metadata: a member with it passes the content check. */
export async function localMetadata() {
  const result = await testLoader().load({
    kind: 'bundled',
    contentId: 'samples/pride-and-prejudice-en',
  });
  if (!result.ok) throw new Error('load');
  return { ...result.content.metadata };
}

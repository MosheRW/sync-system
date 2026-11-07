import type { JoinCodes, JoinMethod } from '@sync-system/react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { SYNC, readingReady, renderApp, testConfig } from './app.js';
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

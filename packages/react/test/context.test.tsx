import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncStore } from '../src/context.js';
import * as api from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every public hook: name -> a call with valid arguments. Extended with each chunk. */
const PUBLIC_HOOKS: Record<string, () => unknown> = {
  useSyncSnapshot: () => api.useSyncSnapshot(),
  useSyncSelector: () => api.useSyncSelector((s) => s.connection),
  useConnection: () => api.useConnection(),
  useSyncIndicator: () => api.useSyncIndicator(),
  useUpdateRequired: () => api.useUpdateRequired(),
  useSyncClient: () => api.useSyncClient(),
};

function Call({ use }: { use: () => unknown }): ReactNode {
  use();
  return null;
}

describe('hooks outside the provider (AC8)', () => {
  it('useSyncStore throws a fixed message naming the hook and SyncProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Call use={() => useSyncStore('useSomething')} />)).toThrow(
      'useSomething must be used inside <SyncProvider> (@sync-system/react)',
    );
  });

  it('every public hook throws an error naming itself and SyncProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exported = Object.keys(api).filter((name) => /^use[A-Z]/.test(name));
    expect(Object.keys(PUBLIC_HOOKS).sort()).toEqual(exported.sort());
    for (const [name, use] of Object.entries(PUBLIC_HOOKS)) {
      expect(() => render(<Call use={use} />), name).toThrow(
        `${name} must be used inside <SyncProvider> (@sync-system/react)`,
      );
    }
  });
});

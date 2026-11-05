import type { SyncClientOptions } from '@sync-system/client';
import { type RenderResult, render } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { SyncProvider } from '../../src/provider.js';
import type { SyncClientLike } from '../../src/types.js';

export interface ProviderSetup {
  client?: SyncClientLike;
  options?: SyncClientOptions;
  autoConnect?: boolean;
  /** Wrap in <StrictMode> (default true, section 11). */
  strict?: boolean;
}

/** The provider element for `setup` around `ui`. */
export function providerTree(ui: ReactNode, setup: ProviderSetup): ReactNode {
  const { client, options, autoConnect, strict = true } = setup;
  const extra = autoConnect === undefined ? {} : { autoConnect };
  const tree =
    client !== undefined ? (
      <SyncProvider client={client} {...extra}>
        {ui}
      </SyncProvider>
    ) : (
      <SyncProvider options={options!} {...extra}>
        {ui}
      </SyncProvider>
    );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

/** Renders `ui` inside a provider, in StrictMode unless `strict: false`. */
export function renderWithProvider(
  ui: ReactNode,
  setup: ProviderSetup,
): RenderResult & { rerenderWith(next: ReactNode, nextSetup?: ProviderSetup): void } {
  const result = render(providerTree(ui, setup));
  return Object.assign(result, {
    rerenderWith(next: ReactNode, nextSetup: ProviderSetup = setup) {
      result.rerender(providerTree(next, nextSetup));
    },
  });
}

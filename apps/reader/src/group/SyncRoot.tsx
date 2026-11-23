import {
  SyncProvider,
  type SyncClientLike,
  type SyncClientOptions,
  useUpdateRequired,
} from '@mosherw/sync-system-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { UpdateScreen } from '../components/group/UpdateScreens.js';
import type { SyncConfig } from '../config/schema.js';
import { type GroupEnv, GroupEnvContext, useGroupEnv } from './context.js';
import { type PastedLinkSignal, createPastedLinkSignal } from './pasted-link.js';
import type { QrLanding } from './deep-link.js';
import { type StorageLike, createPointerStore } from './session-store.js';

export interface SyncRootProps {
  sync: SyncConfig;
  /** This tab's guarded `sessionStorage` (ADR 0009); `null`: tokens in memory only. */
  storage: StorageLike | null;
  landing: QrLanding | null;
  /** Pasted QR links that were not used (#25 AC57). */
  pastedLinks?: PastedLinkSignal;
  libraryOn: boolean;
  singleBook: boolean;
  bundledIds: readonly string[];
  srcOrigins: readonly string[];
  /** Tests pass a scripted client; the app lets the provider own one. */
  client?: SyncClientLike;
  children: ReactNode;
}

/** The sync server's `host` (URL already checked), for the pointer key. */
function hostOf(url: string): string {
  return new URL(url).host;
}

/**
 * Update required or protocol refused (AC4): a full status screen instead
 * of the routes, until the user picks **Read without a group**.
 */
function UpdateGate({ children }: { children: ReactNode }) {
  const env = useGroupEnv();
  const update = useUpdateRequired();
  if (update !== null && env !== null && !env.groupsDisabled) {
    return <UpdateScreen update={update} onReadWithoutGroup={env.disableGroups} />;
  }
  return <>{children}</>;
}

/**
 * One sync client per page load for every route (react README: one owned
 * provider per app), created only when sync is configured. It connects at
 * load only when this tab has a group pointer or arrived with a QR ticket;
 * otherwise on the first Start or Join (design F0.3), so a solo reader never
 * connects. No logger (AC54); tokens in this tab's `sessionStorage` (ADR 0009).
 */
export function SyncRoot({
  sync,
  storage,
  landing,
  pastedLinks: givenPastedLinks,
  libraryOn,
  singleBook,
  bundledIds,
  srcOrigins,
  client,
  children,
}: SyncRootProps) {
  const [ownPastedLinks] = useState(createPastedLinkSignal);
  const pastedLinks = givenPastedLinks ?? ownPastedLinks;
  const pointers = useMemo(
    () => createPointerStore(storage, hostOf(sync.url)),
    [storage, sync.url],
  );
  // Decided once per page load (the provider reads autoConnect from idle only).
  const [autoConnect] = useState(() => pointers.read() !== null || landing?.kind === 'ticket');
  const [options] = useState<SyncClientOptions>(() => ({
    url: sync.url,
    apiKey: sync.apiKey,
    appVersion: sync.appVersion,
    storage: storage ?? 'memory',
  }));
  const [groupsDisabled, setGroupsDisabled] = useState(false);
  const disableGroups = useCallback(() => setGroupsDisabled(true), []);

  const env = useMemo<GroupEnv>(
    () => ({
      sync,
      pointers,
      landing,
      pastedLinks,
      groupsDisabled,
      disableGroups,
      libraryOn,
      singleBook,
      bundledIds,
      srcOrigins,
    }),
    [
      sync,
      pointers,
      landing,
      pastedLinks,
      groupsDisabled,
      disableGroups,
      libraryOn,
      singleBook,
      bundledIds,
      srcOrigins,
    ],
  );

  const gated = <UpdateGate>{children}</UpdateGate>;
  return (
    <GroupEnvContext.Provider value={env}>
      {client !== undefined ? (
        <SyncProvider client={client} autoConnect={autoConnect}>
          {gated}
        </SyncProvider>
      ) : (
        <SyncProvider options={options} autoConnect={autoConnect}>
          {gated}
        </SyncProvider>
      )}
    </GroupEnvContext.Provider>
  );
}

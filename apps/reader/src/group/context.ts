import { createContext, useContext } from 'react';
import type { SyncConfig } from '../config/schema.js';
import type { QrLanding } from './deep-link.js';
import type { PointerStore } from './session-store.js';

/** What the group features know about this deployment and page load (#24). */
export interface GroupEnv {
  readonly sync: SyncConfig;
  /** The group pointer for this sync server (ADR 0009). */
  readonly pointers: PointerStore;
  /** The QR ticket this page load arrived with (memory only, R3). */
  readonly landing: QrLanding | null;
  /** "Read without a group" was chosen on an update screen (this page load only). */
  readonly groupsDisabled: boolean;
  readonly disableGroups: () => void;
  /** The library page exists (on, and not single-book). */
  readonly libraryOn: boolean;
  readonly singleBook: boolean;
  /** Bundled content IDs (for "Open the group's book", U2). */
  readonly bundledIds: readonly string[];
  readonly srcOrigins: readonly string[];
}

export const GroupEnvContext = createContext<GroupEnv | null>(null);

/** The group environment, or `null` when sync is off (the solo reader, AC2). */
export function useGroupEnv(): GroupEnv | null {
  return useContext(GroupEnvContext);
}

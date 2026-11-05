'use client';
// Public API of @sync-system/react (#15).

export { SyncProvider } from './provider.js';
export type { SyncProviderProps } from './provider.js';
export { useSyncSelector, useSyncSnapshot } from './selector.js';
export {
  useConnection,
  useSyncClient,
  useSyncIndicator,
  useUpdateRequired,
} from './hooks/connection.js';
export type { Connection } from './hooks/connection.js';
export { ConnectionIndicator } from './components/connection-indicator.js';
export type {
  ConnectionIndicatorProps,
  ConnectionIndicatorRenderProps,
} from './components/connection-indicator.js';
export type {
  ActionResult,
  ActionState,
  JoinFlowState,
  JoinPausedState,
  LeadershipChange,
  QrTicketState,
  StoredGroup,
  SyncClientLike,
  SyncState,
  UpdateRequired,
} from './types.js';

// Core runtime helpers the hooks' values are checked with (AC2).
export {
  ClientErrorCode,
  SyncClient,
  SyncClientError,
  indicatorOf,
  isSyncClientError,
} from '@sync-system/client';

// Core types the hooks return, so apps need not import the core (AC2).
export type {
  ClosedReason,
  CodesChangedEvent,
  CodesChangedReason,
  ConnectedInfo,
  ConnectionState,
  CreatedGroup,
  CreateGroupOptions,
  GroupEndedInfo,
  GroupEndedReason,
  GroupIdEvent,
  GroupState,
  HandoffMode,
  JoinByQrOptions,
  JoinCodes,
  JoinedGroup,
  JoinMethod,
  JoinOptions,
  JoinPausedEvent,
  JoinRequest,
  JoinRequestedEvent,
  JoinResumedEvent,
  JoinWithdrawnEvent,
  JsonObject,
  JsonValue,
  KeepAliveEvent,
  LeaderChangedEvent,
  LeaderLifecycle,
  LeaderState,
  LeaderStatusEvent,
  LeadershipLostEvent,
  LeadershipReason,
  LockChangedEvent,
  NowLeadingEvent,
  PositionUpdatedEvent,
  PreviewState,
  QrTicket,
  RemovedEvent,
  ResumedGroup,
  ResumeOptions,
  Role,
  RosterChangedEvent,
  RosterEntry,
  StorageOption,
  StoredGroupStatus,
  SyncClientEvents,
  SyncClientOptions,
  SyncClientSnapshot,
  SyncIndicator,
  TokenStatus,
  ViceChangedEvent,
} from '@sync-system/client';

'use client';
// Public API of @mosherw/sync-system-react (#15).

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
export { useSyncAction } from './action.js';
export {
  useGroup,
  useGroupEnded,
  useGroupExit,
  useLeaderStatus,
  usePosition,
  useRemoved,
} from './hooks/group.js';
export type { GroupEnded, GroupExit, LeaderStatus, Position } from './hooks/group.js';
export { useSyncEvent } from './hooks/events.js';
export { useCreateGroup, useJoinApproval, useJoinByCode, useJoinByQr } from './hooks/join.js';
export type { JoinApproval } from './hooks/join.js';
export { useStoredGroups } from './hooks/stored-groups.js';
export type { StoredGroups, StoredGroupsOptions } from './hooks/stored-groups.js';
export {
  useGroupLock,
  useHandoffMode,
  useJoinRequests,
  useKeepAlive,
  useLeaderCodes,
  useMemberRemoval,
  useQrTicket,
  useRoster,
  useViceLeader,
} from './hooks/leader.js';
export type {
  GroupLock,
  JoinRequests,
  KeepAlive,
  LeaderCodes,
  MemberRemoval,
  QrTicketHook,
  QrTicketOptions,
  ViceLeader,
} from './hooks/leader.js';
export { useLeadership } from './hooks/leadership.js';
export type { Leadership } from './hooks/leadership.js';
export { usePreview } from './hooks/preview.js';
export type { Preview } from './hooks/preview.js';
export { QrTicket } from './components/qr-ticket.js';
export type { QrTicketProps } from './components/qr-ticket.js';
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
} from '@mosherw/sync-system-client';

// The join input rules, so apps check codes, tickets and names exactly as
// the client and server do before sending (#24 P2). Same function objects.
export {
  MAX_DISPLAY_NAME_INPUT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_JOIN_CODE_INPUT_LENGTH,
  MAX_QR_TICKET_LENGTH,
  classifyJoinCode,
  isDoorCode,
  isQrTicketShape,
  normalizeJoinCode,
  resolveDisplayName,
} from '@mosherw/sync-system-client';

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
  JoinCodeKind,
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
  RemovedEvent,
  ResolvedDisplayName,
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
} from '@mosherw/sync-system-client';

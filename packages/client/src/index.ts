// Public API of @sync-system/client.
export { SyncClient, createSyncClient } from './client.js';
export { indicatorOf } from './state.js';
export { ClientErrorCode, SyncClientError, isSyncClientError } from './errors.js';
export type { ErrorDetailsMap, RequestKind } from './errors.js';
export type { WebSocketConstructorLike, WebSocketLike } from './host.js';
export type { LogFields, SyncClientLogger } from './logger.js';
export type { ReconnectOptions, SyncClientOptions } from './options.js';
export { memoryStorage } from './storage.js';
export type { StorageOption, TokenStorage } from './storage.js';
export type {
  ClosedReason,
  ConnectedInfo,
  ConnectionState,
  CreatedGroup,
  GroupEndedInfo,
  GroupEndedReason,
  GroupState,
  JoinedGroup,
  JoinOptions,
  JoinCodes,
  CreateGroupOptions,
  QrTicket,
  JoinRequest,
  CodesChangedReason,
  CodesChangedEvent,
  JoinRequestedEvent,
  JoinWithdrawnEvent,
  JoinPausedEvent,
  JoinResumedEvent,
  JoinByQrOptions,
  LeaderStatusEvent,
  PositionUpdatedEvent,
  ResumeOptions,
  ResumedGroup,
  StoredGroupStatus,
  SyncClientEvents,
  SyncClientSnapshot,
  SyncIndicator,
  RosterEntry,
  RosterChangedEvent,
  ViceChangedEvent,
  LockChangedEvent,
  RemovedEvent,
  LeaderLifecycle,
  LeadershipReason,
  NowLeadingEvent,
  LeadershipLostEvent,
  LeaderChangedEvent,
  KeepAliveEvent,
  GroupIdEvent,
  LeaderState,
} from './state.js';
export { CLIENT_PROTOCOL_VERSION, MIN_SERVER_PROTOCOL_VERSION } from './version.js';
export type {
  AppLimits,
  JoinMethod,
  JsonObject,
  JsonValue,
  Role,
  TokenStatus,
  HandoffMode,
} from '@sync-system/protocol';

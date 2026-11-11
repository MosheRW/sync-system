// Public API of @sync-system/client.
export { SyncClient, createSyncClient } from './client.js';
export { indicatorOf } from './state.js';
export { LeaderPreview, LEADER_ACTIVITY_MIN_INTERVAL_MS } from './preview.js';
export type { PreviewState } from './preview.js';
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
// The protocol's join input rules, so apps check input exactly as the client
// and server do before sending (#24 P2). Same function objects, no wrappers.
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
} from '@sync-system/protocol';
export type {
  AppLimits,
  JoinMethod,
  JsonObject,
  JsonValue,
  Role,
  TokenStatus,
  HandoffMode,
  JoinCodeKind,
  ResolvedDisplayName,
} from '@sync-system/protocol';

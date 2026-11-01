// Public API of @sync-system/client.
export { SyncClient, createSyncClient } from './client.js';
export { indicatorOf } from './state.js';
export { ClientErrorCode, SyncClientError, isSyncClientError } from './errors.js';
export type { ErrorDetailsMap, RequestKind } from './errors.js';
export type { WebSocketConstructorLike, WebSocketLike } from './host.js';
export type { LogFields, SyncClientLogger } from './logger.js';
export type { ReconnectOptions, SyncClientOptions } from './options.js';
export type {
  ClosedReason,
  ConnectedInfo,
  ConnectionState,
  CreatedGroup,
  GroupEndedInfo,
  GroupEndedReason,
  GroupState,
  JoinedGroup,
  PositionUpdatedEvent,
  SyncClientEvents,
  SyncClientSnapshot,
  SyncIndicator,
} from './state.js';
export { CLIENT_PROTOCOL_VERSION, MIN_SERVER_PROTOCOL_VERSION } from './version.js';
export type { AppLimits, JsonObject, JsonValue, Role } from '@sync-system/protocol';

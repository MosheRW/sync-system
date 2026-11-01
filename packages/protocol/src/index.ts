export { PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL_VERSION } from './version.js';
export { ErrorCode } from './errors.js';
export { CloseCode } from './close-codes.js';
export type { JsonPrimitive, JsonValue, JsonObject } from './json.js';
export {
  MAX_JSON_DEPTH,
  GROUP_ID_LENGTH,
  GROUP_ID_PATTERN,
  MAX_GROUP_ID_INPUT_LENGTH,
  MAX_API_KEY_LENGTH,
  MAX_APP_VERSION_LENGTH,
  MAX_APP_VERSION_INPUT_LENGTH,
  MAX_REQ_ID_LENGTH,
} from './limits.js';
export type {
  Role,
  GroupEndedReason,
  HelloMessage,
  GroupCreateMessage,
  GroupJoinMessage,
  PositionUpdateMessage,
  ClientMessage,
  ClientMessageType,
  WelcomeMessage,
  AppLimits,
  HelloOkMessage,
  GroupCreatedMessage,
  GroupJoinedMessage,
  PositionAckMessage,
  PositionUpdatedMessage,
  GroupEndedMessage,
  ErrorMessage,
  ServerMessage,
  ServerMessageType,
} from './messages.js';
export {
  helloSchema,
  groupCreateSchema,
  groupJoinSchema,
  positionUpdateSchema,
  clientMessageSchema,
  serverMessageSchema,
  formatIssues,
  parseClientMessage,
  parseServerMessage,
} from './schemas.js';
export type { ParseResult } from './schemas.js';
export { checkJson } from './json-guard.js';
export type { JsonCheckOptions, JsonCheckResult } from './json-guard.js';

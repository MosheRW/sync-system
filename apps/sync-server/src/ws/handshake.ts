import {
  CloseCode,
  ErrorCode,
  type HelloMessage,
  type JsonValue,
  MAX_APP_VERSION_LENGTH,
  MIN_CLIENT_PROTOCOL_VERSION,
} from '@sync-system/protocol';
import semver from 'semver';
import type { AppConfig, AppRegistry } from '../apps/app-registry.js';
import type { ConnectionCounter } from './connection-counter.js';
import type { GenericErrorCode } from './error-messages.js';

export type HandshakeResult =
  | { ok: true; app: AppConfig }
  | {
      ok: false;
      code: GenericErrorCode;
      closeCode: number;
      details?: Record<string, JsonValue>;
    };

function reject(code: GenericErrorCode, details?: Record<string, JsonValue>): HandshakeResult {
  const closeCode =
    code === ErrorCode.APP_CONNECTION_LIMIT
      ? CloseCode.APP_CONNECTION_LIMIT
      : CloseCode.HANDSHAKE_REJECTED;
  return details === undefined
    ? { ok: false, code, closeCode }
    : { ok: false, code, closeCode, details };
}

/**
 * Validates a schema-checked hello, in order: protocol version, API key, app
 * version format, app version minimum, per-app connection cap (M5). String
 * lengths were already bounded by the schema, so hashing and semver parsing
 * only ever see short inputs (L2).
 */
export function checkHello(
  hello: HelloMessage,
  registry: AppRegistry,
  counter: ConnectionCounter,
): HandshakeResult {
  if (hello.protocolVersion < MIN_CLIENT_PROTOCOL_VERSION) {
    return reject(ErrorCode.PROTOCOL_TOO_OLD, { minProtocolVersion: MIN_CLIENT_PROTOCOL_VERSION });
  }

  const app = hello.apiKey ? registry.findByApiKey(hello.apiKey) : undefined;
  if (!app) {
    return reject(ErrorCode.INVALID_API_KEY);
  }

  if (hello.appVersion.length > MAX_APP_VERSION_LENGTH || semver.valid(hello.appVersion) === null) {
    return reject(ErrorCode.INVALID_APP_VERSION);
  }
  if (semver.lt(hello.appVersion, app.minAppVersion)) {
    return reject(ErrorCode.APP_VERSION_TOO_OLD, { minAppVersion: app.minAppVersion });
  }

  if (counter.appCount(app.namespace) >= app.maxConnections) {
    return reject(ErrorCode.APP_CONNECTION_LIMIT);
  }

  return { ok: true, app };
}

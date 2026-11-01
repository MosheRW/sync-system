/** Log fields are primitives only, so nothing structured (payloads, metadata) can be passed (AC32). */
export type LogFields = Record<string, string | number | boolean>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Optional logger. The client only passes fixed event names and safe fields
 * (state names, attempt numbers, delays, error and close codes, message
 * types). It never passes the API key, the URL, group or participant IDs,
 * metadata, positions or server message text.
 */
export interface SyncClientLogger {
  debug?(event: string, fields?: LogFields): void;
  info?(event: string, fields?: LogFields): void;
  warn?(event: string, fields?: LogFields): void;
  error?(event: string, fields?: LogFields): void;
}

/** Calls the logger if it has the method; a throwing logger never breaks the client. */
export function log(
  logger: SyncClientLogger | undefined,
  level: LogLevel,
  event: string,
  fields?: LogFields,
): void {
  if (logger === undefined) return;
  try {
    if (typeof logger[level] === 'function') logger[level](event, fields);
  } catch {
    // The logger is app code; its failures must not break the client.
  }
}

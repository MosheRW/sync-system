/**
 * A startup configuration problem. The message is human-readable and is
 * printed to stderr as `Config error: <message>`. It must never contain an
 * API key value or any other received secret; callers build it from field
 * names, paths and validated numbers only.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * The reader's own version, sent as the sync client's `appVersion` unless
 * `READER_SYNC_APP_VERSION` overrides it. A test keeps it equal to
 * `package.json`; a constant works in both the Vite and the server build.
 */
export const READER_VERSION = '0.1.0';

/**
 * The reader's own version (ADR 0023 B1), sent as the sync client's
 * `appVersion` unless `READER_SYNC_APP_VERSION` overrides it, and reported
 * on `/health` (never the override). Bumped by hand with `package.json` and
 * `CHANGELOG.md`; a test keeps it equal to `package.json`; a constant works
 * in both the Vite and the server build.
 */
export const READER_VERSION = '1.0.0';

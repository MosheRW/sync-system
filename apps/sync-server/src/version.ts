import { closeSync, openSync, readSync } from 'node:fs';
import { URL } from 'node:url';
import semver from 'semver';

/** The package whose version `/health` reports. */
export const SERVER_PACKAGE_NAME = '@mosherw/sync-system-server';

/** Largest package.json read; anything bigger is refused before parsing (#36 security C8). */
export const MAX_PACKAGE_JSON_BYTES = 64 * 1024;

/** Longest version string served. */
export const MAX_VERSION_LENGTH = 64;

/** Prefix of the startup error printed when the version cannot be read. */
export const VERSION_STARTUP_PREFIX = 'cannot read the server version';

/**
 * Every reason `readServerVersion` can give. None contains a path beyond
 * `package.json` or any file content (#36 security C8).
 */
export const VERSION_REASONS = {
  notFound: 'package.json not found next to the server code',
  unreadable: (code: string) => `package.json cannot be read (${code})`,
  tooLarge: `package.json is larger than ${MAX_PACKAGE_JSON_BYTES / 1024} KiB`,
  notJson: 'package.json is not valid JSON',
  wrongPackage: "package.json is not the sync server's",
  noVersion: 'package.json has no valid semver version',
} as const;

/** The server version could not be read; `reason` is one of VERSION_REASONS. */
export class VersionError extends Error {
  override readonly name = 'VersionError';
  constructor(readonly reason: string) {
    super(`${VERSION_STARTUP_PREFIX}: ${reason}`);
  }
}

/**
 * `../package.json` from this module, with Node's URL. Not written as
 * `new URL(x, import.meta.url)`: Vite rewrites that pattern into an asset
 * URL when a browser-like test environment (jsdom) loads this module.
 */
function defaultPackageUrl(): URL {
  const moduleUrl: string = import.meta.url;
  return new URL('../package.json', moduleUrl);
}

function readCapped(url: URL): Buffer {
  let fd: number;
  try {
    fd = openSync(url, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new VersionError(
      code === 'ENOENT' ? VERSION_REASONS.notFound : VERSION_REASONS.unreadable(code),
    );
  }
  try {
    // One byte over the cap tells a file at the cap from a bigger one.
    const buffer = Buffer.alloc(MAX_PACKAGE_JSON_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_PACKAGE_JSON_BYTES) throw new VersionError(VERSION_REASONS.tooLarge);
    }
    return buffer.subarray(0, length);
  } catch (err) {
    if (err instanceof VersionError) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new VersionError(VERSION_REASONS.unreadable(code));
  } finally {
    closeSync(fd);
  }
}

/**
 * The sync server's semver version from its own `package.json` (#36 AC33,
 * Q21). The path is fixed relative to this module, never taken from env or
 * arguments: `src/version.ts` reads `apps/sync-server/package.json`, and
 * `dist/version.js` in the image reads `/app/package.json`. Read once at
 * startup. Throws VersionError with a reason that never contains the file
 * content or the absolute path.
 */
export function readServerVersion(url = defaultPackageUrl()): string {
  const text = readCapped(url).toString('utf8');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // The SyntaxError message quotes the input: never passed on.
    throw new VersionError(VERSION_REASONS.notJson);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new VersionError(VERSION_REASONS.notJson);
  }
  const record = data as Record<string, unknown>;
  if (record.name !== SERVER_PACKAGE_NAME) throw new VersionError(VERSION_REASONS.wrongPackage);
  const version = record.version;
  if (
    typeof version !== 'string' ||
    version.length > MAX_VERSION_LENGTH ||
    semver.valid(version) !== version
  ) {
    throw new VersionError(VERSION_REASONS.noVersion);
  }
  return version;
}

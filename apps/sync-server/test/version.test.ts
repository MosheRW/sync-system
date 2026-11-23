import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/main.js';
import {
  MAX_PACKAGE_JSON_BYTES,
  VERSION_REASONS,
  VersionError,
  readServerVersion,
} from '../src/version.js';
import { LogCapture } from './helpers/log-capture.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
const devConfigPath = fileURLToPath(new URL('../../../config/apps.dev.json', import.meta.url));
/** Test-only value, never real. */
const STRONG = 'q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=';

function file(content: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'sync-version-'));
  const path = join(dir, 'package.json');
  writeFileSync(path, content);
  return pathToFileURL(path);
}

function reasonOf(url: URL): string {
  try {
    readServerVersion(url);
  } catch (err) {
    expect(err).toBeInstanceOf(VersionError);
    return (err as VersionError).reason;
  }
  throw new Error('expected a VersionError');
}

describe('readServerVersion (#36 AC33, Q21)', () => {
  it("reads the server's own package.json by default", () => {
    expect(packageJson.name).toBe('@mosherw/sync-system-server');
    expect(readServerVersion()).toBe(packageJson.version);
  });

  it('reads a valid file', () => {
    expect(
      readServerVersion(file('{"name":"@mosherw/sync-system-server","version":"2.3.4-rc.1"}')),
    ).toBe('2.3.4-rc.1');
  });

  it('gives a reason for each failure, without content or path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-version-'));
    const cases: Array<[URL, string]> = [
      [pathToFileURL(join(dir, 'missing.json')), VERSION_REASONS.notFound],
      [pathToFileURL(dir), VERSION_REASONS.unreadable('EISDIR')],
      [file('{"name": SENTINEL'), VERSION_REASONS.notJson],
      [file('["SENTINEL"]'), VERSION_REASONS.notJson],
      [
        file('{"name":"@mosherw/sync-system-reader","version":"1.0.0"}'),
        VERSION_REASONS.wrongPackage,
      ],
      [file('{"version":"1.0.0"}'), VERSION_REASONS.wrongPackage],
      [file('{"name":"@mosherw/sync-system-server"}'), VERSION_REASONS.noVersion],
      [file('{"name":"@mosherw/sync-system-server","version":1}'), VERSION_REASONS.noVersion],
      [
        file('{"name":"@mosherw/sync-system-server","version":"SENTINEL"}'),
        VERSION_REASONS.noVersion,
      ],
      [
        file('{"name":"@mosherw/sync-system-server","version":"v1.0.0"}'),
        VERSION_REASONS.noVersion,
      ],
      [
        file(`{"name":"@mosherw/sync-system-server","version":"1.0.0-${'a'.repeat(60)}"}`),
        VERSION_REASONS.noVersion,
      ],
    ];
    for (const [url, reason] of cases) {
      const got = reasonOf(url);
      expect(got, url.href).toBe(reason);
      expect(got).not.toContain('SENTINEL');
      expect(got).not.toContain(dir);
    }
  });

  it('refuses a file over 64 KiB before parsing it (#36 security C8)', () => {
    const padding = ' '.repeat(MAX_PACKAGE_JSON_BYTES);
    expect(
      reasonOf(file(`{"name":"@mosherw/sync-system-server","version":"1.0.0"}${padding}`)),
    ).toBe(VERSION_REASONS.tooLarge);
    const atCap = `{"name":"@mosherw/sync-system-server","version":"1.0.0"}`;
    expect(readServerVersion(file(atCap.padEnd(MAX_PACKAGE_JSON_BYTES, ' ')))).toBe('1.0.0');
  });
});

describe('run with a bad package.json (#36 AC33)', () => {
  const env = { SYNC_CONFIG_PATH: devConfigPath, NODE_ENV: 'test', TOKEN_SECRET: STRONG };

  async function runWith(extra: Record<string, string>, versionUrl: URL) {
    let stderr = '';
    const logs = new LogCapture();
    const result = await run(
      { ...env, PORT: '1', HOST: '127.0.0.1', ...extra },
      { stderr: (text) => (stderr += text), destination: logs, versionUrl },
    );
    return { result, stderr, logs };
  }

  it('prints a Startup error and exits 1, without listening', async () => {
    const { result, stderr, logs } = await runWith({}, file('{"name":"other","version":"1.0.0"}'));
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toBe(
      "Startup error: cannot read the server version: package.json is not the sync server's\n",
    );
    expect(logs.text).toBe('');
  });

  it('reports config problems first and stops there', async () => {
    const { result, stderr } = await runWith({ LOG_LEVEL: 'loud' }, file('{'));
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toBe(
      'Config error: LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent\n',
    );
  });
});

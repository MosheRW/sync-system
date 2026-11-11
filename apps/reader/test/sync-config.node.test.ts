// @vitest-environment node
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from '../server/headers.js';
import { run } from '../server/run.js';
import { ConfigError } from '../src/config/config-error.js';
import {
  type EnvSource,
  PUBLIC_DEV_API_KEYS,
  parsePublicConfig,
  parseReaderConfig,
  publicConfig,
} from '../src/config/schema.js';
import { checkSyncUrl } from '../src/config/sync-url.js';
import { READER_VERSION } from '../src/config/version.js';
import { makeDist } from './helpers/server.js';

const IDS = ['samples/psalms-he', 'samples/untitled'];
const KEY = 'reader-test-api-key-0123456789abcdef';
const URL_OK = 'wss://sync.example.org/ws';
const repoRoot = join(import.meta.dirname, '..', '..', '..');

function problems(env: EnvSource): readonly string[] {
  try {
    parseReaderConfig(env, IDS);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a config error');
}

describe('READER_SYNC_* (#24 AC1)', () => {
  it('is off without READER_SYNC_URL', () => {
    expect(parseReaderConfig({}, IDS).sync).toBeNull();
  });

  it('parses the URL, key, version and countdown with their defaults', () => {
    expect(
      parseReaderConfig({ READER_SYNC_URL: URL_OK, READER_SYNC_API_KEY: KEY }, IDS).sync,
    ).toEqual({ url: URL_OK, apiKey: KEY, appVersion: READER_VERSION, lateJoinSeconds: 10 });
    expect(
      parseReaderConfig(
        {
          READER_SYNC_URL: 'ws://127.0.0.1:8080/ws',
          READER_SYNC_API_KEY: KEY,
          READER_SYNC_APP_VERSION: '2.0.0-beta.1+build.5',
          READER_SYNC_LATE_JOIN_SECONDS: '0',
        },
        IDS,
      ).sync,
    ).toEqual({
      url: 'ws://127.0.0.1:8080/ws',
      apiKey: KEY,
      appVersion: '2.0.0-beta.1+build.5',
      lateJoinSeconds: 0,
    });
  });

  it('stores the parsed href', () => {
    expect(
      parseReaderConfig(
        { READER_SYNC_URL: 'WSS://Sync.Example.org', READER_SYNC_API_KEY: KEY },
        IDS,
      ).sync?.url,
    ).toBe('wss://sync.example.org/');
  });

  it.each([
    [{ READER_SYNC_API_KEY: KEY }, /^READER_SYNC_API_KEY is set but READER_SYNC_URL is not/],
    [{ READER_SYNC_APP_VERSION: '1.0.0' }, /^READER_SYNC_APP_VERSION is set but READER_SYNC_URL/],
    [{ READER_SYNC_LATE_JOIN_SECONDS: '5' }, /^READER_SYNC_LATE_JOIN_SECONDS is set but/],
    [{ READER_SYNC_URL: URL_OK }, /^READER_SYNC_API_KEY is required when READER_SYNC_URL is set$/],
  ])('refuses the combination %j', (env, message) => {
    const list = problems(env);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(message);
  });

  // The L1 list from the security review, plus the scheme and loopback rules.
  it.each([
    ['wss://a;b/ws', 'must have a plain host name'],
    ['wss://a,b/ws', 'must have a plain host name'],
    ["wss://a'b/ws", 'must have a plain host name'],
    ['wss://*.x/ws', 'must have a plain host name'],
    ['ws://[::1]:8080/ws', 'must have a plain host name'],
    ['wss://u:p@x.example/ws', 'must not contain a user name or password'],
    ['wss://x.example/ws?k=1', 'must not contain a query'],
    ['wss://x.example/ws?', 'must not contain a query'],
    ['wss://x.example/ws#f', 'must not contain a fragment'],
    ['ws://example.com/ws', 'ws: is allowed only for localhost and 127.0.0.1'],
    ['https://x.example/ws', 'must use wss:'],
    ['not a url', 'is not a URL'],
  ])('refuses READER_SYNC_URL %j (R1)', (url, message) => {
    const [problem] = problems({ READER_SYNC_URL: url, READER_SYNC_API_KEY: KEY });
    expect(problem).toContain('READER_SYNC_URL');
    expect(problem).toContain(message);
  });

  it.each([
    ['too short', 'k'.repeat(31)],
    ['too long', 'k'.repeat(257)],
    ['with a space', `${'k'.repeat(20)} ${'k'.repeat(20)}`],
    ['non-ASCII', `${'k'.repeat(32)}é`],
  ])('refuses an API key %s and never prints it (R2)', (_name, key) => {
    const list = problems({ READER_SYNC_URL: URL_OK, READER_SYNC_API_KEY: key });
    expect(list).toEqual([expect.stringMatching(/^READER_SYNC_API_KEY must be 32 to 256 visible/)]);
    expect(list.join('\n')).not.toContain(key.trim());
  });

  it.each([
    ['wss://dana:s3cret-pass@sync.example.org/ws', 'credentials'],
    ['ws://dana:s3cret-pass@sync.example.org/ws', 'not loopback'],
    ['wss:dana:s3cret-pass@sync.example.org', 'no slashes'],
    ['wss:\\dana:s3cret-pass@sync.example.org', 'backslashes'],
    ['wss://dana:s3cret@pass@sync.example.org?x=1', 'an @ in the password'],
    ['wss://dana:s3cret-pass@a;b', 'a bad host'],
  ])('never prints a password in a refused READER_SYNC_URL %j (%s)', (url) => {
    const list = problems({ READER_SYNC_URL: url, READER_SYNC_API_KEY: KEY });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(/^READER_SYNC_URL "wss?:[/\\]*\*\*\*@/);
    expect(list[0]).not.toContain('s3cret');
    expect(list[0]).not.toContain('dana');
  });

  const SPECIAL_PASSWORDS = ['pa/ss3cret', 'pa?ss3cret', 'pa#ss3cret', 'pa\\ss3cret', 'pa@ss3cret'];

  it.each(SPECIAL_PASSWORDS)(
    'never prints a password with an unencoded delimiter in READER_SYNC_URL (%j)',
    (password) => {
      for (const scheme of ['wss://', 'ws://', 'wss:', 'WSS:\\\\']) {
        const url = `${scheme}dana:${password}@sync.example.org/ws`;
        const list = problems({ READER_SYNC_URL: url, READER_SYNC_API_KEY: KEY });
        expect(list, url).toHaveLength(1);
        expect(list[0], url).toContain('***@sync.example.org/ws"');
        expect(list[0], url).not.toContain('ss3cret');
        expect(list[0], url).not.toContain('dana');
      }
    },
  );

  it.each(SPECIAL_PASSWORDS)(
    'never prints a password with an unencoded delimiter in READER_SRC_ORIGINS (%j)',
    (password) => {
      const list = problems({
        READER_SRC_ORIGINS: `https://books.example.org,https://dana:${password}@cdn.example.org`,
      });
      expect(list).toHaveLength(1);
      expect(list[0]).toContain('"https://***@cdn.example.org"');
      expect(list[0]).not.toContain('ss3cret');
      expect(list[0]).not.toContain('dana');
    },
  );

  it('never prints a user name taken for a scheme', () => {
    const list = problems({
      READER_SYNC_URL: 'dana:s3cret@sync.example.org',
      READER_SYNC_API_KEY: KEY,
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('"***@sync.example.org"');
    expect(list[0]).not.toContain('dana');
    expect(list[0]).not.toContain('s3cret');
  });

  it('never prints a password in a refused READER_SRC_ORIGINS entry', () => {
    const list = problems({ READER_SRC_ORIGINS: 'https://dana:s3cret-pass@books.example.org' });
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('"https://***@books.example.org"');
    expect(list[0]).not.toContain('s3cret');
  });

  it('never prints the key when another sync setting is wrong', () => {
    const list = problems({
      READER_SYNC_URL: 'wss://a;b',
      READER_SYNC_API_KEY: KEY,
      READER_SYNC_APP_VERSION: 'v1',
      READER_SYNC_LATE_JOIN_SECONDS: '61',
    });
    expect(list).toHaveLength(3);
    expect(list.join('\n')).not.toContain(KEY);
  });

  it.each(['1.2', 'v1.2.3', '01.2.3', `1.2.3-${'a'.repeat(60)}`])(
    'refuses the app version %j',
    (version) => {
      const [problem] = problems({
        READER_SYNC_URL: URL_OK,
        READER_SYNC_API_KEY: KEY,
        READER_SYNC_APP_VERSION: version,
      });
      expect(problem).toMatch(/^READER_SYNC_APP_VERSION .* must be a semantic version/);
    },
  );

  it.each(['-1', '61', '1.5', 'ten'])('refuses the late-join seconds %j', (value) => {
    const [problem] = problems({
      READER_SYNC_URL: URL_OK,
      READER_SYNC_API_KEY: KEY,
      READER_SYNC_LATE_JOIN_SECONDS: value,
    });
    expect(problem).toMatch(/^READER_SYNC_LATE_JOIN_SECONDS .* must be an integer from 0 to 60$/);
  });

  it('warns in production about ws: loopback and the public dev key, never quoting the key', () => {
    const devKey = PUBLIC_DEV_API_KEYS[0]!;
    const { warnings } = parseReaderConfig(
      {
        NODE_ENV: 'production',
        READER_SYNC_URL: 'ws://127.0.0.1:8080/ws',
        READER_SYNC_API_KEY: devKey,
      },
      IDS,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^READER_SYNC_URL uses ws:/);
    expect(warnings[1]).toMatch(/^READER_SYNC_API_KEY is the public development key/);
    expect(warnings.join('\n')).not.toContain(devKey);
  });

  it('does not warn for wss: and a real key, nor in development', () => {
    expect(
      parseReaderConfig(
        { NODE_ENV: 'production', READER_SYNC_URL: URL_OK, READER_SYNC_API_KEY: KEY },
        IDS,
      ).warnings,
    ).toEqual([]);
    expect(
      parseReaderConfig(
        { READER_SYNC_URL: 'ws://localhost:8080/ws', READER_SYNC_API_KEY: PUBLIC_DEV_API_KEYS[0] },
        IDS,
      ).warnings,
    ).toEqual([]);
  });

  it('knows exactly the public keys committed in config/apps.dev.json (L10)', () => {
    const dev = JSON.parse(readFileSync(join(repoRoot, 'config', 'apps.dev.json'), 'utf8')) as {
      apps: { apiKey: string }[];
    };
    expect([...PUBLIC_DEV_API_KEYS].sort()).toEqual(dev.apps.map((app) => app.apiKey).sort());
  });

  it('keeps READER_VERSION equal to package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(READER_VERSION).toBe(pkg.version);
  });
});

describe('public sync config in the browser (C5, #24 AC1)', () => {
  const config = parseReaderConfig(
    { READER_SYNC_URL: URL_OK, READER_SYNC_API_KEY: KEY, READER_SYNC_LATE_JOIN_SECONDS: '7' },
    IDS,
  );
  const value = JSON.parse(JSON.stringify(publicConfig(config))) as Record<string, unknown>;

  it('round-trips the sync block, built from an explicit field list', () => {
    expect(Object.keys(publicConfig(config).sync ?? {}).sort()).toEqual([
      'apiKey',
      'appVersion',
      'lateJoinSeconds',
      'url',
    ]);
    expect(parsePublicConfig(value)).toEqual({ ok: true, config: publicConfig(config) });
  });

  it.each([
    ['a non-href URL', { url: 'wss://sync.example.org' }],
    ['an unsafe host', { url: 'wss://a;b/ws' }],
    ['a short key', { apiKey: 'short' }],
    ['a bad version', { appVersion: 'latest' }],
    ['a countdown over 60', { lateJoinSeconds: 61 }],
    ['an extra field', { token: 'x' }],
  ])('reports %s as a sync problem', (_name, change) => {
    const sync = { ...(value['sync'] as Record<string, unknown>), ...change };
    expect(parsePublicConfig({ ...value, sync })).toEqual({ ok: false, reason: 'sync' });
  });

  it('reports a wrong sync block next to another problem as a config problem', () => {
    expect(parsePublicConfig({ ...value, entry: 'x', sync: { url: 1 } })).toEqual({
      ok: false,
      reason: 'config',
    });
  });
});

describe('CSP connect-src with sync (#24 AC55, R1, R12)', () => {
  const off = contentSecurityPolicy({ srcOrigins: ['https://a.example'] });

  it('adds exactly the sync origin to connect-src and nothing else', () => {
    const on = contentSecurityPolicy({ srcOrigins: ['https://a.example'], syncUrl: URL_OK });
    expect(on).toContain("connect-src 'self' https://a.example wss://sync.example.org;");
    expect(on.replace(' wss://sync.example.org', '')).toBe(off);
  });

  it('keeps a port and drops the path', () => {
    expect(contentSecurityPolicy({ srcOrigins: [], syncUrl: 'ws://127.0.0.1:8080/ws' })).toContain(
      "connect-src 'self' ws://127.0.0.1:8080;",
    );
  });

  it('has no sync origin when sync is off', () => {
    expect(off).not.toMatch(/wss?:/);
    expect(contentSecurityPolicy({ srcOrigins: [], syncUrl: null })).toContain(
      "connect-src 'self';",
    );
  });

  it.each(['wss://a;b/ws', 'wss://a,b/ws', 'wss://sync.example.org', 'https://x.example/'])(
    'refuses to put %j into the CSP',
    (syncUrl) => {
      expect(() => contentSecurityPolicy({ srcOrigins: [], syncUrl })).toThrow();
    },
  );

  it('keeps Permissions-Policy unchanged (camera stays off)', () => {
    expect(securityHeaders({ srcOrigins: [], syncUrl: URL_OK })['Permissions-Policy']).toBe(
      'camera=(), microphone=(), geolocation=()',
    );
  });

  it('only ever emits the checked origin', () => {
    const checked = checkSyncUrl('wss://sync.example.org:9443/ws');
    expect(checked).toMatchObject({ ok: true, origin: 'wss://sync.example.org:9443' });
  });
});

describe('the reader server sends the sync origin (#24 AC1)', () => {
  const dist = makeDist();
  afterAll(() => dist.cleanup());

  it('serves the CSP with the sync origin and the sync block in the page', async () => {
    const stderr: string[] = [];
    const result = await run(
      { PORT: '0', HOST: '127.0.0.1', READER_SYNC_URL: URL_OK, READER_SYNC_API_KEY: KEY },
      { distDir: dist.dir, stderr: (t) => stderr.push(t), stdout: () => undefined },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      const { csp, body } = await new Promise<{ csp: string; body: string }>((resolve, reject) => {
        request({ host: '127.0.0.1', port: result.port, path: '/' }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () =>
            resolve({ csp: String(res.headers['content-security-policy']), body: text }),
          );
        })
          .on('error', reject)
          .end();
      });
      expect(csp).toContain("connect-src 'self' wss://sync.example.org;");
      expect(body).toContain('"sync":{"url":"wss://sync.example.org/ws"');
      expect(stderr).toEqual([]);
    } finally {
      await result.close();
    }
  });
});

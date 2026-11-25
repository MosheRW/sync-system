// @vitest-environment node
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler, parsePath } from '../server/handler.js';
import { contentSecurityPolicy, securityHeaders } from '../server/headers.js';
import { run } from '../server/run.js';
import type { StaticFile } from '../server/static-files.js';
import { READER_VERSION } from '../src/config/version.js';
import { makeDist, rawRequest } from './helpers/server.js';

const SECURITY_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
];

function expectSecurityHeaders(response: Response) {
  for (const name of SECURITY_HEADERS) expect(response.headers.get(name), name).not.toBeNull();
}

const dist = makeDist();
let base = '';
let port = 0;
let close: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  const result = await run(
    { PORT: '0', HOST: '127.0.0.1', READER_SRC_ORIGINS: 'https://content.example.org' },
    { distDir: dist.dir, stdout: () => undefined, stderr: () => undefined },
  );
  if (!result.ok) throw new Error('server did not start');
  port = result.port;
  base = `http://127.0.0.1:${port}`;
  close = result.close;
});

afterAll(async () => {
  await close();
  dist.cleanup();
});

describe('reader server responses (architecture 5.5, security C1)', () => {
  it('serves the index with the injected config and no-cache', async () => {
    const response = await fetch(`${base}/?book=samples/psalms-he`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const html = await response.text();
    expect(html).toContain('<script type="application/json" id="reader-config">');
    expect(html).not.toContain('<!--reader-config-->');
    expectSecurityHeaders(response);
  });

  it('serves /library when the library is on', async () => {
    const response = await fetch(`${base}/library`);
    expect(response.status).toBe(200);
  });

  it('serves hashed assets from memory with an immutable cache', async () => {
    const response = await fetch(`${base}/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expectSecurityHeaders(response);
  });

  it('answers /health with the status and the reader version as JSON (ADR 0023 C1)', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(`{"status":"ok","version":"${READER_VERSION}"}`);
    expectSecurityHeaders(response);
  });

  it('answers HEAD /health without a body', async () => {
    const response = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('');
    expect(Number(response.headers.get('content-length'))).toBe(
      `{"status":"ok","version":"${READER_VERSION}"}`.length,
    );
    expectSecurityHeaders(response);
  });

  it('has no /ready endpoint (liveness only, #36 Q25)', async () => {
    expect((await fetch(`${base}/ready`)).status).toBe(404);
  });

  it.each([
    '/index.html',
    '/library-index.json',
    '/assets/missing.js',
    '/../package.json',
    '/%2e%2e/%2e%2e/package.json',
    '/assets/..%2f..%2fpackage.json',
    '/etc/passwd',
  ])('404s %s without echoing it', async (path) => {
    const response = await fetch(`${base}${path}?q=<b>echo-me</b>`);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toBe('Not found\n');
    expectSecurityHeaders(response);
  });

  it('answers HEAD without a body', async () => {
    const response = await fetch(`${base}/`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('rejects %s with 405 and Allow', async (method) => {
    const response = await fetch(`${base}/`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expectSecurityHeaders(response);
  });

  it('sends the CSP with the configured origins (ADR 0006)', async () => {
    const response = await fetch(`${base}/`);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://content.example.org; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
    );
  });
});

describe('malformed requests keep the process alive (security F1, C1)', () => {
  it.each([
    ['bad percent-encoding', 'GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['absolute-form garbage', 'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['asterisk', 'GET * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ])('%s -> 400 with security headers', async (_name, request) => {
    const response = await rawRequest(port, request);
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response.toLowerCase()).toContain('content-security-policy:');
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('unparseable HTTP -> 400 from clientError, server still up', async () => {
    const response = await rawRequest(port, 'NOT HTTP AT ALL\r\n\r\n');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response.toLowerCase()).toContain('content-security-policy:');
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('parsePath accepts only origin-form targets', () => {
    expect(parsePath('/assets/a.js?x=1')).toBe('/assets/a.js');
    expect(parsePath('/%E0%A4%A')).toBeNull();
    expect(parsePath('http://evil/')).toBeNull();
    expect(parsePath('//evil/x')).toBeNull();
    expect(parsePath('*')).toBeNull();
    expect(parsePath(undefined)).toBeNull();
  });
});

describe('handler edge cases', () => {
  async function serve(options: Parameters<typeof createHandler>[0]) {
    const server = createServer(createHandler(options));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      url,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }

  it('/health reports the build version, never READER_SYNC_APP_VERSION', async () => {
    const result = await run(
      {
        PORT: '0',
        HOST: '127.0.0.1',
        READER_SYNC_URL: 'wss://sync.example/ws',
        READER_SYNC_API_KEY: 'k'.repeat(40),
        READER_SYNC_APP_VERSION: '9.9.9',
      },
      { distDir: dist.dir, stdout: () => undefined, stderr: () => undefined },
    );
    if (!result.ok) throw new Error('server did not start');
    try {
      const body = await (await fetch(`http://127.0.0.1:${result.port}/health`)).text();
      expect(body).toBe(`{"status":"ok","version":"${READER_VERSION}"}`);
      expect(body).not.toContain('9.9.9');
    } finally {
      await result.close();
    }
  });

  it('builds the /health body from the version option only, never the request', async () => {
    const s = await serve({
      files: new Map(),
      indexHtml: 'x',
      libraryOn: false,
      version: '3.2.1',
      headers: securityHeaders({ srcOrigins: [] }),
    });
    try {
      const response = await fetch(`${s.url}/health?version=6.6.6`, {
        headers: { 'X-Version': '7.7.7' },
      });
      expect(await response.text()).toBe('{"status":"ok","version":"3.2.1"}');
    } finally {
      await s.close();
    }
  });

  it('404s /library when the library is off', async () => {
    const s = await serve({
      files: new Map(),
      indexHtml: 'x',
      libraryOn: false,
      version: READER_VERSION,
      headers: securityHeaders({ srcOrigins: [] }),
    });
    try {
      expect((await fetch(`${s.url}/library`)).status).toBe(404);
      expect((await fetch(`${s.url}/`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('turns an unexpected error into a fixed 500 with security headers', async () => {
    const files = new Map<string, StaticFile>();
    files.get = () => {
      throw new Error('boom /secret/path');
    };
    const s = await serve({
      files,
      indexHtml: 'x',
      libraryOn: true,
      version: READER_VERSION,
      headers: securityHeaders({ srcOrigins: [] }),
    });
    try {
      const response = await fetch(`${s.url}/assets/x.js`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal error\n');
      expectSecurityHeaders(response);
      expect((await fetch(`${s.url}/health`)).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('CSP construction (security C2, C7)', () => {
  it('has no unsafe-inline, unsafe-eval, data: or blob:', () => {
    const csp = contentSecurityPolicy({ srcOrigins: ['https://a.example'] });
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:', '*']) {
      expect(csp).not.toContain(bad);
    }
  });

  it('refuses an injection-style origin', () => {
    expect(() =>
      contentSecurityPolicy({ srcOrigins: ["https://a.example; script-src 'unsafe-inline'"] }),
    ).toThrow();
    expect(() => contentSecurityPolicy({ srcOrigins: ['https://a.example/'] })).toThrow();
  });
});

describe('CSP enforces Trusted Types with no policy (#21 AC1, AC2, AC4, security C1)', () => {
  const cases: [string, Parameters<typeof contentSecurityPolicy>[0]][] = [
    ['no origins, sync off', { srcOrigins: [] }],
    ['?src origins, sync off', { srcOrigins: ['https://a.example', 'https://b.example:8443'] }],
    ['no origins, sync on', { srcOrigins: [], syncUrl: 'wss://sync.example/ws' }],
    [
      '?src origins, sync on',
      { srcOrigins: ['https://a.example'], syncUrl: 'ws://127.0.0.1:8080/ws' },
    ],
  ];

  function count(csp: string, directive: string): number {
    return csp.split('; ').filter((part) => part === directive).length;
  }

  it.each(cases)('%s: both directives, exactly once each', (_name, sources) => {
    const csp = contentSecurityPolicy(sources);
    expect(count(csp, "require-trusted-types-for 'script'")).toBe(1);
    expect(count(csp, "trusted-types 'none'")).toBe(1);
    expect(csp.split('; ').filter((part) => part.startsWith('trusted-types'))).toEqual([
      "trusted-types 'none'",
    ]);
    expect(csp.split('; ').filter((part) => part.startsWith('require-trusted-types-for'))).toEqual([
      "require-trusted-types-for 'script'",
    ]);
  });

  it.each(cases)('%s: no wildcard, duplicates or policy names', (_name, sources) => {
    const csp = contentSecurityPolicy(sources);
    expect(csp).not.toContain('*');
    expect(csp).not.toContain("'allow-duplicates'");
    expect(csp).not.toMatch(/trusted-types [^;]*\bdefault\b/);
  });

  it('ends with the two Trusted Types directives', () => {
    expect(contentSecurityPolicy({ srcOrigins: [] })).toMatch(
      /; require-trusted-types-for 'script'; trusted-types 'none'$/,
    );
  });
});

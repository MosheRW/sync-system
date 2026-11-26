// Unit tests of release:dry-run for an already-published version (#92, security
// C1-C9, L4). No test touches the network or npm: `fetch` is a stub, and
// `lookup` and `publishDryRun` are recording stubs.
// Run with Node's built-in runner: node --test "scripts/release/*.test.ts".
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REGISTRY,
  RegistryLookupError,
  dryRunPackages,
  lookupPublished,
  parsePublishedIntegrity,
  registryVersionUrl,
  type DryRunEntry,
  type LookupResult,
} from './dry-run.ts';
import { integrityLine, sha512Integrity } from './lib.ts';

const CLIENT = '@mosherw/sync-system-client';
const INTEGRITY = sha512Integrity(Buffer.from('client tarball'));
const OTHER = sha512Integrity(Buffer.from('another tarball'));
const NO_ENV: NodeJS.ProcessEnv = {};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` stub that records its calls and answers with `respond()`. */
function stubFetch(respond: () => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function doc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: CLIENT,
    version: '1.0.0',
    dist: { integrity: INTEGRITY, shasum: 'abc' },
    ...overrides,
  });
}

async function assertLookupFails(response: () => Response | Promise<Response>): Promise<void> {
  const { fetchImpl } = stubFetch(response);
  await assert.rejects(lookupPublished(CLIENT, '1.0.0', fetchImpl, NO_ENV), RegistryLookupError);
}

describe('registryVersionUrl (C2, C3)', () => {
  it('encodes the scope slash and uses the fixed registry', () => {
    const url = registryVersionUrl(CLIENT, '1.0.0');
    assert.equal(url.href, 'https://registry.npmjs.org/@mosherw%2Fsync-system-client/1.0.0');
    assert.equal(url.origin, REGISTRY);
    assert.equal(
      registryVersionUrl(CLIENT, '1.1.0-rc.1').pathname,
      `/@mosherw%2Fsync-system-client/1.1.0-rc.1`,
    );
  });

  it('ignores npm_config_registry', () => {
    const saved = process.env['npm_config_registry'];
    process.env['npm_config_registry'] = 'https://evil.example/';
    try {
      assert.equal(registryVersionUrl(CLIENT, '1.0.0').origin, 'https://registry.npmjs.org');
    } finally {
      if (saved === undefined) delete process.env['npm_config_registry'];
      else process.env['npm_config_registry'] = saved;
    }
  });

  it('throws for an invalid version or a package that is not published', () => {
    for (const version of ['1.0', '../x', '1.0.0/..', 'latest', '1.0.0?x', '1.0.0#x', '']) {
      assert.throws(() => registryVersionUrl(CLIENT, version), RegistryLookupError, version);
    }
    assert.throws(() => registryVersionUrl('@types/node', '1.0.0'), RegistryLookupError);
  });
});

describe('lookupPublished (C1, C4, C5, C8, L4)', () => {
  it('gives not published for a 404', async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response('{"error":"Not found"}', { status: 404 }),
    );
    assert.deepEqual(await lookupPublished(CLIENT, '1.0.0', fetchImpl, NO_ENV), {
      published: false,
    });
    assert.equal(calls.length, 1);
  });

  it('gives the integrity for a 200 with a valid body, with safe request options', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(doc(), { status: 200 }));
    assert.deepEqual(await lookupPublished(CLIENT, '1.0.0', fetchImpl, NO_ENV), {
      published: true,
      integrity: INTEGRITY,
    });
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.url, 'https://registry.npmjs.org/@mosherw%2Fsync-system-client/1.0.0');
    assert.equal(call.init?.redirect, 'error');
    assert.equal(call.init?.credentials, undefined);
    assert.deepEqual(call.init?.headers, { Accept: 'application/json' });
    assert.ok(call.init?.signal instanceof AbortSignal);
  });

  it('throws before fetching for an invalid version', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(doc(), { status: 200 }));
    await assert.rejects(lookupPublished(CLIENT, '../x', fetchImpl, NO_ENV), RegistryLookupError);
    assert.equal(calls.length, 0);
  });

  it('refuses to look up when NODE_TLS_REJECT_UNAUTHORIZED=0 (L4)', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(doc(), { status: 200 }));
    await assert.rejects(
      lookupPublished(CLIENT, '1.0.0', fetchImpl, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
      (error: unknown) =>
        error instanceof RegistryLookupError &&
        error.message.includes('NODE_TLS_REJECT_UNAUTHORIZED=0'),
    );
    assert.equal(calls.length, 0);
  });

  it('throws on a network error, with a sanitized reason', async () => {
    const cause = Object.assign(new Error('\u001b[31mspoofed'), { code: 'ENOTFOUND' });
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError('fetch failed \u001b[2J', { cause });
    });
    await assert.rejects(
      lookupPublished(CLIENT, '1.0.0', fetchImpl, NO_ENV),
      (error: unknown) =>
        error instanceof RegistryLookupError &&
        error.message.endsWith('network error (TypeError ENOTFOUND)') &&
        !error.message.includes('\u001b'),
    );
  });

  it('throws on an abort or timeout', async () => {
    await assertLookupFails(() => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    await assertLookupFails(() => {
      throw new DOMException('aborted', 'AbortError');
    });
  });

  for (const status of [500, 503, 429, 403, 401, 301, 302, 304, 204]) {
    it(`throws on HTTP ${status}`, async () => {
      const { fetchImpl } = stubFetch(() => new Response(null, { status }));
      await assert.rejects(
        lookupPublished(CLIENT, '1.0.0', fetchImpl, NO_ENV),
        (error: unknown) =>
          error instanceof RegistryLookupError && error.message.endsWith(`HTTP status ${status}`),
      );
    });
  }

  it('throws on a redirected response', async () => {
    await assertLookupFails(() => {
      const response = new Response(doc(), { status: 200 });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    });
  });

  it('throws on invalid JSON without echoing it', async () => {
    const { fetchImpl } = stubFetch(() => new Response('{"\u001b[2J', { status: 200 }));
    await assert.rejects(
      lookupPublished(CLIENT, '1.0.0', fetchImpl, NO_ENV),
      (error: unknown) =>
        error instanceof RegistryLookupError &&
        error.message.endsWith('invalid JSON') &&
        !error.message.includes('\u001b'),
    );
  });

  it('throws on a body over 1 MiB, streamed without a content-length', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        if (pulled > 1000) controller.close();
      },
    });
    await assertLookupFails(() => new Response(stream, { status: 200 }));
    assert.ok(pulled < 100, `read ${pulled} chunks before stopping`);
  });

  it('throws early on a content-length over 1 MiB', async () => {
    await assertLookupFails(
      () =>
        new Response(doc(), {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024) },
        }),
    );
  });

  it('throws on a bad body shape', async () => {
    const bodies = [
      '[]',
      'null',
      '"x"',
      doc({ dist: undefined }),
      doc({ dist: 'x' }),
      doc({ dist: {} }),
      doc({ dist: { integrity: 42 } }),
      doc({ dist: { integrity: 'sha1-abc' } }),
      doc({ dist: { integrity: `${INTEGRITY} ${OTHER}` } }),
      doc({ dist: { integrity: `${INTEGRITY}\u001b[2J` } }),
      doc({ dist: { shasum: 'abc' } }),
    ];
    for (const body of bodies) {
      await assertLookupFails(() => new Response(body, { status: 200 }));
    }
  });
});

describe('parsePublishedIntegrity (C6, C7)', () => {
  it('returns one sha512 value', () => {
    assert.equal(parsePublishedIntegrity(doc(), CLIENT, '1.0.0'), INTEGRITY);
  });

  it('requires the body to name the same package and version', () => {
    assert.throws(
      () => parsePublishedIntegrity(doc({ name: '@types/node' }), CLIENT, '1.0.0'),
      RegistryLookupError,
    );
    assert.throws(
      () => parsePublishedIntegrity(doc({ version: '1.0.1' }), CLIENT, '1.0.0'),
      RegistryLookupError,
    );
    assert.throws(
      () => parsePublishedIntegrity(doc({ name: undefined }), CLIENT, '1.0.0'),
      RegistryLookupError,
    );
  });
});

const OUT = '/work/.release-out';

function entry(name: string, file: string, integrity = INTEGRITY): DryRunEntry {
  return { name, version: '1.0.0', file, path: `${OUT}/${file}`, integrity };
}

const ENTRIES: DryRunEntry[] = [
  entry('@mosherw/sync-system-protocol', 'mosherw-sync-system-protocol-1.0.0.tgz'),
  entry('@mosherw/sync-system-client', 'mosherw-sync-system-client-1.0.0.tgz'),
  entry('@mosherw/sync-system-react', 'mosherw-sync-system-react-1.0.0.tgz'),
];

function recorder(answer: (name: string) => LookupResult | Promise<LookupResult>): {
  lookups: string[];
  publishes: (readonly string[])[];
  lines: string[];
  deps: Parameters<typeof dryRunPackages>[1];
} {
  const lookups: string[] = [];
  const publishes: (readonly string[])[] = [];
  const lines: string[] = [];
  return {
    lookups,
    publishes,
    lines,
    deps: {
      lookup: async (name, version) => {
        lookups.push(`${name}@${version}`);
        return answer(name);
      },
      publishDryRun: (args) => {
        publishes.push(args);
      },
      log: (line) => {
        lines.push(line);
      },
    },
  };
}

function publishArgs(file: string): string[] {
  return ['publish', `${OUT}/${file}`, '--dry-run', '--ignore-scripts', '--access', 'public'];
}

describe('dryRunPackages (#92 AC1-AC4)', () => {
  it('published and matching: no npm publish, no problems, integrity matches', async () => {
    const r = recorder(() => ({ published: true, integrity: INTEGRITY }));
    assert.deepEqual(await dryRunPackages(ENTRIES, r.deps), []);
    assert.deepEqual(r.publishes, []);
    assert.equal(r.lines.filter((l) => l.endsWith('already on npm, integrity matches')).length, 3);
    assert.deepEqual(
      r.lookups,
      ENTRIES.map((e) => `${e.name}@1.0.0`),
    );
  });

  it('published and different: a mismatch naming the file and both values', async () => {
    const r = recorder((name) => ({
      published: true,
      integrity: name === CLIENT ? OTHER : INTEGRITY,
    }));
    const problems = await dryRunPackages(ENTRIES, r.deps);
    assert.equal(problems.length, 1);
    const [problem] = problems;
    assert.ok(problem !== undefined);
    assert.ok(problem.startsWith('mosherw-sync-system-client-1.0.0.tgz: '));
    assert.ok(problem.includes(INTEGRITY) && problem.includes(OTHER));
    assert.ok(problem.includes(`${CLIENT}@1.0.0`));
    assert.deepEqual(r.publishes, []);
  });

  it('not published: npm publish --dry-run per package, in publish order (unchanged)', async () => {
    const r = recorder(() => ({ published: false }));
    assert.deepEqual(await dryRunPackages(ENTRIES, r.deps), []);
    assert.deepEqual(
      r.publishes,
      ENTRIES.map((e) => publishArgs(e.file)),
    );
  });

  it('mixed: protocol published and matching, client and react not', async () => {
    const r = recorder((name) =>
      name === '@mosherw/sync-system-protocol'
        ? { published: true, integrity: INTEGRITY }
        : { published: false },
    );
    assert.deepEqual(await dryRunPackages(ENTRIES, r.deps), []);
    assert.deepEqual(r.publishes, [
      publishArgs('mosherw-sync-system-client-1.0.0.tgz'),
      publishArgs('mosherw-sync-system-react-1.0.0.tgz'),
    ]);
    assert.equal(r.lines.filter((l) => l.endsWith('integrity matches')).length, 1);
  });

  it('a lookup error propagates and nothing after it is reported ok', async () => {
    const r = recorder((name) => {
      if (name === CLIENT) throw new RegistryLookupError('registry lookup failed: HTTP status 503');
      return { published: true, integrity: INTEGRITY };
    });
    await assert.rejects(dryRunPackages(ENTRIES, r.deps), RegistryLookupError);
    assert.equal(r.lines.length, 1);
    assert.ok(r.lines[0]?.includes('sync-system-protocol'));
    assert.deepEqual(r.lookups.length, 2);
    assert.deepEqual(r.publishes, []);
  });
});

describe('sha512Integrity', () => {
  it('equals the value in integrityLine for the same bytes', () => {
    const bytes = Buffer.from('some tarball bytes');
    assert.equal(integrityLine('x.tgz', bytes), `x.tgz ${sha512Integrity(bytes)}`);
    assert.match(sha512Integrity(bytes), /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });
});

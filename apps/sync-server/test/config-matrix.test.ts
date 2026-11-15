import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ENTRY_FIELDS } from '../src/config/apps-config.js';
import { KNOWN_SERVER_VARIABLES } from '../src/config/known-vars.js';
import { loadConfig } from '../src/config/load.js';
import { run } from '../src/main.js';
import type { SyncServer } from '../src/server.js';
import {
  ALL_CASES,
  APPS_CASES,
  CROSS_FIELD_CASES,
  type ConfigCase,
  ENV_CASES,
  GLOBAL_SENTINELS,
  STRONG,
  UNKNOWN_CASES,
  VALID_VALUES,
  baseApp,
  expectedProblems,
  materialize,
} from './config-cases.js';
import { LogCapture } from './helpers/log-capture.js';

let started: SyncServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
});

/** A port that was free a moment ago. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function runCase(c: ConfigCase) {
  const { env, path } = materialize(c);
  let stderr = '';
  const logs = new LogCapture();
  const result = await run(
    { PORT: String(await freePort()), ...env },
    { stderr: (text) => (stderr += text), destination: logs },
  );
  if (result.ok) started = result.server;
  return { result, stderr, logs, path };
}

async function expectCase(c: ConfigCase): Promise<void> {
  const { result, stderr, logs, path } = await runCase(c);
  expect(result, c.id).toEqual({ ok: false, exitCode: 1 });
  expect(stderr, c.id).toBe(
    expectedProblems(c, path)
      .map((problem) => `Config error: ${problem}\n`)
      .join(''),
  );
  // Nothing that depends on config ran: no logger output at all (security C1).
  expect(logs.text, c.id).toBe('');
  for (const sentinel of [...c.sentinels, ...GLOBAL_SENTINELS]) {
    expect(stderr, `${c.id}: ${sentinel}`).not.toContain(sentinel);
    expect(logs.text, `${c.id}: ${sentinel}`).not.toContain(sentinel);
  }
}

describe('every env variable (#36 AC37)', () => {
  for (const c of ENV_CASES) {
    it(`${c.id}: Config error naming ${c.target}, no value echoed, exit 1`, async () => {
      await expectCase(c);
      for (const problem of c.problems) expect(problem).toContain(c.target);
    });
  }

  it('has a case for every known variable except NODE_ENV (coverage guard)', () => {
    const covered = new Set(ENV_CASES.map((c) => c.target));
    const missing = KNOWN_SERVER_VARIABLES.filter(
      (name) => name !== 'NODE_ENV' && !covered.has(name),
    );
    expect(missing).toEqual([]);
  });
});

describe('every apps-config field and the file structure (#36 AC37)', () => {
  for (const c of APPS_CASES) {
    it(`${c.id}: Config error with the JSON path, no value echoed, exit 1`, async () => {
      await expectCase(c);
    });
  }

  it('names the JSON path of the field in every field case', () => {
    for (const c of APPS_CASES.filter((x) => APP_ENTRY_FIELDS.includes(x.target))) {
      for (const problem of c.problems) {
        expect(problem, c.id).toMatch(/^<path>: apps\[\d+\]/);
        expect(problem, c.id).toContain(c.target);
      }
    }
  });

  it('has a case for every apps entry field (coverage guard)', () => {
    const covered = new Set(APPS_CASES.map((c) => c.target));
    expect(APP_ENTRY_FIELDS.filter((field) => !covered.has(field))).toEqual([]);
    expect(APP_ENTRY_FIELDS).toHaveLength(15);
  });
});

describe('rules that span fields say what to change (#36 AC38)', () => {
  for (const c of CROSS_FIELD_CASES) {
    it(`${c.id}`, async () => {
      await expectCase(c);
    });
  }
});

describe('unknown look-alike variables (#36 AC37a)', () => {
  for (const c of UNKNOWN_CASES) {
    it(`${c.id}`, async () => {
      await expectCase(c);
    });
  }
});

describe('every problem in one run (#36 AC38)', () => {
  it('prints env, Redis, secret, unknown-name and apps-file problems together, one line each', async () => {
    const c: ConfigCase = {
      id: 'combined',
      target: 'all',
      env: {
        MAX_GROUP_SIZE_CEILING: 'SENTINEL-a',
        REDIS_URL: 'http://SENTINELU:SENTINELP@sentinel-h',
        TOKEN_SECRET_PREVIOUS: 'SENTINEL-p',
        TOKEN_SECERT: 'SENTINEL-t',
      },
      apps: {
        kind: 'json',
        value: { apps: [baseApp({ maxGroupSize: 999, maxMessageBytes: 'SENTINEL-m' })] },
      },
      sentinels: [
        'SENTINEL-a',
        'SENTINELU',
        'SENTINELP',
        'sentinel-h',
        'SENTINEL-p',
        'SENTINEL-t',
        'SENTINEL-m',
      ],
      problems: [
        'MAX_GROUP_SIZE_CEILING must be a positive integer',
        'REDIS_URL is not a valid redis:// or rediss:// URL',
        'TOKEN_SECRET_PREVIOUS must be at least 32 bytes (use `openssl rand -base64 32`)',
        'TOKEN_SECERT is not a sync server variable; did you mean TOKEN_SECRET?',
        '<path>: apps[0] (namespace "matrix-app"): maxMessageBytes must be an integer',
      ],
    };
    await expectCase(c);
  });

  it('an invalid ceiling skips only its own app comparison and is reported (Q-4)', async () => {
    await expectCase({
      id: 'invalid ceiling',
      target: 'MAX_GROUP_SIZE_CEILING',
      env: { MAX_GROUP_SIZE_CEILING: '0' },
      apps: {
        kind: 'json',
        value: { apps: [baseApp({ maxGroupSize: 999, maxConnections: 99999 })] },
      },
      sentinels: [],
      problems: [
        'MAX_GROUP_SIZE_CEILING must be a positive integer',
        '<path>: apps[0] (namespace "matrix-app"): maxConnections 99999 exceeds MAX_APP_CONNECTIONS_CEILING 10000 (lower maxConnections or raise MAX_APP_CONNECTIONS_CEILING)',
      ],
    });
  });
});

describe('secret-bearing variables fail closed (#36 security C1)', () => {
  const secretCases = ALL_CASES.filter((c) =>
    ['TOKEN_SECRET', 'TOKEN_SECRET_PREVIOUS', 'REDIS_URL', 'apiKey'].includes(c.target),
  );

  it('covers each secret rule', () => {
    expect(secretCases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'TOKEN_SECRET short',
        'TOKEN_SECRET_PREVIOUS equal to TOKEN_SECRET',
        'REDIS_URL wrong scheme',
        'TOKEN_SECRET dev secret in production',
        'REDIS_URL dev password in production',
        'dev API key outside development',
      ]),
    );
  });

  for (const c of secretCases) {
    it(`${c.id}: exit 1 and nothing listens`, async () => {
      const { result, logs } = await runCase(c);
      expect(result.ok).toBe(false);
      expect(logs.find('server_listening')).toBeUndefined();
    });
  }
});

describe('valid values keep working (#36 AC41)', () => {
  const base = { NODE_ENV: 'test', TOKEN_SECRET: STRONG };

  it('accepts every known variable at its documented default and a valid non-default', () => {
    const { env } = materialize({ id: 'valid', target: 'valid', sentinels: [], problems: [] });
    for (const name of KNOWN_SERVER_VARIABLES) {
      for (const value of VALID_VALUES[name]) {
        expect(
          () => loadConfig({ ...env, ...base, [name]: value }),
          `${name}=${value}`,
        ).not.toThrow();
      }
    }
    // SYNC_CONFIG_PATH is the materialized path itself.
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('lists valid values for every known variable (coverage guard)', () => {
    expect(Object.keys(VALID_VALUES).sort()).toEqual([...KNOWN_SERVER_VARIABLES].sort());
  });
});

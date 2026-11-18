// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../server/run.js';
import { KNOWN_READER_VARIABLES } from '../src/config/known-vars.js';
import {
  API_KEY,
  GLOBAL_SENTINELS,
  LIBRARY_IDS,
  READER_CASES,
  type ReaderCase,
} from './config-cases.js';
import { makeDist } from './helpers/server.js';

const dist = makeDist(LIBRARY_IDS.map((contentId) => ({ contentId, dir: 'ltr' as const })));
const empty = makeDist([]);

afterAll(() => {
  dist.cleanup();
  empty.cleanup();
});

async function runCase(c: ReaderCase) {
  let stderr = '';
  let stdout = '';
  const result = await run(
    { PORT: '0', HOST: '127.0.0.1', ...c.env },
    {
      distDir: c.ids?.length === 0 ? empty.dir : dist.dir,
      stderr: (text) => (stderr += text),
      stdout: (text) => (stdout += text),
    },
  );
  if (result.ok) await result.close();
  return { result, stderr, stdout };
}

describe('every reader variable (#36 AC39)', () => {
  for (const c of READER_CASES) {
    it(`${c.id}: Config error naming the variable, exit 1`, async () => {
      const { result, stderr, stdout } = await runCase(c);
      expect(result).toEqual({ ok: false, exitCode: 1 });
      expect(stderr).toBe(c.problems.map((problem) => `Config error: ${problem}\n`).join(''));
      expect(stdout).toBe('');
      for (const sentinel of [...c.sentinels, ...GLOBAL_SENTINELS]) {
        expect(stderr, sentinel).not.toContain(sentinel);
      }
      if (c.target !== 'unknown') {
        for (const problem of c.problems) expect(problem).toContain(c.target);
      }
    });
  }

  it('has a case for every READER_ variable and PORT (coverage guard)', () => {
    const covered = new Set<string>(READER_CASES.map((c) => c.target));
    const missing = [...KNOWN_READER_VARIABLES, 'PORT'].filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  it('truncates non-secret values and never quotes the API key (Q24)', () => {
    const truncated = READER_CASES.find((c) => c.id === 'READER_ENTRY unknown, truncated echo')!;
    expect(truncated.problems[0]).toMatch(/"[^"]{40}…"/);
    for (const c of READER_CASES) {
      for (const problem of c.problems) expect(problem).not.toContain(API_KEY);
    }
  });
});

describe('every reader problem in one run (#36 AC39, AC38)', () => {
  it('prints every problem, one prefixed line each, and exits 1', async () => {
    const { result, stderr } = await runCase({
      id: 'combined',
      target: 'unknown',
      env: {
        READER_ENTRY: 'x',
        READER_UI_LANG: 'fr',
        READER_SYNC_URL: 'wss://SENTINELSU:SENTINELSP@sync.example.org/ws',
        READER_SYNC_API_KEY: 'SENTINEL bad key',
        PORT: '-1',
        READER_SYNC_ULR: 'x',
      },
      sentinels: [],
      problems: [],
    });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr.trimEnd().split('\n')).toEqual([
      'Config error: READER_ENTRY "x" must be one of: library, error, default-book, single-book',
      'Config error: READER_UI_LANG "fr" must be one of: auto, en, he',
      'Config error: READER_SYNC_URL "wss://***@sync.example.org/ws" must not contain a user name or password',
      'Config error: READER_SYNC_API_KEY must be 32 to 256 visible ASCII characters with no spaces (the value is not shown)',
      'Config error: PORT "-1" must be an integer from 0 to 65535',
      'Config error: READER_SYNC_ULR is not a reader variable; did you mean READER_SYNC_URL?',
    ]);
    for (const sentinel of ['SENTINELSU', 'SENTINELSP', 'SENTINEL bad key']) {
      expect(stderr).not.toContain(sentinel);
    }
  });
});

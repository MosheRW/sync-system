import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import {
  DEV_TOKEN_SECRET,
  PUBLIC_EXAMPLE_SECRETS,
  type TokenSecrets,
  parseTokenSecrets,
  warnAboutSecrets,
} from '../src/config/token-secret.js';
import { expectNoSentinel, secretFileDir } from './helpers/secret-files.js';

/** openssl-style values (base64 of 32 random bytes). Test-only, never real. */
const STRONG = 'q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=';
const STRONG_2 = 'Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo4=';

function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('parseTokenSecrets: environments (Q-A)', () => {
  it('requires TOKEN_SECRET unless NODE_ENV is exactly development or test', () => {
    for (const nodeEnv of ['production', undefined, 'staging', 'Development', 'test ']) {
      expect(configError(() => parseTokenSecrets({}, nodeEnv))).toMatch(
        /^TOKEN_SECRET is required/,
      );
    }
  });

  it('uses a random 32-byte secret per call in development and test', () => {
    for (const nodeEnv of ['development', 'test']) {
      const a = parseTokenSecrets({}, nodeEnv);
      const b = parseTokenSecrets({}, nodeEnv);
      expect(a.source).toBe('random');
      expect(a.current).toHaveLength(32);
      expect(a.current.equals(b.current)).toBe(false);
    }
  });

  it('accepts the dev secret only in development and test', () => {
    expect(parseTokenSecrets({ TOKEN_SECRET: DEV_TOKEN_SECRET }, 'test').source).toBe('dev');
    for (const nodeEnv of ['production', undefined, 'staging']) {
      const message = configError(() =>
        parseTokenSecrets({ TOKEN_SECRET: DEV_TOKEN_SECRET }, nodeEnv),
      );
      expect(message).toContain('TOKEN_SECRET is the public development secret');
      expect(message).not.toContain(DEV_TOKEN_SECRET);
    }
  });

  it('uses a set secret byte for byte in production', () => {
    const secrets = parseTokenSecrets({ TOKEN_SECRET: STRONG }, 'production');
    expect(secrets).toEqual({ current: Buffer.from(STRONG, 'utf8'), source: 'env' });
  });
});

describe('parseTokenSecrets: strength rules (AC1, M3)', () => {
  const refused: Array<[string, string, RegExp]> = [
    ['31 bytes', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1d', /at least 32 bytes/],
    ['a repeated character', 'a'.repeat(40), /looks weak/],
    ['a repeated short word', 'secret'.repeat(7), /looks weak/],
    ['a docs example', PUBLIC_EXAMPLE_SECRETS[0]!, /example value from the docs/],
    ['leading whitespace', ` ${STRONG}`, /must not start or end with whitespace/],
    ['a trailing newline', `${STRONG}\n`, /must not start or end with whitespace/],
    ['an empty value', '', /at least 32 bytes/],
  ];

  for (const [label, value, rule] of refused) {
    it(`refuses ${label} in every environment, without echoing it`, () => {
      for (const nodeEnv of ['production', 'development', 'test', undefined]) {
        const message = configError(() => parseTokenSecrets({ TOKEN_SECRET: value }, nodeEnv));
        expect(message).toMatch(rule);
        expect(message).toContain('TOKEN_SECRET');
        if (value.trim().length > 0) expect(message).not.toContain(value.trim());
      }
    });
  }

  it('counts bytes, not characters', () => {
    // 16 two-byte characters = 32 bytes (17 distinct byte values).
    const value = 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏ';
    expect(Buffer.byteLength(value)).toBe(32);
    expect(parseTokenSecrets({ TOKEN_SECRET: value }, 'production').current).toHaveLength(32);
  });

  it('accepts openssl-style secrets', () => {
    expect(parseTokenSecrets({ TOKEN_SECRET: STRONG }, 'production').source).toBe('env');
    expect(parseTokenSecrets({ TOKEN_SECRET: STRONG_2 }, undefined).source).toBe('env');
  });
});

describe('parseTokenSecrets: previous secret (AC2)', () => {
  it('reads TOKEN_SECRET_PREVIOUS for verification', () => {
    const secrets = parseTokenSecrets(
      { TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS: STRONG_2 },
      'production',
    );
    expect(secrets.previous?.toString('utf8')).toBe(STRONG_2);
  });

  it('applies the same rules and must differ from the current secret', () => {
    expect(
      configError(() =>
        parseTokenSecrets({ TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS: 'short' }, 'production'),
      ),
    ).toContain('TOKEN_SECRET_PREVIOUS must be at least 32 bytes');
    expect(
      configError(() =>
        parseTokenSecrets(
          { TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS: DEV_TOKEN_SECRET },
          'production',
        ),
      ),
    ).toContain('TOKEN_SECRET_PREVIOUS is the public development secret');
    expect(
      configError(() =>
        parseTokenSecrets({ TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS: STRONG }, 'production'),
      ),
    ).toBe('TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET');
  });

  it('reports every problem at once', () => {
    const message = configError(() =>
      parseTokenSecrets({ TOKEN_SECRET_PREVIOUS: 'x' }, 'production'),
    );
    expect(message.split('\n')).toHaveLength(2);
  });
});

describe('warnAboutSecrets (AC3, M1)', () => {
  function warnings(secrets: TokenSecrets): Array<{ obj: object; msg: string }> {
    const out: Array<{ obj: object; msg: string }> = [];
    warnAboutSecrets(secrets, {
      info: () => undefined,
      warn: (obj, msg) => out.push({ obj, msg }),
    });
    return out;
  }

  it('warns for a random secret, the dev secret and a set previous secret', () => {
    const random = parseTokenSecrets({}, 'test');
    expect(warnings(random).map((w) => w.obj)).toEqual([{ event: 'token_secret_random' }]);
    expect(warnings(random)[0]!.msg).toContain('will not survive a restart');
    const dev = parseTokenSecrets(
      { TOKEN_SECRET: DEV_TOKEN_SECRET, TOKEN_SECRET_PREVIOUS: STRONG },
      'development',
    );
    expect(warnings(dev).map((w) => w.obj)).toEqual([
      { event: 'dev_token_secret' },
      { event: 'token_secret_previous_set' },
    ]);
    expect(JSON.stringify(warnings(dev))).not.toContain(STRONG);
  });

  it('is silent for a plain env secret', () => {
    expect(warnings(parseTokenSecrets({ TOKEN_SECRET: STRONG }, 'production'))).toEqual([]);
  });
});

/** Test-only values; never real. A sentinel that is also strong enough to pass. */
const FILE_SECRET = 'SENTINEL-file-Qm7Zx2Lv9Kd4Rt8Wn3Hb6Jf1Pc0Ys5';
const FILE_SECRET_2 = 'SENTINEL-file2-Hb6Jf1Pc0Ys5Qm7Zx2Lv9Kd4Rt8Wn';

const files = secretFileDir('sync-token-file-');
afterAll(() => files.cleanup());

let fileCount = 0;
function secretFile(content: string): string {
  fileCount += 1;
  return files.file(`secret-${fileCount}`, content);
}

/** Every text form of the result and of the problems; must hold no sentinel (AC7, C9). */
function everyForm(fn: () => unknown): string {
  try {
    const result = fn();
    return [JSON.stringify(result), inspect(result, { depth: 5 }), String(result)].join('\n');
  } catch (err) {
    return [(err as Error).message, inspect(err)].join('\n');
  }
}

describe('parseTokenSecrets: _FILE variables (#58 AC1, AC2, AC5, AC9)', () => {
  it('reads TOKEN_SECRET from TOKEN_SECRET_FILE, one trailing newline removed', () => {
    for (const content of [FILE_SECRET, `${FILE_SECRET}\n`, `${FILE_SECRET}\r\n`]) {
      const secrets = parseTokenSecrets({ TOKEN_SECRET_FILE: secretFile(content) }, 'production');
      expect(secrets.source).toBe('file');
      expect(secrets.current.toString('utf8')).toBe(FILE_SECRET);
      expect(secrets.previous).toBeUndefined();
    }
  });

  it('reads TOKEN_SECRET_PREVIOUS from a file, with either source of the current secret', () => {
    const previousFile = secretFile(`${FILE_SECRET_2}\n`);
    const fromEnv = parseTokenSecrets(
      { TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS_FILE: previousFile },
      'production',
    );
    expect(fromEnv.source).toBe('env');
    expect(fromEnv.previous?.toString('utf8')).toBe(FILE_SECRET_2);
    const fromFile = parseTokenSecrets(
      { TOKEN_SECRET_FILE: secretFile(FILE_SECRET), TOKEN_SECRET_PREVIOUS: STRONG_2 },
      'production',
    );
    expect(fromFile.source).toBe('file');
    expect(fromFile.previous?.toString('utf8')).toBe(STRONG_2);
  });

  const GENERATE = 'use `openssl rand -base64 32`';
  const refused: Array<[string, string, string]> = [
    ['31 bytes', 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1d', `must be at least 32 bytes (${GENERATE})`],
    ['a repeated character', 'a'.repeat(40), `looks weak; ${GENERATE}`],
    [
      'a docs example',
      PUBLIC_EXAMPLE_SECRETS[0]!,
      `is an example value from the docs; ${GENERATE}`,
    ],
    ['a leading space', ` ${FILE_SECRET}`, 'must not start or end with whitespace'],
    ['a trailing space', `${FILE_SECRET} \n`, 'must not start or end with whitespace'],
    ['a leading tab', `\t${FILE_SECRET}`, 'must not start or end with whitespace'],
    ['two trailing newlines', `${FILE_SECRET}\n\n`, 'must not start or end with whitespace'],
    ['a lone trailing CR', `${FILE_SECRET}\r`, 'must not start or end with whitespace'],
    ['a BOM', `\uFEFF${FILE_SECRET}`, 'must not start or end with whitespace'],
  ];

  for (const [label, content, rule] of refused) {
    it(`refuses ${label} from a file with the (from X_FILE) label, in every environment`, () => {
      for (const nodeEnv of ['production', 'development', 'test', undefined]) {
        const current = configError(() =>
          parseTokenSecrets({ TOKEN_SECRET_FILE: secretFile(content) }, nodeEnv),
        );
        expect(current).toBe(`TOKEN_SECRET (from TOKEN_SECRET_FILE) ${rule}`);
        const previous = configError(() =>
          parseTokenSecrets(
            { TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS_FILE: secretFile(content) },
            nodeEnv,
          ),
        );
        expect(previous).toBe(`TOKEN_SECRET_PREVIOUS (from TOKEN_SECRET_PREVIOUS_FILE) ${rule}`);
        expectNoSentinel(current + previous, FILE_SECRET);
      }
    });
  }

  it('keeps the env messages byte-identical (AC13)', () => {
    expect(configError(() => parseTokenSecrets({ TOKEN_SECRET: 'short' }, 'production'))).toBe(
      'TOKEN_SECRET must be at least 32 bytes (use `openssl rand -base64 32`)',
    );
  });

  it('accepts the dev secret from a file only in development and test', () => {
    const path = secretFile(`${DEV_TOKEN_SECRET}\n`);
    expect(parseTokenSecrets({ TOKEN_SECRET_FILE: path }, 'test').source).toBe('dev');
    expect(parseTokenSecrets({ TOKEN_SECRET_FILE: path }, 'development').source).toBe('dev');
    expect(configError(() => parseTokenSecrets({ TOKEN_SECRET_FILE: path }, 'production'))).toBe(
      'TOKEN_SECRET (from TOKEN_SECRET_FILE) is the public development secret; use `openssl rand -base64 32`',
    );
  });

  it('compares the previous secret with the current one across sources', () => {
    const same = secretFile(`${FILE_SECRET}\n`);
    for (const env of [
      { TOKEN_SECRET: FILE_SECRET, TOKEN_SECRET_PREVIOUS_FILE: same },
      { TOKEN_SECRET_FILE: same, TOKEN_SECRET_PREVIOUS: FILE_SECRET },
      { TOKEN_SECRET_FILE: same, TOKEN_SECRET_PREVIOUS_FILE: secretFile(FILE_SECRET) },
    ]) {
      expect(configError(() => parseTokenSecrets(env, 'production'))).toBe(
        'TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET',
      );
    }
  });

  it('a bad TOKEN_SECRET_FILE fails closed in development and test, never random (C3)', () => {
    for (const nodeEnv of ['development', 'test']) {
      for (const env of [
        { TOKEN_SECRET_FILE: '' },
        { TOKEN_SECRET_FILE: join(files.dir, 'missing') },
        { TOKEN_SECRET_FILE: secretFile('') },
        { TOKEN_SECRET_FILE: secretFile('\n') },
        { TOKEN_SECRET_FILE: files.dir },
        { TOKEN_SECRET: '', TOKEN_SECRET_FILE: secretFile(FILE_SECRET) },
      ]) {
        expect(() => parseTokenSecrets(env, nodeEnv)).toThrow(ConfigError);
      }
    }
  });

  it('reports both-set conflicts and file problems with the other problems', () => {
    const message = configError(() =>
      parseTokenSecrets(
        {
          TOKEN_SECRET: FILE_SECRET,
          TOKEN_SECRET_FILE: secretFile(FILE_SECRET),
          TOKEN_SECRET_PREVIOUS_FILE: '',
        },
        'production',
      ),
    );
    expect(message.split('\n')).toEqual([
      'TOKEN_SECRET and TOKEN_SECRET_FILE are both set; set only one',
      'TOKEN_SECRET_PREVIOUS_FILE must not be empty',
    ]);
    expectNoSentinel(message, FILE_SECRET);
  });

  it('never shows a secret in the result or a problem, on any path (AC7, C7, C9)', () => {
    const good = secretFile(`${FILE_SECRET}\n`);
    const goodPrevious = secretFile(`${FILE_SECRET_2}\n`);
    for (const fn of [
      () => parseTokenSecrets({ TOKEN_SECRET_FILE: good }, 'production'),
      () =>
        parseTokenSecrets(
          { TOKEN_SECRET_FILE: good, TOKEN_SECRET_PREVIOUS_FILE: goodPrevious },
          'production',
        ),
      () =>
        parseTokenSecrets(
          { TOKEN_SECRET: FILE_SECRET, TOKEN_SECRET_PREVIOUS: FILE_SECRET_2 },
          'production',
        ),
      () => parseTokenSecrets({ TOKEN_SECRET_FILE: secretFile(` ${FILE_SECRET}`) }, 'production'),
      () => parseTokenSecrets({ TOKEN_SECRET_FILE: secretFile(`${FILE_SECRET}\0`) }, 'production'),
      () => parseTokenSecrets({ TOKEN_SECRET_FILE: FILE_SECRET }, 'production'),
      () => parseTokenSecrets({ TOKEN_SECRET_FILE: `x/${FILE_SECRET}/y==` }, 'production'),
    ]) {
      const text = everyForm(fn);
      expectNoSentinel(text, FILE_SECRET);
      expectNoSentinel(text, FILE_SECRET_2);
    }
  });

  it('redacts the secrets in JSON, string and inspect output but keeps the Buffers (C7)', () => {
    const secrets = parseTokenSecrets(
      { TOKEN_SECRET_FILE: secretFile(FILE_SECRET), TOKEN_SECRET_PREVIOUS: FILE_SECRET_2 },
      'production',
    );
    expect(JSON.stringify(secrets)).toBe('"[redacted token secrets]"');
    expect(JSON.stringify({ tokenSecrets: secrets })).toBe(
      '{"tokenSecrets":"[redacted token secrets]"}',
    );
    expect((secrets as { toString(): string }).toString()).toBe('[redacted token secrets]');
    expect(`${secrets as unknown as string}`).toBe('[redacted token secrets]');
    expect(inspect(secrets)).toBe('[redacted token secrets]');
    expect(inspect({ nested: { secrets } }, { depth: 5 })).not.toContain('Buffer');
    expect(Buffer.isBuffer(secrets.current)).toBe(true);
    expect(secrets.current.toString('utf8')).toBe(FILE_SECRET);
    expect(Object.keys(secrets).sort()).toEqual(['current', 'previous', 'source']);
    expect(Object.isFrozen(secrets)).toBe(true);
  });
});

describe('warnAboutSecrets: token_secret_source (#58 AC9, Q5, C6)', () => {
  function logged(secrets: TokenSecrets) {
    const info: object[] = [];
    const warn: object[] = [];
    warnAboutSecrets(secrets, {
      info: (obj) => info.push(obj),
      warn: (obj) => warn.push(obj),
    });
    return { info, warn };
  }

  it('logs the source once at info, with no path, value or length', () => {
    const cases: Array<[TokenSecrets, string]> = [
      [parseTokenSecrets({ TOKEN_SECRET: STRONG }, 'production'), 'env'],
      [parseTokenSecrets({ TOKEN_SECRET_FILE: secretFile(FILE_SECRET) }, 'production'), 'file'],
      [parseTokenSecrets({ TOKEN_SECRET_FILE: secretFile(DEV_TOKEN_SECRET) }, 'test'), 'dev'],
      [parseTokenSecrets({ TOKEN_SECRET: DEV_TOKEN_SECRET }, 'test'), 'dev'],
      [parseTokenSecrets({}, 'test'), 'random'],
    ];
    for (const [secrets, source] of cases) {
      const { info } = logged(secrets);
      expect(info).toEqual([{ event: 'token_secret_source', source }]);
      expectNoSentinel(JSON.stringify(info), FILE_SECRET);
    }
  });

  it('still warns about a previous secret read from a file', () => {
    const secrets = parseTokenSecrets(
      {
        TOKEN_SECRET_FILE: secretFile(FILE_SECRET),
        TOKEN_SECRET_PREVIOUS_FILE: secretFile(FILE_SECRET_2),
      },
      'production',
    );
    const { warn } = logged(secrets);
    expect(warn).toEqual([{ event: 'token_secret_previous_set' }]);
    expectNoSentinel(JSON.stringify(warn), FILE_SECRET_2);
  });
});

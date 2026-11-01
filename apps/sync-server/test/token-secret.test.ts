import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import {
  DEV_TOKEN_SECRET,
  PUBLIC_EXAMPLE_SECRETS,
  type TokenSecrets,
  parseTokenSecrets,
  warnAboutSecrets,
} from '../src/config/token-secret.js';

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
    warnAboutSecrets(secrets, { warn: (obj, msg) => out.push({ obj, msg }) });
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

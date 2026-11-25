// The operator guide's env reference equals what the parser enforces (#37
// AC45): every known variable is listed once, and each numeric variable's
// default, minimum and maximum cells equal the parser's own bound tables.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOIN_METHODS } from '@mosherw/sync-system-protocol';
import { NUMERIC_VARS, collectEnv, type NumericVar } from '../src/config/env.js';
import { KNOWN_SERVER_VARIABLES } from '../src/config/known-vars.js';
import {
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_REDIS_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_REDIS_KEY_PREFIX,
  REDIS_COMMAND_TIMEOUT_MS_MAX,
  REDIS_COMMAND_TIMEOUT_MS_MIN,
  REDIS_CONNECT_TIMEOUT_SECONDS_MAX,
  REDIS_CONNECT_TIMEOUT_SECONDS_MIN,
} from '../src/config/redis.js';

const guide = readFileSync(new URL('../../../docs/operator-guide.md', import.meta.url), 'utf8');
const section = guide.slice(
  guide.indexOf('## Environment variables'),
  guide.indexOf('## Storage (Redis)'),
);

interface Row {
  defaultValue: string;
  min: string;
  max: string;
}

/** `| \`NAME\` | default | min | max | purpose |` rows of the env table. */
const rows = new Map<string, Row>();
for (const line of section.split(/\r?\n/)) {
  const match = /^\| `([A-Z][A-Z0-9_]*)` +\|(.*)\|$/.exec(line);
  if (match === null) continue;
  const cells = (match[2] ?? '').split('|').map((cell) => cell.trim());
  expect(cells.length, line).toBe(4);
  expect(rows.has(match[1] ?? ''), `duplicate row ${match[1]}`).toBe(false);
  rows.set(match[1] ?? '', {
    defaultValue: cells[0] ?? '',
    min: cells[1] ?? '',
    max: cells[2] ?? '',
  });
}

const code = (value: number | string): string => `\`${value}\``;

/** The Redis numeric variables, bounded in redis.ts rather than NUMERIC_VARS. */
const REDIS_NUMERIC: ReadonlyArray<
  Pick<NumericVar, 'defaultValue' | 'min' | 'max'> & { name: string }
> = [
  {
    name: 'REDIS_CONNECT_TIMEOUT_SECONDS',
    defaultValue: DEFAULT_REDIS_CONNECT_TIMEOUT_SECONDS,
    min: REDIS_CONNECT_TIMEOUT_SECONDS_MIN,
    max: REDIS_CONNECT_TIMEOUT_SECONDS_MAX,
  },
  {
    name: 'REDIS_COMMAND_TIMEOUT_MS',
    defaultValue: DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    min: REDIS_COMMAND_TIMEOUT_MS_MIN,
    max: REDIS_COMMAND_TIMEOUT_MS_MAX,
  },
];
const NUMERIC = [...NUMERIC_VARS, ...REDIS_NUMERIC];

function problemsFor(env: Record<string, string>): string[] {
  const problems: string[] = [];
  collectEnv(env, problems);
  return problems;
}

describe('env reference in docs/operator-guide.md (#37 AC45)', () => {
  it('lists exactly the known server variables, once each', () => {
    expect([...rows.keys()].sort()).toEqual([...KNOWN_SERVER_VARIABLES].sort());
  });

  it.each(NUMERIC.map((v) => [v.name, v] as const))(
    '%s: default, min and max equal the parser',
    (name, variable) => {
      const row = rows.get(name);
      expect(row, name).toBeDefined();
      expect(row?.defaultValue).toBe(code(variable.defaultValue));
      expect(row?.min).toBe(code(variable.min ?? 1));
      expect(row?.max).toBe(variable.max === undefined ? 'none' : code(variable.max));
    },
  );

  it('shows the parser defaults of the string variables, and no bounds', () => {
    const expected: Record<string, string> = {
      SYNC_CONFIG_PATH: code('./config/apps.json'),
      HOST: code('0.0.0.0'),
      LOG_LEVEL: code('info'),
      JOIN_METHODS_ALLOWED: code(JOIN_METHODS.join(',')),
      REDIS_KEY_PREFIX: code(DEFAULT_REDIS_KEY_PREFIX),
      NODE_ENV: 'unset',
      TOKEN_SECRET: 'none',
      TOKEN_SECRET_PREVIOUS: 'unset',
      TOKEN_SECRET_FILE: 'unset',
      TOKEN_SECRET_PREVIOUS_FILE: 'unset',
      REDIS_URL: 'unset',
    };
    const numeric = new Set(NUMERIC.map((v) => v.name));
    const strings = KNOWN_SERVER_VARIABLES.filter((name) => !numeric.has(name));
    expect([...strings].sort()).toEqual(Object.keys(expected).sort());
    for (const name of strings) {
      expect(rows.get(name)?.defaultValue, name).toBe(expected[name]);
      expect(rows.get(name)?.min, name).toBe('-');
      expect(rows.get(name)?.max, name).toBe('-');
    }
  });

  it('matches the defaults the parser applies to an empty env', () => {
    const problems: string[] = [];
    const { env } = collectEnv({ NODE_ENV: 'test' }, problems);
    expect(problems).toEqual([]);
    expect(env?.configPath).toBe('./config/apps.json');
    expect(env?.host).toBe('0.0.0.0');
    expect(env?.logLevel).toBe('info');
    expect(env?.joinMethodsAllowed).toEqual(JOIN_METHODS);
  });

  // Behavioural spot checks: one below the minimum and one above the maximum
  // are a Config error naming the variable (invalid values skip cross rules).
  it.each(NUMERIC.map((v) => [v.name, v] as const))(
    '%s: out-of-range values are refused',
    (name, variable) => {
      const min = variable.min ?? 1;
      const below = problemsFor({ [name]: String(min - 1) });
      expect(
        below.some((problem) => problem.startsWith(name)),
        below.join('\n'),
      ).toBe(true);
      if (variable.max !== undefined) {
        const above = problemsFor({ [name]: String(variable.max + 1) });
        expect(
          above.some((problem) => problem.startsWith(name)),
          above.join('\n'),
        ).toBe(true);
        expect(
          problemsFor({ [name]: String(variable.max) }).filter((p) => p.startsWith(name)),
        ).toEqual([]);
      }
    },
  );
});

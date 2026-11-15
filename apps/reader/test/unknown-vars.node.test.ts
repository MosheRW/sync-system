// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import {
  KNOWN_READER_VARIABLES,
  PLATFORM_SUFFIXES,
  collectUnknownReaderVariables,
  unknownReaderVariables,
} from '../src/config/known-vars.js';
import { type EnvSource, parseReaderConfig } from '../src/config/schema.js';

const IDS = ['samples/psalms-he'];
const HINT = 'remove it or fix the name (see "Configuration" in apps/reader/README.md)';
const repoRoot = join(import.meta.dirname, '..', '..', '..');

function problemsOf(env: EnvSource): string[] {
  const problems: string[] = [];
  collectUnknownReaderVariables(env, problems);
  return problems;
}

function configProblems(env: EnvSource): readonly string[] {
  try {
    parseReaderConfig(env, IDS);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('unknown READER_ variables (#36 Gate 2 Q-2, ADR 0015)', () => {
  it('flags a typo with a suggestion and never prints the value', () => {
    const problems = configProblems({ READER_SYNC_ULR: 'wss://SENTINEL.example.org/ws' });
    expect(problems).toEqual([
      'READER_SYNC_ULR is not a reader variable; did you mean READER_SYNC_URL?',
    ]);
    expect(problems.join('\n')).not.toContain('SENTINEL');
  });

  it('reports the unknown name together with the other problems', () => {
    expect(configProblems({ READER_ENTRY: 'nope', READER_LIBARY: 'on' })).toEqual([
      'READER_ENTRY "nope" must be one of: library, error, default-book, single-book',
      'READER_LIBARY is not a reader variable; did you mean READER_LIBRARY?',
    ]);
  });

  it('flags look-alikes without a suggestion, lower case included, sorted', () => {
    expect(problemsOf({ READER_THEME: 'dark', reader_book: 'x' })).toEqual([
      `READER_THEME is not a reader variable; ${HINT}`,
      'reader_book is not a reader variable; did you mean READER_BOOK?',
    ]);
  });

  it('cuts a long name at 48 characters', () => {
    const name = `READER_${'X'.repeat(60)}`;
    expect(problemsOf({ [name]: '1' })).toEqual([
      `${name.slice(0, 48)}... is not a reader variable; ${HINT}`,
    ]);
  });

  it('never flags the known variables, other families or unset entries', () => {
    expect(KNOWN_READER_VARIABLES).toHaveLength(11);
    const known = Object.fromEntries(KNOWN_READER_VARIABLES.map((name) => [name, 'x']));
    expect(
      unknownReaderVariables({
        ...known,
        PORT: '8080',
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
        NODE_VERSION: '24',
        MAX_GROUP_SIZE_CIELING: '1',
        READER_UNSET: undefined,
      }),
    ).toEqual([]);
  });

  it('does not flag Kubernetes service links or Docker link names of a service named reader', () => {
    expect(
      problemsOf({
        READER_SERVICE_HOST: '10.0.0.1',
        READER_SERVICE_PORT: '8080',
        READER_SERVICE_PORT_HTTP: '8080',
        READER_PORT: 'tcp://10.0.0.1:8080',
        READER_PORT_8080_TCP: 'tcp://10.0.0.1:8080',
        READER_PORT_8080_TCP_ADDR: '10.0.0.1',
        READER_PORT_8080_TCP_PORT: '8080',
        READER_PORT_8080_TCP_PROTO: 'tcp',
        READER_NAME: '/web/reader',
        READER_ENV_NODE_VERSION: '24',
      }),
    ).toEqual([]);
  });

  it('does not flag the reader env of compose.yaml', () => {
    const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
    const block = compose.slice(compose.search(/^ {2}reader:$/m));
    const lines = block.slice(block.indexOf('    environment:\n')).split('\n').slice(1);
    const env: Record<string, string> = {};
    for (const line of lines) {
      if (/^\s*#/.test(line)) continue;
      const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*'?([^']*)'?\s*$/.exec(line);
      if (!match) break;
      env[match[1]!] = match[2]!;
    }
    expect(Object.keys(env)).toContain('READER_SYNC_URL');
    expect(problemsOf(env)).toEqual([]);
  });

  it('pins the platform suffix list (the sync server keeps the same copy)', () => {
    expect(PLATFORM_SUFFIXES.map(String)).toEqual([
      '/_SERVICE_HOST$/',
      '/_SERVICE_PORT$/',
      '/_SERVICE_PORT_[A-Z0-9_]+$/',
      '/_PORT$/',
      '/_PORT_[0-9]+_(TCP|UDP|SCTP)(_(ADDR|PORT|PROTO))?$/',
      '/_NAME$/',
      '/_ENV_[A-Z0-9_]+$/',
    ]);
  });

  it('matches the server copy of the suffix list', () => {
    const server = readFileSync(
      join(repoRoot, 'apps', 'sync-server', 'src', 'config', 'known-vars.ts'),
      'utf8',
    );
    for (const suffix of PLATFORM_SUFFIXES) expect(server).toContain(`  ${String(suffix)},`);
  });
});

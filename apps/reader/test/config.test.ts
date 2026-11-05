import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import {
  type EnvSource,
  parsePublicConfig,
  parseReaderConfig,
  publicConfig,
} from '../src/config/schema.js';

const IDS = ['samples/psalms-he', 'samples/untitled'];

function problems(env: EnvSource, ids: readonly string[] = IDS): readonly string[] {
  try {
    parseReaderConfig(env, ids);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a config error');
}

describe('parseReaderConfig defaults (ADR 0005)', () => {
  it('defaults to the library entry with the library on and ?src disabled', () => {
    expect(parseReaderConfig({}, IDS)).toEqual({
      entry: 'library',
      book: null,
      library: 'on',
      uiLang: 'auto',
      srcOrigins: [],
      fetchTimeoutSeconds: 15,
      srcMaxBytes: 5_242_880,
      port: 8080,
      host: '0.0.0.0',
      warnings: [],
    });
  });

  it('trims values and treats empty strings as unset', () => {
    const config = parseReaderConfig(
      { READER_ENTRY: '  error ', READER_BOOK: '', READER_UI_LANG: ' he ' },
      IDS,
    );
    expect(config).toMatchObject({ entry: 'error', book: null, uiLang: 'he', library: 'on' });
  });

  it('accepts each entry mode with its rules', () => {
    expect(parseReaderConfig({ READER_ENTRY: 'error', READER_LIBRARY: 'off' }, IDS)).toMatchObject({
      entry: 'error',
      library: 'off',
    });
    expect(
      parseReaderConfig({ READER_ENTRY: 'default-book', READER_BOOK: 'samples/psalms-he' }, IDS),
    ).toMatchObject({ entry: 'default-book', book: 'samples/psalms-he', library: 'on' });
    expect(
      parseReaderConfig({ READER_ENTRY: 'single-book', READER_BOOK: 'samples/psalms-he' }, IDS),
    ).toMatchObject({ entry: 'single-book', book: 'samples/psalms-he', library: 'off' });
  });

  it('allows the library off with zero books in single-book mode', () => {
    expect(parseReaderConfig({ READER_ENTRY: 'error', READER_LIBRARY: 'off' }, [])).toMatchObject({
      library: 'off',
    });
  });

  it('parses and de-duplicates source origins', () => {
    const config = parseReaderConfig(
      { READER_SRC_ORIGINS: 'https://a.example, https://b.example:8443,,https://a.example' },
      IDS,
    );
    expect(config.srcOrigins).toEqual(['https://a.example', 'https://b.example:8443']);
  });

  it('accepts the documented number ranges (AC34)', () => {
    expect(
      parseReaderConfig(
        {
          READER_FETCH_TIMEOUT_SECONDS: '3',
          READER_SRC_MAX_BYTES: '1024',
          PORT: '0',
          HOST: '127.0.0.1',
        },
        IDS,
      ),
    ).toMatchObject({ fetchTimeoutSeconds: 3, srcMaxBytes: 1024, port: 0, host: '127.0.0.1' });
  });
});

describe('parseReaderConfig errors (AC30, AC41)', () => {
  it.each<[string, EnvSource, ReadonlyArray<string | RegExp>]>([
    [
      'unknown entry',
      { READER_ENTRY: 'x' },
      [/^READER_ENTRY "x" must be one of: library, error, default-book, single-book$/],
    ],
    [
      'unknown library value',
      { READER_LIBRARY: 'yes' },
      [/^READER_LIBRARY "yes" must be one of: on, off$/],
    ],
    ['unknown UI language', { READER_UI_LANG: 'fr' }, [/^READER_UI_LANG "fr"/]],
    [
      'default-book without book',
      { READER_ENTRY: 'default-book' },
      ['READER_BOOK is required when READER_ENTRY is default-book'],
    ],
    [
      'single-book without book',
      { READER_ENTRY: 'single-book' },
      ['READER_BOOK is required when READER_ENTRY is single-book'],
    ],
    [
      'unknown book',
      { READER_ENTRY: 'default-book', READER_BOOK: 'acme/x' },
      ['READER_BOOK "acme/x" is not a bundled book'],
    ],
    [
      'malformed book',
      { READER_ENTRY: 'single-book', READER_BOOK: 'Not An ID' },
      [/^READER_BOOK "Not An ID" is not a content ID/],
    ],
    [
      'stray book with library',
      { READER_BOOK: 'samples/psalms-he' },
      [/^READER_BOOK is set but READER_ENTRY is library/],
    ],
    [
      'stray book with error',
      { READER_ENTRY: 'error', READER_BOOK: 'samples/psalms-he' },
      [/^READER_BOOK is set but READER_ENTRY is error/],
    ],
    [
      'library entry with library off',
      { READER_LIBRARY: 'off' },
      [/^READER_LIBRARY is off but READER_ENTRY is library/],
    ],
    [
      'single-book with library on',
      { READER_ENTRY: 'single-book', READER_BOOK: 'samples/psalms-he', READER_LIBRARY: 'on' },
      ['READER_LIBRARY must be off when READER_ENTRY is single-book'],
    ],
    [
      'bad timeout',
      { READER_FETCH_TIMEOUT_SECONDS: '0' },
      [/^READER_FETCH_TIMEOUT_SECONDS "0" must be an integer from 1 to 120$/],
    ],
    [
      'non-integer timeout',
      { READER_FETCH_TIMEOUT_SECONDS: '1.5' },
      [/^READER_FETCH_TIMEOUT_SECONDS/],
    ],
    ['too big byte cap', { READER_SRC_MAX_BYTES: '52428801' }, [/^READER_SRC_MAX_BYTES/]],
    ['bad port', { PORT: 'http' }, [/^PORT "http" must be an integer/]],
  ])('%s', (_name, env, expected) => {
    const list = problems(env);
    expect(list).toHaveLength(expected.length);
    expected.forEach((item, i) => {
      if (typeof item === 'string') expect(list[i]).toBe(item);
      else expect(list[i]).toMatch(item);
    });
  });

  it('refuses the library on with zero bundled books (AC41)', () => {
    expect(problems({}, [])).toEqual([
      'READER_LIBRARY is on but no books are bundled (add content or set READER_LIBRARY=off)',
    ]);
    expect(problems({ READER_ENTRY: 'error' }, [])).toHaveLength(1);
  });

  it.each([
    ['https://a.example/', 'must be an exact origin'],
    ['https://a.example; script-src *', 'is not a URL'],
    ['https://*.example', 'must not contain a wildcard'],
    ['http://a.example', 'http: is allowed only for localhost'],
    ['https://user:pw@a.example', 'must not contain a user name or password'],
    ['javascript:alert(1)', 'must use https:'],
  ])('refuses the origin %j (C2)', (origin, message) => {
    const [problem] = problems({ READER_SRC_ORIGINS: `https://ok.example,${origin}` });
    expect(problem).toContain('READER_SRC_ORIGINS entry');
    expect(problem).toContain(message);
  });

  it('lists every problem at once', () => {
    expect(problems({ READER_ENTRY: 'x', READER_UI_LANG: 'fr', PORT: '-1' })).toHaveLength(3);
  });

  it('quotes only the offending value, truncated', () => {
    const [problem] = problems({ READER_ENTRY: 'x'.repeat(100), TOKEN_SECRET: 'secret-value' });
    expect(problem).toContain(`"${'x'.repeat(40)}…"`);
    expect(problem).not.toContain('secret-value');
  });
});

describe('loopback origins in production (security F9)', () => {
  it('warns but starts', () => {
    const config = parseReaderConfig(
      { NODE_ENV: 'production', READER_SRC_ORIGINS: 'http://localhost:3000,https://a.example' },
      IDS,
    );
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('http://localhost:3000');
  });

  it('does not warn in development', () => {
    expect(
      parseReaderConfig({ READER_SRC_ORIGINS: 'http://localhost:3000' }, IDS).warnings,
    ).toEqual([]);
  });
});

describe('publicConfig and parsePublicConfig (C5)', () => {
  const config = parseReaderConfig(
    { READER_SRC_ORIGINS: 'https://a.example', PORT: '9000', HOST: '127.0.0.1' },
    IDS,
  );

  it('exposes only the public fields', () => {
    expect(Object.keys(publicConfig(config)).sort()).toEqual([
      'book',
      'entry',
      'fetchTimeoutSeconds',
      'library',
      'srcMaxBytes',
      'srcOrigins',
      'uiLang',
    ]);
  });

  it('round-trips through the client parser', () => {
    const value = JSON.parse(JSON.stringify(publicConfig(config))) as unknown;
    expect(parsePublicConfig(value)).toEqual(publicConfig(config));
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an extra field', { ...publicConfig(config), port: 1 }],
    ['an unknown entry', { ...publicConfig(config), entry: 'x' }],
    ['a bad origin', { ...publicConfig(config), srcOrigins: ['https://a.example/'] }],
    ['default-book without a book', { ...publicConfig(config), entry: 'default-book' }],
    [
      'single-book with the library on',
      { ...publicConfig(config), entry: 'single-book', book: 'a/b' },
    ],
    ['a malformed book', { ...publicConfig(config), entry: 'default-book', book: '../x' }],
  ])('rejects %s', (_name, value) => {
    expect(parsePublicConfig(value)).toBeNull();
  });
});

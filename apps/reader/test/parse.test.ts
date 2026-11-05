import { describe, expect, it } from 'vitest';
import { isRetryable } from '../src/content/errors.js';
import { parseContentText, parseContentValue, pathLabel } from '../src/content/parse.js';
import { truncate } from '../src/content/quote.js';
import { docText, validDoc } from './helpers/content.js';

function errorOf(text: string, supported?: { min: number; max: number }) {
  const result = parseContentText(text, supported);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

function withChange(change: (doc: Record<string, unknown>) => void): string {
  const doc = validDoc();
  change(doc);
  return JSON.stringify(doc);
}

describe('parseContentText: schema version gate (AC3, AC16)', () => {
  it('accepts a valid v1 file', () => {
    const result = parseContentText(docText());
    expect(result.ok).toBe(true);
  });

  it('drops a leading BOM', () => {
    expect(parseContentText(`\u{FEFF}${docText()}`).ok).toBe(true);
  });

  it('refuses a missing version', () => {
    expect(errorOf(withChange((d) => delete d['schemaVersion']))).toEqual({
      kind: 'schema-version-missing',
    });
  });

  it.each([['"1"'], ['1.5'], ['0'], ['-1'], ['null'], ['true'], ['[]']])(
    'refuses schemaVersion %s as not a version',
    (raw) => {
      const text = docText().replace('"schemaVersion":1', `"schemaVersion":${raw}`);
      expect(errorOf(text)).toEqual({ kind: 'schema-version-invalid' });
    },
  );

  it('refuses a too-new version before validating the rest (P2)', () => {
    const text = withChange((d) => {
      d['schemaVersion'] = 2;
      d['newField'] = 'v2 only';
    });
    expect(errorOf(text)).toEqual({
      kind: 'schema-version-unsupported',
      version: 2,
      min: 1,
      max: 1,
    });
  });

  it('refuses a too-old version for a later range', () => {
    expect(errorOf(docText(), { min: 2, max: 3 })).toEqual({
      kind: 'schema-version-unsupported',
      version: 1,
      min: 2,
      max: 3,
    });
  });

  it('ignores an inherited schemaVersion (C4)', () => {
    const proto = { schemaVersion: 1 };
    const value = Object.create(proto) as Record<string, unknown>;
    const result = parseContentValue(value);
    expect(result.ok).toBe(false);
  });
});

describe('parseContentText: malformed content (AC4, AC32)', () => {
  it('refuses invalid JSON', () => {
    expect(errorOf('{"schemaVersion": 1,')).toEqual({ kind: 'invalid-json' });
    expect(errorOf('')).toEqual({ kind: 'invalid-json' });
  });

  it.each([['[]'], ['null'], ['"text"'], ['42']])('refuses a %s root', (text) => {
    expect(errorOf(text)).toMatchObject({ kind: 'invalid-content', code: 'not-an-object' });
  });

  it('refuses missing pages', () => {
    expect(errorOf(withChange((d) => delete d['pages']))).toMatchObject({
      kind: 'invalid-content',
      code: 'missing-field',
      detail: 'missing pages',
    });
  });

  it('refuses zero pages', () => {
    expect(errorOf(withChange((d) => (d['pages'] = [])))).toMatchObject({
      code: 'empty',
      detail: 'has no pages',
    });
  });

  it('refuses a page with zero blocks (AC32)', () => {
    const text = withChange((d) => {
      (d['pages'] as unknown[]).push({ blocks: [] });
    });
    expect(errorOf(text)).toEqual({
      kind: 'invalid-content',
      path: 'Page 3',
      code: 'empty',
      detail: 'has no blocks',
    });
  });

  it('refuses an unknown direction with its path', () => {
    const text = docText().replace('"dir":"ltr","lang":"en"}', '"dir":"rlt","lang":"en"}');
    expect(errorOf(text)).toEqual({
      kind: 'invalid-content',
      path: 'Page 2, block 2',
      code: 'invalid-value',
      detail: 'unknown direction "rlt"',
    });
  });

  it('refuses auto at page or document level', () => {
    expect(errorOf(withChange((d) => (d['dir'] = 'auto')))).toMatchObject({
      code: 'invalid-value',
    });
  });

  it('refuses wrong types', () => {
    const text = withChange((d) => {
      (d['pages'] as { blocks: unknown[] }[])[0]!.blocks = [{ text: 42 }];
    });
    expect(errorOf(text)).toEqual({
      kind: 'invalid-content',
      path: 'Page 1, block 1',
      code: 'wrong-type',
      detail: 'text must be text, not a number',
    });
  });

  it('refuses a bad content ID with the specific reason (AC23)', () => {
    expect(errorOf(withChange((d) => (d['contentId'] = 'Acme/x')))).toMatchObject({
      kind: 'invalid-content',
      path: '',
      code: 'invalid-content-id',
      contentIdIssue: 'uppercase',
    });
  });

  it('refuses a bad lang tag', () => {
    expect(errorOf(withChange((d) => (d['lang'] = 'english language')))).toMatchObject({
      code: 'invalid-lang',
    });
  });

  it('refuses a lone surrogate in text (F8)', () => {
    const text = docText().replace('First page.', 'First \\ud800 page.');
    expect(errorOf(text)).toMatchObject({ code: 'invalid-text', path: 'Page 1, block 1' });
  });

  it('truncates quoted values to 40 characters', () => {
    const long = 'x'.repeat(100);
    const text = docText().replace('"dir":"ltr","lang":"en"}', `"dir":"${long}","lang":"en"}`);
    const error = errorOf(text);
    expect(error).toMatchObject({ detail: `unknown direction "${'x'.repeat(40)}…"` });
  });
});

describe('error helpers', () => {
  it('labels paths', () => {
    expect(pathLabel(['pages', 2, 'blocks', 1, 'dir'])).toBe('Page 3, block 2');
    expect(pathLabel(['contentId'])).toBe('');
  });

  it('truncates without splitting surrogate pairs', () => {
    const emoji = '\u{1F600}'.repeat(50);
    const short = truncate(emoji, 3);
    expect(Array.from(short)).toHaveLength(4);
  });

  it('marks only fetch failures as retryable', () => {
    expect(isRetryable({ kind: 'network' })).toBe(true);
    expect(isRetryable({ kind: 'http', status: 500 })).toBe(true);
    expect(isRetryable({ kind: 'timeout', seconds: 15 })).toBe(true);
    expect(isRetryable({ kind: 'invalid-json' })).toBe(false);
    expect(isRetryable({ kind: 'too-large', maxBytes: 1 })).toBe(false);
  });
});

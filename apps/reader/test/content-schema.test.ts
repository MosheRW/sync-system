import { describe, expect, it } from 'vitest';
import { CONTENT_LIMITS, SUPPORTED_SCHEMA } from '../src/content/limits.js';
import { parseContentText } from '../src/content/parse.js';
import { contentSchemaV1 } from '../src/content/schema.js';
import { z } from '../src/content/zod.js';
import { docText, validDoc } from './helpers/content.js';

describe('content schema v1 (AC1, ADR 0004)', () => {
  it('declares the supported range 1..1 (AC17)', () => {
    expect(SUPPORTED_SCHEMA).toEqual({ min: 1, max: 1 });
  });

  it('accepts the documented fields and keeps them as written', () => {
    const result = parseContentText(docText());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.document).toEqual(validDoc());
  });

  it('accepts a file with only the required fields', () => {
    const minimal = {
      schemaVersion: 1,
      contentId: 'a/b',
      pages: [{ blocks: [{ text: '' }] }],
    };
    expect(parseContentText(JSON.stringify(minimal)).ok).toBe(true);
  });

  it.each([
    ['document', (d: Record<string, unknown>) => (d['extra'] = 1)],
    [
      'page',
      (d: Record<string, unknown>) => ((d['pages'] as Record<string, unknown>[])[0]!['id'] = 'p1'),
    ],
    [
      'block',
      (d: Record<string, unknown>) =>
        ((d['pages'] as { blocks: Record<string, unknown>[] }[])[0]!.blocks[0]!['style'] = 'bold'),
    ],
  ])('rejects an unknown field at %s level (strict)', (_level, change) => {
    const doc = validDoc();
    change(doc);
    const result = parseContentText(JSON.stringify(doc));
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects an own %s key as an unknown field (C4)',
    (key) => {
      const text = docText().replace(
        '{"schemaVersion":1',
        `{"${key}":{"polluted":true},"schemaVersion":1`,
      );
      const result = parseContentText(text);
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'invalid-content', code: 'unknown-field', detail: `unknown field "${key}"` },
      });
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    },
  );

  it('rejects a __proto__ key inside a block', () => {
    const text = docText().replace('{"text":"First page."}', '{"text":"x","__proto__":{"a":1}}');
    expect(parseContentText(text)).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
  });

  it('enforces the limits', () => {
    const tooLongText = validDoc();
    (tooLongText['pages'] as { blocks: { text: string }[] }[])[0]!.blocks[0]!.text = 'x'.repeat(
      CONTENT_LIMITS.textLength + 1,
    );
    expect(parseContentText(JSON.stringify(tooLongText))).toMatchObject({
      ok: false,
      error: { code: 'too-long', path: 'Page 1, block 1' },
    });

    const tooManyBlocks = validDoc();
    (tooManyBlocks['pages'] as { blocks: unknown[] }[])[0]!.blocks = Array.from(
      { length: CONTENT_LIMITS.blocksPerPage + 1 },
      () => ({ text: 'x' }),
    );
    expect(parseContentText(JSON.stringify(tooManyBlocks))).toMatchObject({
      ok: false,
      error: { code: 'too-many', path: 'Page 1' },
    });

    const longTitle = validDoc();
    longTitle['title'] = 't'.repeat(CONTENT_LIMITS.titleLength + 1);
    expect(parseContentText(JSON.stringify(longTitle))).toMatchObject({
      ok: false,
      error: { code: 'too-long' },
    });

    const emptyTitle = validDoc();
    emptyTitle['title'] = '';
    expect(parseContentText(JSON.stringify(emptyTitle))).toMatchObject({
      ok: false,
      error: { code: 'empty' },
    });
  });

  it('accepts the block types paragraph and heading only', () => {
    const doc = validDoc();
    (doc['pages'] as { blocks: Record<string, unknown>[] }[])[0]!.blocks[0]!['type'] = 'quote';
    expect(parseContentText(JSON.stringify(doc))).toMatchObject({
      ok: false,
      error: { code: 'invalid-value', detail: 'unknown block type "quote"' },
    });
  });

  it('is built with JIT off, so the CSP needs no unsafe-eval (C7)', () => {
    expect(contentSchemaV1).toBeDefined();
    expect(z.config().jitless).toBe(true);
  });
});

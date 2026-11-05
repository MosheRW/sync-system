// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanonicalJsonValue } from '../src/content/canonical-json.js';
import {
  CryptoUnavailableError,
  FINGERPRINT_PATTERN,
  computeFingerprint,
} from '../src/content/fingerprint.js';
import { parseContentText } from '../src/content/parse.js';

const vectorText = readFileSync(
  join(import.meta.dirname, 'fixtures', 'fingerprint-vector.json'),
  'utf8',
);

/**
 * The documented test vector (also in apps/reader/README.md). Cross-checked
 * with an independent implementation: Python `json.dumps(sort_keys=True,
 * separators=(',', ':'), ensure_ascii=False)` + SHA-256 gives the same hex
 * (the file has ASCII keys only, so code-point and UTF-16 order agree).
 */
const VECTOR_FINGERPRINT = 'a8672a8d9ccb84e903c9167de7dbe3d1a7b4cd42f00d53a3872687c1e7f58aee';

function parsed(text: string): CanonicalJsonValue {
  const result = parseContentText(text);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.document;
}

type Doc = {
  schemaVersion: number;
  title?: string;
  lang?: string;
  dir?: string;
  pages: { dir?: string; blocks: { text: string; dir?: string; type?: string; lang?: string }[] }[];
};

function variant(change: (doc: Doc) => void): Promise<string> {
  const doc = JSON.parse(vectorText) as Doc;
  change(doc);
  return computeFingerprint(doc);
}

describe('computeFingerprint (AC6, AC7)', () => {
  it('matches the documented vector', async () => {
    const fingerprint = await computeFingerprint(parsed(vectorText));
    expect(fingerprint).toBe(VECTOR_FINGERPRINT);
    expect(fingerprint).toMatch(FINGERPRINT_PATTERN);
  });

  it('ignores formatting and key order', async () => {
    const value = JSON.parse(vectorText) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    const minified = JSON.stringify(reordered);
    const spaced = JSON.stringify(reordered, null, 8).replace(/\n/g, '\r\n');
    expect(await computeFingerprint(parsed(minified))).toBe(VECTOR_FINGERPRINT);
    expect(await computeFingerprint(parsed(spaced))).toBe(VECTOR_FINGERPRINT);
  });

  it.each<[string, (doc: Doc) => void]>([
    ['text', (d) => (d.pages[0]!.blocks[0]!.text += '!')],
    ['block direction', (d) => (d.pages[0]!.blocks[1]!.dir = 'rtl')],
    ['document direction', (d) => (d.dir = 'ltr')],
    ['added page direction', (d) => (d.pages[1]!.dir = 'rtl')],
    ['page order', (d) => d.pages.reverse()],
    ['schema version', (d) => (d.schemaVersion = 2)],
    ['title', (d) => (d.title = 'Other')],
    ['lang', (d) => (d.lang = 'he-IL')],
    ['block type', (d) => (d.pages[0]!.blocks[0]!.type = 'paragraph')],
    ['missing dir vs explicit default', (d) => (d.pages[0]!.blocks[0]!.dir = 'rtl')],
  ])('changes when the %s changes', async (_what, change) => {
    expect(await variant(change)).not.toBe(VECTOR_FINGERPRINT);
  });

  it('does not normalise Unicode (ADR 0004 E1): NFC and NFD differ', async () => {
    const composed = 'é'.normalize('NFC');
    const decomposed = 'é'.normalize('NFD');
    expect(composed).not.toBe(decomposed);
    const a = await variant((d) => (d.pages[0]!.blocks[1]!.text = composed));
    const b = await variant((d) => (d.pages[0]!.blocks[1]!.text = decomposed));
    expect(a).not.toBe(b);
  });

  it('refuses with a typed error when Web Crypto is missing (non-secure context)', async () => {
    await expect(computeFingerprint(parsed(vectorText), null)).rejects.toBeInstanceOf(
      CryptoUnavailableError,
    );
  });
});

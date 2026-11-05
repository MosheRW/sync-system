import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RenderResult, render } from '@testing-library/react';
import type { LoadedContent } from '../../src/content/loader.js';
import { parseContentText } from '../../src/content/parse.js';
import { ReadingScreen } from '../../src/components/ReadingScreen.js';
import { I18nProvider, type UiLanguage } from '../../src/i18n/index.js';

const samplesDir = join(import.meta.dirname, '..', '..', 'content', 'samples');

export function sampleText(name: string): string {
  return readFileSync(join(samplesDir, `${name}.json`), 'utf8');
}

/** A validated document wrapped as loader output (fingerprint faked: not under test here). */
export function loaded(input: string | Record<string, unknown>): LoadedContent {
  const result = parseContentText(typeof input === 'string' ? input : JSON.stringify(input));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const { document } = result;
  return {
    source: 'bundled',
    document,
    metadata: {
      contentId: document.contentId,
      fingerprint: '0'.repeat(64),
      schemaVersion: document.schemaVersion,
    },
  };
}

export function renderReading(content: LoadedContent, lang: UiLanguage = 'en'): RenderResult {
  return render(
    <I18nProvider lang={lang}>
      <ReadingScreen content={content} />
    </I18nProvider>,
  );
}

/** A document of `pages` single-block pages. */
export function pagedDoc(pages: number, dir?: 'ltr' | 'rtl'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contentId: 'acme/paged',
    title: 'Paged',
    ...(dir ? { dir } : {}),
    pages: Array.from({ length: pages }, (_, i) => ({ blocks: [{ text: `Page ${i + 1} text` }] })),
  };
}

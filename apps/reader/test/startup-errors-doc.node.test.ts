// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STARTUP_MESSAGES } from '../server/run.js';
import { ConfigError } from '../src/config/config-error.js';
import { parseReaderConfig } from '../src/config/schema.js';
import { LIBRARY_IDS, READER_CASES } from './config-cases.js';

const doc = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docs', 'startup-errors.md'),
  'utf8',
);

/** The reader part of the doc: from `## Reader` to the next `## ` heading. */
function readerSection(): string {
  const from = doc.indexOf('\n## Reader\n');
  const to = doc.indexOf('\n## ', from + 1);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return doc.slice(from, to);
}

/** Message templates: the code span in the first cell of each table row. */
function templates(text: string, prefix: string): string[] {
  const result: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = line.slice(1, line.indexOf(' |', 1) + 1).trim();
    const span = /^``(.+)``$/.exec(cell) ?? /^`([^`]+)`$/.exec(cell);
    const template = span?.[1]!.trim();
    if (template?.startsWith(prefix)) result.push(template);
  }
  return result;
}

/** A template as a full-match pattern: placeholders become `.+?`, the rest is literal. */
function pattern(template: string): RegExp {
  const parts = template.split(/<[a-z]+>/);
  return new RegExp(
    `^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`,
  );
}

const section = readerSection();
const configTemplates = templates(section, 'Config error: ');
const startupTemplates = templates(section, 'Startup error: ');

describe('docs/startup-errors.md lists every reader startup error (#36 AC40)', () => {
  it('has templates with at least one literal word besides the prefix', () => {
    expect(configTemplates.length).toBeGreaterThan(15);
    expect(startupTemplates).toHaveLength(3);
    for (const template of [...configTemplates, ...startupTemplates]) {
      const literal = template.replace(/^(Config|Startup) error: /, '').replace(/<[a-z]+>/g, '');
      expect(literal, template).toMatch(/[A-Za-z]{2,}/);
    }
  });

  const printed: string[] = [];
  for (const c of READER_CASES) {
    try {
      parseReaderConfig(c.env, c.ids ?? LIBRARY_IDS);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      printed.push(...err.problems.map((problem) => `Config error: ${problem}`));
    }
  }

  it('every Config error printed by the invalid-config cases is listed', () => {
    expect(printed.length).toBeGreaterThanOrEqual(READER_CASES.length);
    const missing = printed.filter(
      (line) => !configTemplates.some((template) => pattern(template).test(line)),
    );
    expect(missing).toEqual([]);
  });

  it('every listed Config error is printed by at least one case (no stale entries)', () => {
    const stale = configTemplates.filter(
      (template) => !printed.some((line) => pattern(template).test(line)),
    );
    expect(stale).toEqual([]);
  });

  const startupLines = [
    STARTUP_MESSAGES.libraryIndex,
    STARTUP_MESSAGES.indexHtml,
    STARTUP_MESSAGES.listen(8080, 'EADDRINUSE'),
  ].map((message) => `Startup error: ${message}`);

  it('every Startup error text is listed, and every listed one is printed', () => {
    for (const line of startupLines) {
      expect(
        startupTemplates.some((template) => pattern(template).test(line)),
        line,
      ).toBe(true);
    }
    for (const template of startupTemplates) {
      expect(
        startupLines.some((line) => pattern(template).test(line)),
        template,
      ).toBe(true);
    }
  });
});

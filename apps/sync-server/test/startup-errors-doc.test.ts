import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import { loadConfig } from '../src/config/load.js';
import { listenErrorMessage } from '../src/main.js';
import { STORAGE_START_MESSAGES } from '../src/storage/errors.js';
import { STARTUP_MESSAGES } from '../src/storage/redis/connect.js';
import { VERSION_REASONS, VERSION_STARTUP_PREFIX } from '../src/version.js';
import { ALL_CASES, materialize } from './config-cases.js';

const doc = readFileSync(new URL('../../../docs/startup-errors.md', import.meta.url), 'utf8');

/** The doc between two `## ` headings. */
function section(start: string, end: string): string {
  const from = doc.indexOf(`\n## ${start}\n`);
  const to = doc.indexOf(`\n## ${end}\n`);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
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

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

const server = section('Sync server', 'Reader');
const configTemplates = templates(server, 'Config error: ');
const startupTemplates = templates(server, 'Startup error: ');

describe('docs/startup-errors.md lists every server startup error (#36 AC40)', () => {
  it('has templates with at least one literal word besides the prefix', () => {
    expect(configTemplates.length).toBeGreaterThan(40);
    expect(startupTemplates.length).toBeGreaterThan(5);
    for (const template of [...configTemplates, ...startupTemplates]) {
      const literal = template.replace(/^(Config|Startup) error: /, '').replace(/<[a-z]+>/g, '');
      expect(literal, template).toMatch(/[A-Za-z]{2,}/);
    }
  });

  const printed = new Map<string, string>();
  for (const c of ALL_CASES) {
    const { env } = materialize(c);
    for (const problem of problemsOf(env)) printed.set(`Config error: ${problem}`, c.id);
  }

  it('every Config error printed by the invalid-config cases is listed', () => {
    expect(printed.size).toBeGreaterThan(40);
    const missing = [...printed.keys()].filter(
      (line) => !configTemplates.some((template) => pattern(template).test(line)),
    );
    expect(missing).toEqual([]);
  });

  it('every listed Config error is printed by at least one case (no stale entries)', () => {
    const lines = [...printed.keys()];
    const stale = configTemplates.filter(
      (template) => !lines.some((line) => pattern(template).test(line)),
    );
    expect(stale).toEqual([]);
  });

  const startupLines = [
    ...Object.values(STARTUP_MESSAGES),
    ...Object.values(STORAGE_START_MESSAGES),
    listenErrorMessage(8080, 'EADDRINUSE'),
    ...Object.values(VERSION_REASONS).map(
      (reason) =>
        `${VERSION_STARTUP_PREFIX}: ${typeof reason === 'function' ? reason('EACCES') : reason}`,
    ),
  ].map((message) => `Startup error: ${message}`);

  it('every fixed Startup error text is listed', () => {
    const missing = startupLines.filter(
      (line) => !startupTemplates.some((template) => pattern(template).test(line)),
    );
    expect(missing).toEqual([]);
  });

  it('every listed Startup error is one the server prints', () => {
    const stale = startupTemplates.filter(
      (template) => !startupLines.some((line) => pattern(template).test(line)),
    );
    expect(stale).toEqual([]);
  });

  it('contains placeholders, never a usable secret (#36 security C10)', () => {
    expect(doc).not.toMatch(/dev-only-insecure/);
    expect(doc).not.toMatch(/REPLACE-with/);
  });
});

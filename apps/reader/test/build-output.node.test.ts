// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'reader-build-'));

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

beforeAll(async () => {
  await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('production build is CSP-clean (security C7, C10)', () => {
  it('keeps the config placeholder for the server', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain('<!--reader-config-->');
  });

  it('has no inline script, inline style or event-handler attribute', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag, tag).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('ships no source maps and no data: URLs in CSS', () => {
    const files = allFiles(outDir);
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const css of files.filter((f) => f.endsWith('.css'))) {
      expect(readFileSync(css, 'utf8')).not.toContain('data:');
    }
  });

  it('emits the library index next to the app', () => {
    const entries = JSON.parse(readFileSync(join(outDir, 'library-index.json'), 'utf8')) as {
      contentId: string;
    }[];
    expect(entries.map((e) => e.contentId)).toContain('samples/psalms-he');
  });
});

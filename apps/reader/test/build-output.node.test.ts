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
  // Vitest sets NODE_ENV=test, which makes Vite bundle React's development
  // build; the checks below must see the bundle `pnpm build` ships (#21).
  const nodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    if (nodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = nodeEnv;
  }
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

  it('ships a same-origin favicon so browsers do not request a missing /favicon.ico', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
    const svg = readFileSync(join(outDir, 'favicon.svg'), 'utf8');
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).not.toMatch(/<script\b|<style\b|\son[a-z]+=|data:|href=/i);
  });

  it('bundles no Playwright, e2e or lean-qr extras code (#24 security R10)', () => {
    const js = allFiles(outDir)
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join(' ');
    expect(js).not.toMatch(/playwright/i);
    expect(js).not.toContain('toSvgDataURL');
    expect(js).not.toContain('data:image');
  });

  it('emits the library index next to the app', () => {
    const entries = JSON.parse(readFileSync(join(outDir, 'library-index.json'), 'utf8')) as {
      contentId: string;
    }[];
    expect(entries.map((e) => e.contentId)).toContain('samples/psalms-he');
  });
});

/**
 * The CSP enforces Trusted Types with no policy (#21), so a new DOM XSS sink
 * in the bundle would break the app (or need a policy). This tripwire fails
 * on any sink site beyond React DOM's known, unreached ones (architecture
 * section 3, security C6 and L2); a new one must be reviewed, not allowed.
 */
describe('production build has no new Trusted Types sink (#21, security C6)', () => {
  function bundle(): string {
    return allFiles(outDir)
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
  }

  function sites(source: string, pattern: RegExp): string[] {
    return [...source.matchAll(new RegExp(pattern.source, 'g' + pattern.flags))].map((match) =>
      source.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40),
    );
  }

  it.each([
    ['a Trusted Types policy', /createPolicy|trustedTypes/],
    ['outerHTML', /outerHTML/],
    ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['createContextualFragment', /createContextualFragment/],
    ['DOMParser', /DOMParser/],
    ['document.write', /document\s*\.\s*write/],
    ['srcdoc', /srcdoc/i],
    ['setHTMLUnsafe', /setHTMLUnsafe/],
    ['importScripts', /importScripts/],
    ['new Worker', /new\s+(?:Shared)?Worker\b/],
    ['serviceWorker.register', /serviceWorker\s*\.\s*register/],
  ])('has no %s', (_name, pattern) => {
    expect(sites(bundle(), pattern)).toEqual([]);
  });

  // React DOM 19: `<script>` creation via innerHTML and two
  // dangerouslySetInnerHTML paths; the app renders neither (ESLint bans
  // dangerouslySetInnerHTML).
  it('assigns innerHTML only at the 3 known React DOM sites', () => {
    expect(sites(bundle(), /\.innerHTML\s*=(?!=)/)).toHaveLength(3);
  });

  // React DOM 19 resource code (preinit/hoisted `<script src>`), not reached:
  // the app renders no `<script>` and calls no preinit.
  it('creates script elements only at the 3 known React DOM sites (security L2)', () => {
    expect(sites(bundle(), /createElement\(\s*[`'"]script[`'"]\s*\)/)).toHaveLength(3);
  });

  // React DOM 19's own guard: it replaces unsafe URLs and form actions with a
  // throwing `javascript:` string (2 sites, 3 occurrences).
  it('has javascript: URLs only in the known React DOM guard (security L2)', () => {
    const found = sites(bundle(), /javascript:/i);
    expect(found).toHaveLength(3);
    for (const site of found)
      expect(site).toMatch(/javascript:throw new Error\(|blocked a javascript: URL/);
  });
});

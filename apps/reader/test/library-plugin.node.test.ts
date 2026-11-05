// @vitest-environment node
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LibraryBuildError,
  buildLibraryIndex,
  libraryModuleSource,
  readerLibrary,
} from '../plugins/library.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const samples = join(import.meta.dirname, '..', 'content');
const temp = mkdtempSync(join(tmpdir(), 'reader-library-'));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function problemsOf(dir: string): readonly string[] {
  try {
    buildLibraryIndex(dir);
  } catch (err) {
    if (err instanceof LibraryBuildError) return err.problems;
    throw err;
  }
  throw new Error('expected the index build to fail');
}

describe('buildLibraryIndex (AC38, AC39, ADR 0005 D1)', () => {
  it('lists every valid book with title, lang and effective direction', () => {
    expect(buildLibraryIndex(join(fixtures, 'library-valid')).entries).toEqual([
      { contentId: 'acme/arabic', title: 'كتاب عربي', lang: 'ar', dir: 'rtl' },
      { contentId: 'acme/english', title: 'An English Book', lang: 'en', dir: 'ltr' },
      { contentId: 'other/untitled', dir: 'ltr' },
    ]);
  });

  it('fails the build naming every invalid file and its reason', () => {
    const dir = join(temp, 'invalid');
    cpSync(join(fixtures, 'library-invalid'), dir, { recursive: true });
    writeFileSync(join(dir, 'acme', 'not-json.json'), '{ nope');
    const problems = problemsOf(dir);
    expect(problems).toEqual([
      'acme/broken.json: Page 2: has no blocks',
      'acme/not-json.json: not valid JSON (or not UTF-8)',
      'acme/wrong-id.json: contentId "acme/other" must match its path (acme/other.json)',
      'top.json: contentId "top/top" must match its path (top/top.json)',
    ]);
    expect(() => buildLibraryIndex(dir)).toThrow(/Invalid bundled content \(4\)/);
  });

  it('returns no entries for an empty directory (the config decides, AC41)', () => {
    expect(buildLibraryIndex(join(fixtures, 'library-empty')).entries).toEqual([]);
  });

  it('validates the bundled samples (AC20)', () => {
    const { entries } = buildLibraryIndex(samples);
    expect(entries.map((e) => e.contentId)).toEqual([
      'samples/mixed-en-he',
      'samples/mixed-he-en',
      'samples/pride-and-prejudice-en',
      'samples/psalms-he',
      'samples/untitled',
    ]);
    expect(entries.find((e) => e.contentId === 'samples/psalms-he')).toMatchObject({
      lang: 'he',
      dir: 'rtl',
    });
    expect(entries.find((e) => e.contentId === 'samples/untitled')).toEqual({
      contentId: 'samples/untitled',
      dir: 'ltr',
    });
  });
});

describe('virtual:reader-library', () => {
  it('exports the entries and one lazy ?raw loader per book', () => {
    const source = libraryModuleSource(
      buildLibraryIndex(join(fixtures, 'library-valid')),
      '/content',
    );
    expect(source).toContain('export const entries = [{"contentId":"acme/arabic"');
    expect(source).toContain(
      '"acme/english": () => import("/content/acme/english.json?raw").then((m) => m.default),',
    );
  });

  it('is served by the plugin', () => {
    const plugin = readerLibrary({ contentDir: join(fixtures, 'library-valid') });
    const resolveId = plugin.resolveId as (id: string) => string | null;
    const load = plugin.load as (id: string) => string | null;
    const resolved = resolveId('virtual:reader-library');
    expect(resolved).toBe('\0virtual:reader-library');
    expect(load(resolved!)).toContain('export const loaders');
    expect(resolveId('other')).toBeNull();
  });
});

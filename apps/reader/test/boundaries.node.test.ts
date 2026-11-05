// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const appRoot = join(import.meta.dirname, '..');
const workspaceRoot = join(appRoot, '..', '..');
const srcDir = join(appRoot, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('package boundaries (AC19)', () => {
  const files = sourceFiles(srcDir);

  it('scans the app sources', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('imports the sync stack only through @sync-system/react', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? match[2] ?? '';
        const where = relative(appRoot, file);
        expect(specifier, where).not.toMatch(/^@sync-system\/(server|protocol|client)(\/|$)/);
        expect(specifier, where).not.toMatch(/^@sync-system\/[^/]+\/src\//);
        expect(specifier, where).not.toMatch(/(^|\/)(packages|sync-server)\//);
        expect(specifier, where).not.toMatch(/^node:/);
        if (specifier.startsWith('.')) {
          const target = join(file, '..', specifier);
          expect(relative(srcDir, target).startsWith('..'), `${where} -> ${specifier}`).toBe(false);
        }
      }
    }
  });
});

describe('ESLint bans HTML sinks and boundary imports in the app (AC18, AC19, security C6)', () => {
  const eslint = new ESLint({ cwd: workspaceRoot });
  const lint = async (code: string) => {
    const [result] = await eslint.lintText(code, {
      // An existing file, so the typed project service knows it; the text replaces its content.
      filePath: join(srcDir, 'components', 'PlainText.tsx'),
    });
    return (result?.messages ?? []).map((m) => m.ruleId);
  };

  it.each([
    [
      'dangerouslySetInnerHTML',
      'export const A = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n',
      'no-restricted-syntax',
    ],
    [
      'innerHTML',
      'export function f(el: HTMLElement) {\n  el.innerHTML = "x";\n}\n',
      'no-restricted-properties',
    ],
    [
      'outerHTML',
      'export function f(el: HTMLElement) {\n  el.outerHTML = "x";\n}\n',
      'no-restricted-properties',
    ],
    [
      'insertAdjacentHTML',
      'export function f(el: HTMLElement) {\n  el.insertAdjacentHTML("beforeend", "x");\n}\n',
      'no-restricted-properties',
    ],
    [
      'document.write',
      'export function f() {\n  document.write("x");\n}\n',
      'no-restricted-properties',
    ],
    [
      '@sync-system/client',
      "export { SyncClient } from '@sync-system/client';\n",
      'no-restricted-imports',
    ],
    ['node:fs', "export { readFileSync } from 'node:fs';\n", 'no-restricted-imports'],
  ])(
    'reports %s',
    async (_name, code, rule) => {
      expect(await lint(code)).toContain(rule);
    },
    60_000,
  );
});

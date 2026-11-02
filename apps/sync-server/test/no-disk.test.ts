import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(srcDir).map((path) => ({
  name: relative(srcDir, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

describe('the server persists nothing (#5 AC11)', () => {
  it('scans the server sources', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => f.name)).toContain('tokens/token-service.ts');
  });

  it('only the apps-config loader imports the file system, to read the registry', () => {
    const importers = files
      .filter((f) => /from\s+['"](node:)?fs(\/promises)?['"]/.test(f.text))
      .map((f) => f.name);
    expect(importers).toEqual(['config/apps-config.ts']);
    const loader = files.find((f) => f.name === 'config/apps-config.ts')!;
    expect(loader.text).toMatch(/import \{ readFileSync \} from 'node:fs'/);
  });

  it('never writes files', () => {
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(
        /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync)\b/,
      );
    }
  });
});

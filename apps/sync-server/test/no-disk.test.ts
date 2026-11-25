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

  it('only the apps-config loader, the secret file reader and the version reader import the file system, to read', () => {
    const importers = files
      .filter((f) => /from\s+['"](node:)?fs(\/promises)?['"]/.test(f.text))
      .map((f) => f.name)
      .sort();
    expect(importers).toEqual(['config/apps-config.ts', 'config/secret-file.ts', 'version.ts']);
    // #58: secret files, opened read-only (security C1).
    const secrets = files.find((f) => f.name === 'config/secret-file.ts')!;
    expect(secrets.text).toMatch(
      /import \{ closeSync, constants, fstatSync, openSync, readSync \} from 'node:fs'/,
    );
    expect(secrets.text).toMatch(/SECRET_FILE_OPEN_FLAGS =\s+constants\.O_RDONLY \|/);
    expect(secrets.text).not.toMatch(/O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/);
    const loader = files.find((f) => f.name === 'config/apps-config.ts')!;
    expect(loader.text).toMatch(/import \{ readFileSync \} from 'node:fs'/);
    // #36 AC33: the server's package.json, opened read-only.
    const version = files.find((f) => f.name === 'version.ts')!;
    expect(version.text).toMatch(/import \{ closeSync, openSync, readSync \} from 'node:fs'/);
    expect([...version.text.matchAll(/openSync\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
      "url, 'r'",
    ]);
  });

  it('never writes files', () => {
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(
        /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync)\b/,
      );
    }
  });
});

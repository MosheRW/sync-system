import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for #58 security advisory A1 (Gate 3 round 3). A
 * `TokenSecrets` keeps its bytes in private fields of the class in
 * `config/token-secret.ts`; the only way to them is `tokenSecretBytes`,
 * and only `tokens/token-keys.ts` (the HKDF input) may use it. The check
 * goes by module structure, not by variable names, so an alias cannot hide
 * a read:
 * - no module but `token-keys.ts` names `tokenSecretBytes` at all (import,
 *   `as` alias, re-export, `mod['tokenSecretBytes']`);
 * - every other import of the secrets module is a static named import: no
 *   `import * as`, default import, `export * from`, `export … from`, and no
 *   dynamic `import()` of it or of a computed specifier;
 * - the private storage (`#current`, `#previous`, `readSecretBytes`) is
 *   named only in the secrets module, and `readSecretBytes` is not exported;
 * - `token-keys.ts` never re-exports the accessor and never decodes or
 *   copies the bytes.
 * Test files are held to the same import rules (none may read the bytes).
 */
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(serverDir, 'src');
const testDir = join(serverDir, 'test');

/** The module that owns the private storage and the accessor. */
const SECRETS_MODULE = 'src/config/token-secret.ts';
/** The only module that may use the accessor. */
const KEYRING_MODULE = 'src/tokens/token-keys.ts';
/** This file names the accessor in its patterns and probes. */
const THIS_FILE = 'test/token-secret-readers.test.ts';

const ACCESSOR = 'tokenSecretBytes';
const PRIVATE_STORAGE = /#current\b|#previous\b|\breadSecretBytes\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** `text` without comments, so a doc comment never trips (or hides) a check. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Whether `specifier`, imported from `file` (relative to the server dir), is the secrets module. */
function isSecretsModule(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = relative(serverDir, resolve(serverDir, dirname(file), specifier))
    .replaceAll('\\', '/')
    .replace(/\.js$/, '.ts');
  return target === SECRETS_MODULE || target === SECRETS_MODULE.replace(/\.ts$/, '');
}

/** `import … from '…'` and `export … from '…'`, with the clause and the specifier. */
const FROM_STATEMENT =
  /\b(import|export)\s+(?:type\s+)?((?:[\w$]+\s*,\s*)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+))\s*from\s*(['"])([^'"]+)\3/g;
/** A dynamic `import(…)`; group 1 is a plain string literal specifier, if any. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(['"])([^'"]+)\1\s*\)|(?!['"][^'"]+['"]\s*\)))/g;

/** Every rule `code` (comments removed) of the module `file` breaks; empty when it is clean. */
function violations(file: string, code: string): string[] {
  const found: string[] = [];
  const isOwner = file === SECRETS_MODULE;
  const isKeyring = file === KEYRING_MODULE;

  if (!isOwner && !isKeyring && code.includes(ACCESSOR)) {
    found.push(`names ${ACCESSOR}`);
  }
  if (!isOwner && PRIVATE_STORAGE.test(code)) found.push('names the private secret storage');

  for (const match of code.matchAll(FROM_STATEMENT)) {
    const [, keyword, clause, , specifier] = match;
    if (!isSecretsModule(file, specifier!)) continue;
    if (keyword === 'export') {
      found.push('re-exports the secrets module');
      continue;
    }
    if (!/^\{[^}]*\}$/.test(clause!.trim())) {
      found.push('imports the secrets module other than by named imports');
      continue;
    }
    const imported = clause!
      .slice(1, -1)
      .split(',')
      .map((part) =>
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter((name) => name.length > 0);
    if (imported.includes(ACCESSOR) && !isKeyring) found.push(`imports ${ACCESSOR}`);
  }

  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[2];
    if (specifier === undefined) found.push('has a dynamic import with a computed specifier');
    else if (isSecretsModule(file, specifier)) found.push('imports the secrets module dynamically');
  }

  if (isKeyring) {
    if (/\bexport\b[^;]*\btokenSecretBytes\b/.test(code)) found.push(`re-exports ${ACCESSOR}`);
    for (const rule of BYTES_DECODE) {
      if (rule.test(code)) found.push(`decodes or copies the secret bytes (${rule.source})`);
    }
  }
  if (isOwner && /\bexport\b[^;(]*\breadSecretBytes\b/.test(code)) {
    found.push('exports readSecretBytes');
  }
  return found;
}

/** Decoding or copying a secret Buffer (applied to `token-keys.ts`). */
const BYTES_DECODE = [
  /\b(?:current|previous)\??\.(?:toString|toLocaleString|toJSON|subarray|slice|values|entries|at|join|map|reduce|forEach)\s*\(/,
  /\bBuffer\.(?:from|concat|copyBytesFrom)\(\s*\[?\s*[\w.]*\b(?:current|previous)\s*[,)\]]/,
  /\bTextDecoder\b/,
  /\.copy\(/,
  /\bBuffer\.prototype\.\w+\.(?:call|apply|bind)\(/,
  /\[\s*\.\.\.\s*[\w.]*\b(?:current|previous)\b/,
];

const files = [...sourceFiles(srcDir), ...sourceFiles(testDir)]
  .map((path) => ({
    name: relative(serverDir, path).replaceAll('\\', '/'),
    code: withoutComments(readFileSync(path, 'utf8')),
  }))
  .filter((f) => f.name !== THIS_FILE);

describe('only TokenKeyring reads the token secret bytes (#58 A1, static check)', () => {
  it('scans the server sources and tests, and the real modules pass', () => {
    expect(files.filter((f) => f.name.startsWith('src/')).length).toBeGreaterThan(20);
    const names = files.map((f) => f.name);
    expect(names).toContain(SECRETS_MODULE);
    expect(names).toContain(KEYRING_MODULE);
    // Not stale: the keyring really imports and calls the accessor, and the
    // secrets module really holds the private storage.
    const keyring = files.find((f) => f.name === KEYRING_MODULE)!.code;
    expect(keyring).toMatch(
      /import\s*\{[^}]*\btokenSecretBytes\b[^}]*\}\s*from\s*'\.\.\/config\/token-secret\.js'/,
    );
    expect(keyring).toMatch(/\btokenSecretBytes\(/);
    expect(files.find((f) => f.name === SECRETS_MODULE)!.code).toMatch(PRIVATE_STORAGE);
    // The other modules that use the secrets module are seen as importers.
    const importers = files.filter((f) =>
      [...f.code.matchAll(FROM_STATEMENT)].some((m) => isSecretsModule(f.name, m[4]!)),
    );
    expect(importers.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'src/config/load.ts',
        'src/main.ts',
        'src/server.ts',
        KEYRING_MODULE,
      ]),
    );
  });

  it('flags every way to reach the bytes it is meant to catch', () => {
    const other = 'src/groups/probe.ts';
    const probes: Array<[string, string]> = [
      [other, "import { tokenSecretBytes } from '../config/token-secret.js';"],
      [other, "import { tokenSecretBytes as open } from '../config/token-secret.js';"],
      [
        other,
        "import {\n  type TokenSecrets,\n  tokenSecretBytes as b,\n} from '../config/token-secret.js';",
      ],
      [other, "import * as secretsModule from '../config/token-secret.js';"],
      [other, "import whole from '../config/token-secret.js';"],
      [other, "import whole, { parseTokenSecrets } from '../config/token-secret.js';"],
      [other, "const m = await import('../config/token-secret.js');"],
      [other, 'const m = await import(path);'],
      [other, 'const m = await import(`../config/${name}.js`);'],
      [other, "export * from '../config/token-secret.js';"],
      [other, "export { parseTokenSecrets as p } from '../config/token-secret.js';"],
      [other, "const read = mod['tokenSecret' + 'Bytes'] ?? mod['tokenSecretBytes'];"],
      [other, 'const raw = secrets.#current;'],
      [other, 'readSecretBytes(secrets);'],
      ['src/server.ts', "import { tokenSecretBytes as x } from './config/token-secret.js';"],
      [
        'test/probe.test.ts',
        "import { tokenSecretBytes as x } from '../src/config/token-secret.js';",
      ],
      [KEYRING_MODULE, "export { tokenSecretBytes } from '../config/token-secret.js';"],
      [KEYRING_MODULE, 'export { tokenSecretBytes };'],
      [KEYRING_MODULE, "const text = bytes.current.toString('hex');"],
      [KEYRING_MODULE, 'const copy = Buffer.from(bytes.previous);'],
      [KEYRING_MODULE, 'const all = [...bytes.current];'],
      [SECRETS_MODULE, 'export let readSecretBytes = () => undefined;'],
    ];
    for (const [file, code] of probes) {
      expect(violations(file, code), `${file}: ${code}`).not.toEqual([]);
    }
  });

  it('accepts the import forms the server uses', () => {
    const clean: Array<[string, string]> = [
      [
        'src/config/load.ts',
        "import { type TokenSecrets, collectTokenSecrets } from './token-secret.js';",
      ],
      ['src/main.ts', "import type { TokenSecrets } from './config/token-secret.js';"],
      ['src/main.ts', "const { connectRedis } = await import('./storage/redis/connect.js');"],
      ['src/server.ts', "import * as path from 'node:path';"],
      ['src/server.ts', "import { readFile } from './config/token-secrets-other.js';"],
      ['test/probe.test.ts', "import { redactTokenSecrets } from '../src/config/token-secret.js';"],
      [
        KEYRING_MODULE,
        "import { type TokenSecrets, tokenSecretBytes } from '../config/token-secret.js';",
      ],
      [KEYRING_MODULE, 'const bytes = tokenSecretBytes(this.secrets);'],
    ];
    for (const [file, code] of clean) {
      expect(violations(file, code), `${file}: ${code}`).toEqual([]);
    }
  });

  it('finds no module but TokenKeyring reaching the secret bytes', () => {
    for (const { name, code } of files) expect(violations(name, code), name).toEqual([]);
  });
});

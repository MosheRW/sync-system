import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for #58 security advisory A1 (Gate 3 round 3, widened in
 * round 4). A `TokenSecrets` keeps its bytes in private fields of the class
 * in `config/token-secret.ts`; the only way to them is `tokenSecretBytes`,
 * and only `tokens/token-keys.ts` (the HKDF input) may use it. The check
 * goes by module structure, not by variable names, so an alias cannot hide
 * a read:
 * - no module but `token-keys.ts` names `tokenSecretBytes` at all (import,
 *   `as` alias, re-export, `mod['tokenSecretBytes']`);
 * - every other import of the secrets module is a static named import: no
 *   `import * as`, default import, `export * from`, `export … from`, and no
 *   dynamic `import()` of it;
 * - no `require(…)` of it (CommonJS `require`, `module.require`, or a
 *   `createRequire` result under any name, or chained), and no other string
 *   naming it (`vi.mock`, `import.meta.resolve`, …) outside a static import;
 * - no dynamic `import()` or `require(…)` with a computed specifier, except
 *   the ones reviewed by hand in `REVIEWED_COMPUTED_LOADS`;
 * - the private storage (`#current`, `#previous`, `readSecretBytes`) is
 *   named only in the secrets module, and `readSecretBytes` is not exported;
 * - `token-keys.ts` never re-exports the accessor and never decodes or
 *   copies the bytes.
 * The secrets module is matched by relative path, by package path
 * (`@mosherw/sync-system-server/src/…` or `/dist/…`) and by any path ending
 * in `config/token-secret`. Every workspace is scanned, not only the server:
 * the client and React packages deep-import the server sources in their
 * tests (`test/helpers/real-server.ts`), so test files everywhere are held
 * to the same rules.
 */
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(serverDir, '..', '..');

/** The module that owns the private storage and the accessor. */
const SECRETS_MODULE = 'apps/sync-server/src/config/token-secret.ts';
/** The only module that may use the accessor. */
const KEYRING_MODULE = 'apps/sync-server/src/tokens/token-keys.ts';
/** This file names the accessor in its patterns and probes. */
const THIS_FILE = 'apps/sync-server/test/token-secret-readers.test.ts';
/** The server workspace; the private storage rule applies inside it. */
const SERVER_WORKSPACE = 'apps/sync-server/';

const ACCESSOR = 'tokenSecretBytes';
const PRIVATE_STORAGE = /#current\b|#previous\b|\breadSecretBytes\b/;

/**
 * Computed module loads reviewed by hand: per file, the number of
 * `import(…)` / `require(…)` calls whose specifier is not a string literal.
 * A different count in that file (more or fewer) is a violation, so a new
 * computed load needs a new review.
 */
const REVIEWED_COMPUTED_LOADS: Readonly<Record<string, number>> = {
  // Not a load: text of a generated module (Markdown chapters, Vite `?raw`).
  'apps/reader/plugins/library.ts': 1,
  // A test title ("import (AC7)") and a child script importing the built
  // package from its argv.
  'packages/client/test/ssr-import.test.ts': 2,
  'packages/react/test/import.node.test.ts': 2,
  // Loads ESLint from the path `createRequire(...).resolve('eslint')` gives.
  'packages/react/test/package.test.ts': 1,
};

/** Directories (from the repo root) that hold code. */
const SCAN_ROOTS = ['apps', 'packages', 'scripts'];
/** Build output, dependencies and static assets: not code we write. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-server',
  'public',
  'content',
  'coverage',
  'test-results',
  'playwright-report',
]);
const CODE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
    }
    return CODE_EXTENSION.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** `text` without comments, so a doc comment never trips (or hides) a check. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `path` with `/` separators and without its code extension. */
function stem(path: string): string {
  return path.replaceAll('\\', '/').replace(CODE_EXTENSION, '');
}

/**
 * The secrets module as a package path (sources or built output), or as
 * any path ending in `config/token-secret` (absolute paths, `file:` URLs,
 * path aliases).
 */
const SECRETS_PATH = /^@mosherw\/sync-system-server\/(?:src|dist)\/config\/token-secret$/;
const SECRETS_PATH_SUFFIX = /(?:^|\/)config\/token-secret$/;

/** Whether `specifier`, loaded from `file` (relative to the repo root), is the secrets module. */
function isSecretsModule(file: string, specifier: string): boolean {
  const bare = stem(specifier);
  if (SECRETS_PATH.test(bare) || SECRETS_PATH_SUFFIX.test(bare)) return true;
  if (!specifier.startsWith('.')) return false;
  const target = relative(repoRoot, resolve(repoRoot, dirname(file), specifier));
  return stem(target) === stem(SECRETS_MODULE);
}

/** `import … from '…'` and `export … from '…'`, with the clause and the specifier. */
const FROM_STATEMENT =
  /\b(import|export)\s+(?:type\s+)?((?:[\w$]+\s*,\s*)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+))\s*from\s*(['"])([^'"]+)\3/g;
/** A dynamic `import(…)`; group 2 is a plain string literal specifier, if any. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(['"])([^'"]+)\1\s*\)|(?!['"][^'"]+['"]\s*\)))/g;
/** A string literal (quotes, or a template without `${`); group 2 is its text. */
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n$]|\$(?!\{))*)\1/g;
/** The argument of a call: group 2 is a plain string literal, if any. */
const CALL_ARGUMENT = String.raw`\s*\(\s*(?:(['"])([^'"]+)\1\s*\)|(?!['"][^'"]+['"]\s*\)))`;

/**
 * The specifier of every `require`-like call in `code` (undefined when it
 * is computed): `require(…)` and `x.require(…)`, a call of any name a
 * `createRequire(…)` result is assigned to, and `createRequire(…)(…)`.
 */
function requireCalls(code: string): Array<string | undefined> {
  const names = new Set(['require']);
  for (const m of code.matchAll(/([\w$]+)\s*=\s*createRequire\s*\(/g)) names.add(m[1]!);
  const callees = [...names].map((name) => name.replaceAll('$', '\\$')).join('|');
  const calls = new RegExp(`(?<![\\w$])(?:${callees})${CALL_ARGUMENT}`, 'g');
  const chained = new RegExp(
    String.raw`\bcreateRequire\s*\([^()]*(?:\([^()]*\)[^()]*)*\)` + CALL_ARGUMENT,
    'g',
  );
  return [...code.matchAll(calls), ...code.matchAll(chained)].map((m) => m[2]);
}

/** Every rule `code` (comments removed) of the module `file` breaks; empty when it is clean. */
function violations(file: string, code: string): string[] {
  const found: string[] = [];
  const isOwner = file === SECRETS_MODULE;
  const isKeyring = file === KEYRING_MODULE;

  if (!isOwner && !isKeyring && code.includes(ACCESSOR)) {
    found.push(`names ${ACCESSOR}`);
  }
  if (file.startsWith(SERVER_WORKSPACE) && !isOwner && PRIVATE_STORAGE.test(code)) {
    found.push('names the private secret storage');
  }

  let staticImports = 0;
  for (const match of code.matchAll(FROM_STATEMENT)) {
    const [, keyword, clause, , specifier] = match;
    if (!isSecretsModule(file, specifier!)) continue;
    staticImports += 1;
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

  let computedLoads = 0;
  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[2];
    if (specifier === undefined) computedLoads += 1;
    else if (isSecretsModule(file, specifier)) found.push('imports the secrets module dynamically');
  }
  for (const specifier of requireCalls(code)) {
    if (specifier === undefined) computedLoads += 1;
    else if (isSecretsModule(file, specifier)) found.push('requires the secrets module');
  }
  if (computedLoads !== (REVIEWED_COMPUTED_LOADS[file] ?? 0)) {
    found.push(`has ${computedLoads} dynamic import or require call(s) with a computed specifier`);
  }

  const named = [...code.matchAll(STRING_LITERAL)].filter((m) => isSecretsModule(file, m[2]!));
  if (named.length > staticImports) {
    found.push('names the secrets module outside a static import');
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

const files = SCAN_ROOTS.flatMap((dir) => sourceFiles(join(repoRoot, dir)))
  .map((path) => ({
    name: relative(repoRoot, path).replaceAll('\\', '/'),
    code: withoutComments(readFileSync(path, 'utf8')),
  }))
  .filter((f) => f.name !== THIS_FILE);

const CLIENT_HELPER = 'packages/client/test/helpers/real-server.ts';
const REACT_HELPER = 'packages/react/test/helpers/real-server.ts';

describe('only TokenKeyring reads the token secret bytes (#58 A1, static check)', () => {
  it('scans every workspace, and the real modules pass', () => {
    const names = files.map((f) => f.name);
    expect(names.filter((n) => n.startsWith('apps/sync-server/src/')).length).toBeGreaterThan(20);
    expect(names.filter((n) => n.startsWith('apps/sync-server/test/')).length).toBeGreaterThan(20);
    for (const dir of ['packages/client/test/', 'packages/react/test/', 'apps/reader/']) {
      expect(names.filter((n) => n.startsWith(dir)).length, dir).toBeGreaterThan(5);
    }
    expect(names).toEqual(
      expect.arrayContaining([SECRETS_MODULE, KEYRING_MODULE, CLIENT_HELPER, REACT_HELPER]),
    );
    expect(names).toEqual(expect.arrayContaining(Object.keys(REVIEWED_COMPUTED_LOADS)));
    expect(names.some((n) => n.split('/').some((part) => SKIPPED_DIRS.has(part)))).toBe(false);
    // Not stale: the keyring really imports and calls the accessor, and the
    // secrets module really holds the private storage.
    const keyring = files.find((f) => f.name === KEYRING_MODULE)!.code;
    expect(keyring).toMatch(
      /import\s*\{[^}]*\btokenSecretBytes\b[^}]*\}\s*from\s*'\.\.\/config\/token-secret\.js'/,
    );
    expect(keyring).toMatch(/\btokenSecretBytes\(/);
    expect(files.find((f) => f.name === SECRETS_MODULE)!.code).toMatch(PRIVATE_STORAGE);
    // The modules that use the secrets module, by relative and by package
    // path, are seen as importers.
    const importers = files.filter((f) =>
      [...f.code.matchAll(FROM_STATEMENT)].some((m) => isSecretsModule(f.name, m[4]!)),
    );
    expect(importers.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'apps/sync-server/src/config/load.ts',
        'apps/sync-server/src/main.ts',
        'apps/sync-server/src/server.ts',
        KEYRING_MODULE,
        CLIENT_HELPER,
      ]),
    );
  });

  it('flags every way to reach the bytes it is meant to catch', () => {
    const other = 'apps/sync-server/src/groups/probe.ts';
    const serverTest = 'apps/sync-server/test/probe.test.ts';
    const clientTest = 'packages/client/test/probe.test.ts';
    const pkg = '@mosherw/sync-system-server/src/config/token-secret.js';
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
      [
        'apps/sync-server/src/server.ts',
        "import { tokenSecretBytes as x } from './config/token-secret.js';",
      ],
      [serverTest, "import { tokenSecretBytes as x } from '../src/config/token-secret.js';"],
      // Package paths and deep relative paths from other workspaces.
      [clientTest, `import * as s from '${pkg}';`],
      [clientTest, "import * as s from '@mosherw/sync-system-server/dist/config/token-secret.js';"],
      [clientTest, "import * as s from '../../../apps/sync-server/src/config/token-secret.js';"],
      [clientTest, `export { redactTokenSecrets } from '${pkg}';`],
      [clientTest, `const m = await import('${pkg}');`],
      [clientTest, "const m = await import('/repo/apps/sync-server/src/config/token-secret.ts');"],
      // require and createRequire, under any name.
      [other, "const m = require('../config/token-secret.js');"],
      [other, 'const m = require(path);'],
      [other, "const m = module.require('../config/token-secret.js');"],
      [clientTest, `const load = createRequire(import.meta.url);\nconst m = load('${pkg}');`],
      [clientTest, 'let load;\nload = createRequire(import.meta.url);\nconst m = load(target);'],
      [clientTest, `const m = createRequire(import.meta.url)('${pkg}');`],
      [clientTest, 'const m = createRequire(join(root, "x.json"))(target);'],
      // Any other string naming the module.
      [serverTest, "vi.mock('../src/config/token-secret.js', async (orig) => orig());"],
      [clientTest, `const url = import.meta.resolve('${pkg}');`],
      [clientTest, `const path = \`${pkg}\`;`],
      // A reviewed file with one computed load more than reviewed.
      ['packages/react/test/package.test.ts', 'await import(a);\nawait import(b);'],
      [
        'apps/sync-server/src/tokens/token-keys.ts',
        `export { ${ACCESSOR} } from '../config/token-secret.js';`,
      ],
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

  it('accepts the import forms the workspaces use', () => {
    const clean: Array<[string, string]> = [
      [
        'apps/sync-server/src/config/load.ts',
        "import { type TokenSecrets, collectTokenSecrets } from './token-secret.js';",
      ],
      [
        'apps/sync-server/src/main.ts',
        "import type { TokenSecrets } from './config/token-secret.js';",
      ],
      [
        'apps/sync-server/src/main.ts',
        "const { connectRedis } = await import('./storage/redis/connect.js');",
      ],
      ['apps/sync-server/src/server.ts', "import * as path from 'node:path';"],
      [
        'apps/sync-server/src/server.ts',
        "import { readFile } from './config/token-secrets-other.js';",
      ],
      [
        'apps/sync-server/test/probe.test.ts',
        "import { redactTokenSecrets } from '../src/config/token-secret.js';",
      ],
      [
        CLIENT_HELPER,
        "import type { TokenSecretsInput } from '@mosherw/sync-system-server/src/config/token-secret.js';",
      ],
      [
        'packages/client/test/probe.test.ts',
        "const require = createRequire(import.meta.url);\nconst tsc = require.resolve('typescript/bin/tsc');",
      ],
      [
        'packages/react/test/package.test.ts',
        "const requireRoot = createRequire(root);\nconst { ESLint } = await import(pathToFileURL(requireRoot.resolve('eslint')).href);",
      ],
      ['packages/client/test/probe.test.ts', "const ws = require('ws');"],
      [
        KEYRING_MODULE,
        "import { type TokenSecrets, tokenSecretBytes } from '../config/token-secret.js';",
      ],
      [KEYRING_MODULE, 'const bytes = tokenSecretBytes(this.secrets);'],
      ['packages/client/src/probe.ts', 'class Cursor {\n  #current = 0;\n}'],
    ];
    for (const [file, code] of clean) {
      expect(violations(file, code), `${file}: ${code}`).toEqual([]);
    }
  });

  it('finds no module but TokenKeyring reaching the secret bytes', () => {
    for (const { name, code } of files) expect(violations(name, code), name).toEqual([]);
  });
});

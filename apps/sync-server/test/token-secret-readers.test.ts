import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for #58 security advisory A1: a redacted secret Buffer still
 * gives its bytes to an explicit `toString(encoding)`, `Buffer.from()` or a
 * `Buffer.prototype` method called on it, so only the module that builds the
 * secrets and `TokenKeyring` (the HKDF input) may read `current` /
 * `previous` of a `TokenSecrets`, and neither may decode or copy them.
 * The check goes by name (a value named `*secrets` / `*Secrets`, the name
 * every server module uses for them); a read through an alias with another
 * name is left to review.
 */
const srcDir = fileURLToPath(new URL('../src', import.meta.url));

/** The only modules that may read the secret Buffers. */
const READERS = ['config/token-secret.ts', 'tokens/token-keys.ts'];

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

/**
 * `text` with string literal contents removed (`${...}` expressions of a
 * template literal are kept), so a message that names
 * `tokenSecrets.current` is not a read.
 */
function withoutStrings(text: string): string {
  return text
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, (literal) =>
      [...literal.matchAll(/\$\{([^}]*)\}/g)].map((m) => `\${${m[1]}}`).join(''),
    );
}

const files = sourceFiles(srcDir).map((path) => {
  const code = withoutComments(readFileSync(path, 'utf8'));
  return {
    name: relative(srcDir, path).replaceAll('\\', '/'),
    code,
    bare: withoutStrings(code),
  };
});

/** A property read of a secret: `secrets.current`, `tokenSecrets?.previous`, `x.secrets.current`. */
const SECRET_FIELD_READ = /\b\w*[sS]ecrets\??\.(?:current|previous)\b/;
/** The same through brackets: `secrets['current']`. */
const SECRET_FIELD_INDEX = /\b\w*[sS]ecrets\??\.?\[\s*['"`](?:current|previous)['"`]\s*\]/;
/** Destructuring a secret: `const { current } = tokenSecrets`. */
const SECRET_DESTRUCTURE =
  /\{[^{}]*\b(?:current|previous)\b[^{}]*\}\s*(?::[^=;]*)?=\s*[\w.]*[sS]ecrets\b/;
/** Every own value of the secrets at once: `Object.values(secrets)`. */
const SECRET_ALL_VALUES = /\bObject\.(?:values|entries)\(\s*[\w.]*[sS]ecrets\s*\)/;

/** Decoding or copying a secret Buffer in a reader module. */
const SECRET_DECODE = [
  /\b(?:current|previous)\??\.(?:toString|toLocaleString|toJSON|subarray|slice|values|entries|at|join|map|reduce|forEach)\s*\(/,
  /\bBuffer\.(?:from|concat|copyBytesFrom)\(\s*\[?\s*[\w.]*\b(?:current|previous)\s*[,)\]]/,
  /\bTextDecoder\b/,
  /\.copy\(/,
  /\bBuffer\.prototype\.\w+\.(?:call|apply|bind)\(/,
  /\[\s*\.\.\.\s*[\w.]*\b(?:current|previous)\b/,
];

describe('only TokenKeyring and the secrets module read secret bytes (#58 A1, static check)', () => {
  it('scans the server sources and the reader modules', () => {
    expect(files.length).toBeGreaterThan(20);
    const names = files.map((f) => f.name);
    for (const reader of READERS) expect(names).toContain(reader);
    // The readers really do read them, so the patterns are not stale.
    const keyring = files.find((f) => f.name === 'tokens/token-keys.ts')!;
    expect(keyring.bare).toMatch(SECRET_FIELD_READ);
  });

  it('matches the read, destructure and decode forms it is meant to catch', () => {
    for (const read of [
      'deriveAppKey(tokenSecrets.current, ns)',
      'options.tokenSecrets?.previous',
      'this.secrets.current',
    ]) {
      expect(read).toMatch(SECRET_FIELD_READ);
    }
    expect("secrets['current']").toMatch(SECRET_FIELD_INDEX);
    expect('tokenSecrets?.["previous"]').toMatch(SECRET_FIELD_INDEX);
    expect('const { current, previous } = tokenSecrets;').toMatch(SECRET_DESTRUCTURE);
    expect('const { current }: TokenSecrets = options.tokenSecrets;').toMatch(SECRET_DESTRUCTURE);
    expect('Object.values(tokenSecrets)').toMatch(SECRET_ALL_VALUES);
    for (const decode of [
      'current.toString()',
      "previous?.toString('hex')",
      'current.subarray(0)',
      'current.slice(1)',
      'Buffer.from(current)',
      'Buffer.from(this.secrets.previous, 0)',
      'Buffer.concat([current])',
      'new TextDecoder().decode(current)',
      'current.copy(target)',
      'Buffer.prototype.toString.call(current)',
      '[...current]',
    ]) {
      expect(
        SECRET_DECODE.some((rule) => rule.test(decode)),
        decode,
      ).toBe(true);
    }
    // Not a read: a message naming the field, a field of another object.
    expect(withoutStrings("'(tokenSecrets.current must be a Buffer)'")).not.toMatch(
      SECRET_FIELD_READ,
    );
    expect('const { current, previous } = value as Shape;').not.toMatch(SECRET_DESTRUCTURE);
    expect("Buffer.from(current.value, 'utf8')").not.toMatch(SECRET_DECODE[1]!);
    expect(withoutStrings('`${tokenSecrets.current}`')).toMatch(SECRET_FIELD_READ);
  });

  it('reads current/previous of the token secrets only in the reader modules', () => {
    for (const { name, code, bare } of files) {
      if (READERS.includes(name)) continue;
      expect(bare, name).not.toMatch(SECRET_FIELD_READ);
      expect(code, name).not.toMatch(SECRET_FIELD_INDEX);
      expect(bare, name).not.toMatch(SECRET_DESTRUCTURE);
      expect(bare, name).not.toMatch(SECRET_ALL_VALUES);
    }
  });

  it('never decodes or copies a secret Buffer in the reader modules', () => {
    for (const { name, bare } of files.filter((f) => READERS.includes(f.name))) {
      for (const rule of SECRET_DECODE) expect(bare, name).not.toMatch(rule);
    }
  });
});

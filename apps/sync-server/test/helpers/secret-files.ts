import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

/**
 * Temp files for `_FILE` tests (#58). Created with mode 600, removed by
 * `cleanup()` (security C9). Paths only; never a real secret.
 */
export interface SecretFileDir {
  readonly dir: string;
  /** Writes `content` to `name` in the dir and returns its path. */
  file(name: string, content: string | Buffer): string;
  cleanup(): void;
}

export function secretFileDir(prefix = 'sync-secret-'): SecretFileDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    file(name, content) {
      const path = join(dir, name);
      writeFileSync(path, content, { mode: 0o600 });
      return path;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The forms a leaked secret could take in output: plain, hex (plain and spaced) and base64. */
export function sentinelForms(sentinel: string): string[] {
  const bytes = Buffer.from(sentinel, 'utf8');
  const hex = bytes.toString('hex');
  return [
    sentinel,
    hex,
    hex.match(/../g)!.join(' '),
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url').replace(/=+$/, ''),
  ];
}

/** Asserts no form of `sentinel` appears in `text` (AC7, security C9). */
export function expectNoSentinel(text: string, sentinel: string): void {
  for (const form of sentinelForms(sentinel)) {
    expect(text.toLowerCase(), 'secret leaked').not.toContain(form.toLowerCase());
  }
}

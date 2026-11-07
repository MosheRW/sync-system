// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReaderConfig } from '../src/config/schema.js';

const compose = readFileSync(join(import.meta.dirname, '..', '..', '..', 'compose.yaml'), 'utf8');

/** The `reader` service block: from its key to the end of the file (it is the last service). */
const readerBlock = compose.slice(compose.search(/^ {2}reader:$/m));

/** `KEY: value` lines of the reader's `environment:` map (uncommented only). */
function readerEnvironment(): Record<string, string> {
  const start = readerBlock.indexOf('    environment:\n');
  const lines = readerBlock.slice(start).split('\n').slice(1);
  const env: Record<string, string> = {};
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const match = /^ {6}([A-Z_]+):\s*'?([^']*)'?\s*$/.exec(line);
    if (!match) break;
    env[match[1]!] = match[2]!;
  }
  return env;
}

describe('compose reader service (#24 AC3, security R13)', () => {
  const env = readerEnvironment();

  it('wires the reader to the local sync server with the public dev key', () => {
    expect(env['READER_SYNC_URL']).toBe('ws://127.0.0.1:8080/ws');
    expect(env['READER_SYNC_API_KEY']).toBe('dev-only-insecure-api-key-change-me-please');
  });

  it('gets only reader variables, no shared env file and no token secret', () => {
    for (const name of Object.keys(env)) {
      expect(name, name).toMatch(/^(READER_[A-Z_]+|PORT|HOST)$/);
    }
    expect(readerBlock).not.toMatch(/env_file|TOKEN_SECRET/);
  });

  it('is a config the reader accepts (with the expected production warnings)', () => {
    const config = parseReaderConfig({ ...env, NODE_ENV: 'production' }, ['samples/psalms-he']);
    expect(config.sync?.url).toBe('ws://127.0.0.1:8080/ws');
    expect(config.warnings).toHaveLength(2);
  });
});

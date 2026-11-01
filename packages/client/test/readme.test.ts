import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientErrorCode } from '../src/errors.js';

const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');

describe('README drift guard (AC31)', () => {
  it('mentions every error code', () => {
    for (const code of Object.values(ClientErrorCode)) {
      expect(readme, code).toContain(`\`${code}\``);
    }
  });

  it('mentions every connection state and indicator value', () => {
    for (const name of [
      'idle',
      'connecting',
      'connected',
      'reconnecting',
      'closed',
      'following',
      'leading',
      'leader_offline',
      'none',
    ]) {
      expect(readme, name).toContain(`\`${name}\``);
    }
  });

  it('documents the reconnect defaults', () => {
    for (const text of ['`500`', '`10000`', '`Infinity`', 'stableAfterMs', '30 s']) {
      expect(readme).toContain(text);
    }
  });
});

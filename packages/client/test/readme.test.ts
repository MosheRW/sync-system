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

  it('no longer documents join by group ID (#10 AC41)', () => {
    expect(readme).not.toContain('joinGroup');
    expect(readme).not.toMatch(/`group\.join`/);
  });

  it('documents the join flows, the leader API and QR deep links (#10 AC43)', () => {
    for (const text of [
      '## Joining a group',
      '### Leader API',
      '### QR tickets and deep links',
      'URL **fragment**',
      'history.replaceState',
      'bearer credential',
      'Render display names as text only',
      '`awaiting_approval`',
    ]) {
      expect(readme, text).toContain(text);
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
      'leader_grace',
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

  it('documents token storage, recovery and the XSS caveat (#5 AC41)', () => {
    for (const text of [
      '### Token storage',
      '### `checkTokens()`',
      '### `resumeGroup(groupId, options?)`',
      '### Block list',
      '### Ending and leaving',
      'XSS caveat',
      'forgetAllGroups()',
      'sync-system:v1:<namespace>@<host[:port]>',
      '`replaced`',
      '`waiting`',
    ]) {
      expect(readme, text).toContain(text);
    }
  });
});

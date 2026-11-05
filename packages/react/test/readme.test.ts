import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

const root = join(import.meta.dirname, '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const flat = readme.replace(/\s+/g, ' ');
const clientReadme = readFileSync(join(root, '..', 'client', 'README.md'), 'utf8').replace(
  /\s+/g,
  ' ',
);

/** Runtime exports re-exported from the core, documented in the client README. */
const CORE_EXPORTS = new Set([
  'ClientErrorCode',
  'SyncClient',
  'SyncClientError',
  'indicatorOf',
  'isSyncClientError',
]);

describe('README drift guard (AC28)', () => {
  it('names every runtime export of the package', () => {
    for (const name of Object.keys(api)) {
      if (CORE_EXPORTS.has(name)) continue;
      expect(readme, name).toMatch(new RegExp(`[\`<]${name}\\b`));
    }
  });

  it('has the install, Next, SSR, StrictMode and no-auto-retry sections', () => {
    for (const heading of [
      '## Install',
      '## Provider setup',
      '### Next.js App Router',
      '### Next.js Pages Router',
      '## Server-side rendering',
      '## StrictMode',
      '## No automatic retry after a fatal error',
      '## Hooks',
      '#### Update required',
      '#### QR re-issue',
      '## Components',
      '## Credentials and untrusted text',
    ]) {
      expect(readme, heading).toContain(heading);
    }
    expect(readme).toContain("'use client';");
    expect(readme).toContain('pages/_app.tsx');
  });

  it('forbids re-keying or remounting the provider to retry (R4)', () => {
    expect(flat).toContain(
      'Never remount or re-key the provider to retry after a fatal close or a removal.',
    );
    expect(flat).toContain(
      'Use a `key` only for a deliberate configuration change, with a stable value',
    );
    expect(flat).toContain('`<Activity>`');
    expect(flat).toContain('useConnection().retry()');
  });

  it('states that groupId, codes and tickets are credentials (AC27, R12)', () => {
    expect(flat).toContain('`groupId`, join codes and QR tickets are credentials.');
    expect(flat).toContain('never put them in URLs except the QR ticket in a URL fragment');
    for (const text of ['display names', '`serverMessage`', '`metadata`', '`position`']) {
      expect(flat, text).toContain(text);
    }
    expect(flat).toContain('allow `https:` only, never `javascript:`');
  });

  it('documents the QR rules (R1, R2, R8) and the Gate 2 decisions (Q-A to Q-D)', () => {
    expect(flat).toContain('`rotated`, `resumed`, `member_removed` or `superseded`');
    expect(flat).toContain('within 10 s of the last issue');
    expect(flat).toContain('`enabled: false`');
    expect(flat).toContain('visibilitychange');
    expect(flat).toContain('a leaked code needs `rotate`, not just a lock');
    expect(flat).toContain('`paused` (`JOIN_PAUSED`');
    expect(flat).toContain("from the provider's mount on");
    expect(flat).toContain(
      '`checkOnConnect: true` checks once per connected session (default `false`)',
    );
  });

  it('warns about useSyncClient and two owned providers (R7, R11)', () => {
    expect(flat).toContain('`useSyncClient()` is an escape hatch');
    expect(flat).toContain('One owned provider per app and storage namespace.');
  });

  it('exports no join by group ID', () => {
    expect(readme).not.toContain('joinGroup');
  });
});

describe('client README follow-ups (#15)', () => {
  it('links the React package and lists every revoking code change (R1)', () => {
    expect(clientReadme).toContain('../react/README.md');
    expect(clientReadme).not.toContain('item 6');
    expect(clientReadme).toContain(
      'at once after `codesChanged` with reason `rotated`, `resumed`, `member_removed` or `superseded`',
    );
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as protocol from '@mosherw/sync-system-protocol';
import * as api from '../src/index.js';

const root = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('package (AC1)', () => {
  it('depends at runtime only on @mosherw/sync-system-protocol', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@mosherw/sync-system-protocol']);
  });

  it('has no node, ws or UI framework imports in src', () => {
    const forbidden =
      /from\s+['"](node:[^'"]*|ws|react|react-dom|vue)['"]|import\(\s*['"](node:|ws['"])/;
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(forbidden);
    }
  });
});

describe('public API (AC3)', () => {
  it('exports the runtime API from the entry point', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'CLIENT_PROTOCOL_VERSION',
        'ClientErrorCode',
        'MIN_SERVER_PROTOCOL_VERSION',
        'SyncClient',
        'SyncClientError',
        'createSyncClient',
        'indicatorOf',
        'isSyncClientError',
        'memoryStorage',
        // #13 AC41: the preview helper.
        'LeaderPreview',
        'LEADER_ACTIVITY_MIN_INTERVAL_MS',
        // #24 P2: the protocol's join input rules.
        'MAX_DISPLAY_NAME_INPUT_LENGTH',
        'MAX_DISPLAY_NAME_LENGTH',
        'MAX_JOIN_CODE_INPUT_LENGTH',
        'MAX_QR_TICKET_LENGTH',
        'classifyJoinCode',
        'isDoorCode',
        'isQrTicketShape',
        'normalizeJoinCode',
        'resolveDisplayName',
      ].sort(),
    );
    expect(api.createSyncClient).toBeTypeOf('function');
  });

  it('re-exports the protocol join helpers as the same objects (#24 P2, R14)', () => {
    expect(api.normalizeJoinCode).toBe(protocol.normalizeJoinCode);
    expect(api.classifyJoinCode).toBe(protocol.classifyJoinCode);
    expect(api.isDoorCode).toBe(protocol.isDoorCode);
    expect(api.isQrTicketShape).toBe(protocol.isQrTicketShape);
    expect(api.resolveDisplayName).toBe(protocol.resolveDisplayName);
    expect(api.MAX_JOIN_CODE_INPUT_LENGTH).toBe(protocol.MAX_JOIN_CODE_INPUT_LENGTH);
    expect(api.MAX_DISPLAY_NAME_INPUT_LENGTH).toBe(protocol.MAX_DISPLAY_NAME_INPUT_LENGTH);
    expect(api.MAX_DISPLAY_NAME_LENGTH).toBe(protocol.MAX_DISPLAY_NAME_LENGTH);
    expect(api.MAX_QR_TICKET_LENGTH).toBe(protocol.MAX_QR_TICKET_LENGTH);
    expect(api.classifyJoinCode(api.normalizeJoinCode(' 048-213 '))).toBe('group');
  });

  it('points package exports at the built ESM output and types', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      type: string;
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.exports['.']).toEqual({
      '@mosherw/sync-system-source': './src/index.ts',
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });
});

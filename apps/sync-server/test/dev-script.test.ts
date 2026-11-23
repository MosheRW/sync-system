import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { childEnv } from './helpers/child-env.js';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

function devScript(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts.dev ?? '';
}

describe('dev script', () => {
  it('enables the @mosherw/sync-system-source export condition', () => {
    expect(devScript().split(/\s+/)).toContain('--conditions=@mosherw/sync-system-source');
  });

  it('resolves @mosherw/sync-system-protocol to its TypeScript source, not dist', () => {
    // The node flags of the dev script: everything between `tsx watch` and the entry file.
    const args = devScript().split(/\s+/);
    const flags = args.slice(2, -1).filter((arg) => arg.startsWith('--'));
    const child = spawnSync(
      process.execPath,
      [
        ...flags,
        '--input-type=module',
        '-e',
        "console.log(import.meta.resolve('@mosherw/sync-system-protocol'))",
      ],
      { cwd: serverDir, env: childEnv({ NODE_OPTIONS: '' }), encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toMatch(/\/packages\/protocol\/src\/index\.ts$/);
  });
});

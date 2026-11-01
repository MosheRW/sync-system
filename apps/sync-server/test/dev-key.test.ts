import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppsConfig } from '../src/config/apps-config.js';
import { ConfigError } from '../src/config/config-error.js';
import { DEV_API_KEYS, checkDevKeys } from '../src/config/dev-key.js';
import { parseEnv } from '../src/config/env.js';

const env = parseEnv({});
const devConfigPath = fileURLToPath(new URL('../../../config/apps.dev.json', import.meta.url));
const devText = readFileSync(devConfigPath, 'utf8');
const devKey = (JSON.parse(devText) as { apps: Array<{ apiKey: string }> }).apps[0]!.apiKey;

function capture() {
  const lines: Array<{ obj: object; msg: string }> = [];
  return { lines, logger: { warn: (obj: object, msg: string) => lines.push({ obj, msg }) } };
}

describe('checkDevKeys (M6)', () => {
  it('knows the key committed in config/apps.dev.json', () => {
    expect(DEV_API_KEYS).toContain(devKey);
  });

  it('refuses the dev key in production, naming the namespace and not the key', () => {
    const apps = parseAppsConfig(devText, env);
    const { logger } = capture();
    let error: unknown;
    try {
      checkDevKeys(apps, 'production', logger);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      'apps[0] (namespace "dev-app") uses the public development API key; set a real key',
    );
    expect((error as Error).message).not.toContain(devKey);
  });

  it('only warns with the namespace outside production', () => {
    const apps = parseAppsConfig(devText, env);
    for (const nodeEnv of ['development', undefined, 'test']) {
      const { lines, logger } = capture();
      checkDevKeys(apps, nodeEnv, logger);
      expect(lines).toEqual([
        { obj: { event: 'dev_api_key', namespace: 'dev-app' }, msg: 'dev api key in use' },
      ]);
      expect(JSON.stringify(lines)).not.toContain(devKey);
    }
  });

  it('accepts real keys in production silently', () => {
    const apps = parseAppsConfig(
      JSON.stringify({
        apps: [{ namespace: 'real', apiKey: 'r'.repeat(40), minAppVersion: '1.0.0' }],
      }),
      env,
    );
    const { lines, logger } = capture();
    checkDevKeys(apps, 'production', logger);
    expect(lines).toEqual([]);
  });

  it('accepts the example config shape', () => {
    const examplePath = fileURLToPath(
      new URL('../../../config/apps.example.json', import.meta.url),
    );
    expect(parseAppsConfig(readFileSync(examplePath, 'utf8'), env)).toHaveLength(2);
  });
});

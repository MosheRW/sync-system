import { type AppConfig, hashApiKey } from '../apps/app-registry.js';
import { ConfigError } from './config-error.js';

/**
 * API keys that are public because they are committed to the repo
 * (`config/apps.dev.json`). They must never be accepted in production (M6).
 */
export const DEV_API_KEYS: readonly string[] = ['dev-only-insecure-api-key-change-me-please'];

const DEV_KEY_HASHES = new Set(DEV_API_KEYS.map(hashApiKey));

export interface WarnLogger {
  warn(obj: object, msg: string): void;
}

/**
 * With NODE_ENV=production any app using a public dev key is a ConfigError.
 * Otherwise each such app is logged as a warning naming only its namespace.
 */
export function checkDevKeys(
  apps: readonly AppConfig[],
  nodeEnv: string | undefined,
  logger: WarnLogger,
): void {
  apps.forEach((app, index) => {
    if (!DEV_KEY_HASHES.has(app.apiKeyHash)) return;
    if (nodeEnv === 'production') {
      throw new ConfigError(
        `apps[${index}] (namespace "${app.namespace}") uses the public development API key; set a real key`,
      );
    }
    logger.warn({ event: 'dev_api_key', namespace: app.namespace }, 'dev api key in use');
  });
}

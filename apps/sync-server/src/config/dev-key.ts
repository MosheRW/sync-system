import { type AppConfig, hashApiKey } from '../apps/app-registry.js';
import { ConfigError } from './config-error.js';

/**
 * API keys that are public because they are committed to the repo
 * (`config/apps.dev.json`). They must never be accepted in production (M6).
 */
export const DEV_API_KEYS: readonly string[] = ['dev-only-insecure-api-key-change-me-please'];

const DEV_KEY_HASHES = new Set(DEV_API_KEYS.map(hashApiKey));

/** The only NODE_ENV values (exact match) that allow a public dev key (S4). */
export const DEV_KEY_NODE_ENVS: readonly string[] = ['development', 'test'];

export interface WarnLogger {
  warn(obj: object, msg: string): void;
}

function allowsDevKey(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && DEV_KEY_NODE_ENVS.includes(nodeEnv);
}

/**
 * One problem per app using a public dev key, unless NODE_ENV is exactly
 * `development` or `test` (fail closed: unset or any other value refuses it).
 * Every such app is reported, not just the first (#36 AC38). Names the
 * namespace only, never the key.
 */
export function devKeyProblems(apps: readonly AppConfig[], nodeEnv: string | undefined): string[] {
  if (allowsDevKey(nodeEnv)) return [];
  const problems: string[] = [];
  apps.forEach((app, index) => {
    if (!DEV_KEY_HASHES.has(app.apiKeyHash)) return;
    problems.push(
      `apps[${index}] (namespace "${app.namespace}") uses the public development API key; set a real key`,
    );
  });
  return problems;
}

/**
 * Logs one warning per app using a public dev key, naming only its
 * namespace. Called once the config loaded, so only in development or test.
 */
export function warnDevKeys(apps: readonly AppConfig[], logger: WarnLogger): void {
  for (const app of apps) {
    if (!DEV_KEY_HASHES.has(app.apiKeyHash)) continue;
    logger.warn({ event: 'dev_api_key', namespace: app.namespace }, 'dev api key in use');
  }
}

/**
 * `devKeyProblems` as one ConfigError; when there is none, `warnDevKeys`.
 */
export function checkDevKeys(
  apps: readonly AppConfig[],
  nodeEnv: string | undefined,
  logger: WarnLogger,
): void {
  const problems = devKeyProblems(apps, nodeEnv);
  if (problems.length > 0) throw new ConfigError(problems);
  warnDevKeys(apps, logger);
}

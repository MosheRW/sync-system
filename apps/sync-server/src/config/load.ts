import type { AppConfig } from '../apps/app-registry.js';
import { collectAppsConfigFile } from './apps-config.js';
import { ConfigError } from './config-error.js';
import { devKeyProblems } from './dev-key.js';
import { type EnvSource, type ServerEnv, collectEnv } from './env.js';
import { collectUnknownVariables } from './known-vars.js';
import type { RedisSettings } from './redis.js';
import { type TokenSecrets, collectTokenSecrets } from './token-secret.js';

/** The whole startup config. Only ever returned when it has no problem. */
export interface LoadedConfig {
  env: ServerEnv;
  apps: AppConfig[];
  /** Never stored in ServerEnv and never logged (R4). */
  tokenSecrets: TokenSecrets;
  /** REDIS_* settings, or undefined for the memory store. Never logged (#35 security C9). */
  redis: RedisSettings | undefined;
}

/**
 * Loads and checks the whole startup config: env variables (REDIS_*
 * included), token secrets, unknown look-alike variables, the apps file and
 * dev keys. Every problem of every step is collected, in this fixed order,
 * and thrown together as one ConfigError, so an operator sees them all in
 * one run (#36 AC37, AC37a, AC38).
 *
 * Fail closed (#36 security C1): the config is returned only when there is
 * no problem at all. Collectors return `undefined` for a value that failed,
 * never a default.
 */
export function loadConfig(source: EnvSource): LoadedConfig {
  const problems: string[] = [];

  const collected = collectEnv(source, problems);
  const tokenSecrets = collectTokenSecrets(source, source.NODE_ENV, problems);
  // Names only, never values (#36 AC37a, ADR 0015, security C4).
  collectUnknownVariables(source, problems);

  let apps: AppConfig[] | undefined;
  if (collected.configPath !== undefined) {
    apps = collectAppsConfigFile(collected.configPath, collected.ceilings, problems);
    if (apps !== undefined) problems.push(...devKeyProblems(apps, source.NODE_ENV));
  }

  if (
    problems.length > 0 ||
    collected.env === undefined ||
    tokenSecrets === undefined ||
    apps === undefined
  ) {
    throw new ConfigError(problems);
  }
  return { env: collected.env, apps, tokenSecrets, redis: collected.redis };
}

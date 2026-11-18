import { TEST_HARNESS_PREFIX, isServerFamilyName } from '../../src/config/known-vars.js';

/**
 * The environment for a spawned server: `process.env` without any name in
 * the server's families (ADR 0015), plus `extra`. A developer's shell (a
 * stray `REDIS_URL`, `TOKEN_SECRET` or a typo) then cannot change or break
 * what a test starts. It only removes names; nothing is added beyond
 * `extra`. The test harness names (`SYNC_TEST_*`) are kept.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (isServerFamilyName(name) && !name.toUpperCase().startsWith(TEST_HARNESS_PREFIX)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

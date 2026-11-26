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

/**
 * How long a spawned `node --import tsx src/index.ts` may take to start (or
 * to fail to start) in a test. tsx loads the whole source tree in each child:
 * 6 to 10 s on a quiet machine, up to 47 s with the sync-server and reader
 * suites running in parallel (#87). Production runs the compiled build, so
 * this is a harness bound, not a server startup budget. 120 s is about 2.5
 * times the worst start measured.
 */
export const CHILD_START_MS = 120_000;

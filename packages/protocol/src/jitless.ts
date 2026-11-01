import { z } from 'zod';

/**
 * Runs `build` with zod's process-global `jitless` option switched on, then
 * puts the previous value back, also when `build` throws, so the setting
 * never leaks to other zod schemas in the same process. Internal: not
 * exported from the package.
 */
export function buildJitless<T>(build: () => T): T {
  const previous = z.config().jitless;
  z.config({ jitless: true });
  try {
    return build();
  } finally {
    z.config({ jitless: previous });
  }
}

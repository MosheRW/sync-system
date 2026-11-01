/** Polls `condition` until it is true or `timeoutMs` passes. Real timers only. */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  description = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `condition` until it is true or `timeoutMs` passes. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  description = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

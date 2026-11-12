import { describe, expect, it } from 'vitest';

describe('Redis-backed suites in CI (#35 AC31)', () => {
  it('has a test Redis whenever CI is set, so the *.redis.test.ts suites never skip silently', () => {
    if (process.env.CI !== 'true') return;
    expect(process.env.SYNC_TEST_REDIS_URL, 'set SYNC_TEST_REDIS_URL in CI').toBeTruthy();
  });
});

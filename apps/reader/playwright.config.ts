import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks against the built reader server and the real sync
 * server (#24 ADR 0008, AC25, AC34, AC35, AC56). Chromium only. No traces,
 * screenshots or videos: they would record codes and tickets (security L5,
 * R11). Run `pnpm build` first, then `pnpm --filter @mosherw/sync-system-reader test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

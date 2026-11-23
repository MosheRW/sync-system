import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@mosherw/sync-system-source', 'module', 'node', 'development|production'],
  },
  ssr: {
    resolve: {
      conditions: ['@mosherw/sync-system-source', 'module', 'node', 'development|production'],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // The real server (integration tests) accepts its test apps only in test.
    env: { NODE_ENV: 'test' },
    testTimeout: 15_000,
  },
});

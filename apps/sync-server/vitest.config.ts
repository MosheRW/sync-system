import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@sync-system/source', 'module', 'node', 'development|production'],
  },
  ssr: {
    resolve: {
      conditions: ['@sync-system/source', 'module', 'node', 'development|production'],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // The public dev key is only accepted in development and test (S4).
    env: { NODE_ENV: 'test' },
  },
});

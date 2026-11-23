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
  },
});

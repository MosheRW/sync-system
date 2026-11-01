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
  },
});

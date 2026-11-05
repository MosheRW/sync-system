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
    // jsdom by default; server-render and import tests opt into node with
    // `// @vitest-environment node` (Q7).
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    // The real server (integration tests) accepts its test apps only in test.
    env: { NODE_ENV: 'test' },
    testTimeout: 15_000,
  },
});

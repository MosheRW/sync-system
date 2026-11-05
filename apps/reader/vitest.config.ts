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
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  test: {
    // jsdom by default; fingerprint, server and plugin tests opt into node
    // with `// @vitest-environment node`.
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    env: { NODE_ENV: 'test' },
    testTimeout: 15_000,
  },
});

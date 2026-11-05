import { defineConfig } from 'vite';

// The build must not need 'unsafe-inline' or data: in the CSP (ADR 0006, C7):
// no inlined assets, no modulepreload polyfill (an inline script), no source
// maps shipped (C10).
export default defineConfig({
  resolve: {
    conditions: ['@sync-system/source', 'module', 'browser', 'development|production'],
  },
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  build: {
    target: 'es2023',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});

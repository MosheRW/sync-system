import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-server/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['apps/*/**/*.{ts,tsx}', 'packages/*/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // H4: an unhandled rejection crashes the process; never leave a promise floating.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The client runs in browsers, Node and SSR: no console (AC32), no Node or
    // framework modules (AC1), no browser globals read directly (AC7).
    files: ['packages/client/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: ['ws', 'react', 'react-dom', 'vue'],
          patterns: ['node:*'],
        },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage'],
    },
  },
  {
    // The React package (#15): no console or logger (AC27), no Node, ws, Next,
    // react-dom or server modules (AC2, Q3), no browser globals read directly
    // and no own connections or URL handling (L3, R10). host.ts is the only
    // globalThis reader.
    files: ['packages/react/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: ['ws', 'next', 'react-dom', '@sync-system/server'],
          patterns: ['node:*', 'next/*', 'react-dom/*', '@sync-system/server/*'],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'location',
        'history',
        'console',
        'WebSocket',
        'fetch',
        'XMLHttpRequest',
      ],
    },
  },
  {
    // The reading app's browser code (#19): integrates with the sync stack
    // only through @sync-system/react (AC19), never through other packages'
    // sources or Node modules; renders external text only as text (AC4, AC18,
    // security C6); no console.
    files: ['apps/reader/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@sync-system/server',
              message: 'The reading app never imports server internals (AC19).',
            },
            {
              name: '@sync-system/protocol',
              message: 'Use the types re-exported by @sync-system/react (AC19).',
            },
            {
              name: '@sync-system/client',
              message: 'Use the exports of @sync-system/react (AC19).',
            },
          ],
          patterns: ['@sync-system/*/src/*', '**/packages/**', '**/sync-server/**', 'node:*'],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render external text as React children only (AC4, AC18).',
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: 'Render external text as React children only (AC4, AC18).',
        },
      ],
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'HTML sinks are banned in the reading app (C6).' },
        { property: 'outerHTML', message: 'HTML sinks are banned in the reading app (C6).' },
        {
          property: 'insertAdjacentHTML',
          message: 'HTML sinks are banned in the reading app (C6).',
        },
        { object: 'document', property: 'write', message: 'HTML sinks are banned (C6).' },
        { object: 'document', property: 'writeln', message: 'HTML sinks are banned (C6).' },
      ],
    },
  },
  prettier,
);

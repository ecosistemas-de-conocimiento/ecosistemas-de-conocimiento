import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import noRawErrorLog from './eslint/noRawErrorLog.js';

// Shape mirrors services/ai-service/eslint.config.js (same base, same two
// rule options). Added 2026-10-28 on a tree that other lanes were editing, so
// the rules the existing code breaks are `warn`, not `error`, and no source
// file was touched. Counts below are measured: `pnpm exec eslint .` in
// apps/backend. Raise each to `error` once its count reaches 0.
export default tseslint.config(
  { ignores: ['.next/', 'node_modules/', 'media/', 'src/payload-types.ts', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 55 when added.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 14 when added. Option matches ai-service: inline `typeof import()` stays allowed.
      '@typescript-eslint/consistent-type-imports': ['warn', { disallowTypeAnnotations: false }],
      // 4 when added, all in e2e/support/api.ts.
      '@typescript-eslint/no-explicit-any': 'warn',
      // 1 each when added.
      'no-irregular-whitespace': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
    },
  },
  // P-07: a raw error's text can quote a database row (`eslint/noRawErrorLog.js`).
  // `error` from the start: tests are exempt, they log nothing that ships.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    ignores: ['**/*.test.ts', '**/*.spec.ts', 'e2e/**'],
    plugins: { edc: { rules: { 'no-raw-error-log': noRawErrorLog } } },
    rules: { 'edc/no-raw-error-log': 'error' },
  },
  // Plain-Node `.mjs` files have no @types/node declaration, so `no-undef`
  // needs the Node globals they use spelled out.
  {
    files: ['**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
      },
    },
  },
);

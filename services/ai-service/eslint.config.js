import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `**/dist/` (not just `dist/`) so vendored build output like
  // `packages/ai-client/dist/*.js` isn't linted — it's emitted JS, not source.
  { ignores: ['**/dist/', 'node_modules/', 'drizzle/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  // Plain-Node build/CI scripts. The TS sources get their Node globals from
  // `@types/node` via the type-aware config; a `.mjs` has no such declaration
  // file, so `js.configs.recommended`'s `no-undef` flags `process`/`console`.
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
);

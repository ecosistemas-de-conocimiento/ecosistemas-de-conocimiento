import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import noRawErrorLog from '../../apps/backend/eslint/noRawErrorLog.js';

export default tseslint.config(
  // `**/dist/` (not just `dist/`) so vendored build output like
  // `packages/ai-client/dist/*.js` isn't linted — it's emitted JS, not source.
  { ignores: ['**/dist/', 'node_modules/', 'drizzle/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // SEVERITY IS DELIBERATE, and it was not before. Both of these were `warn`
      // from the milestone-1 scaffold onward and never revisited, which meant
      // `npm run check` exited 0 carrying 55 warnings — a gate that could not go
      // red for anything these two rules cover. Measured.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `disallowTypeAnnotations: false` is the deliberate half of this. That arm
      // forbids inline `typeof import('./x')` and accounted for 43 of the 55
      // warnings; it is NOT auto-fixable, and nobody in this repo has ever
      // written down a position on that style. Turning it off keeps the rule that
      // matters — imports used only as types must say `import type` — and makes
      // it HARD, instead of keeping both soft. The purist alternative (restore
      // this arm and hand-edit 29 files) is written up as open item 23.
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    },
  },
  // P-07: a raw error's text can quote a database row. The backend's rule,
  // shared by path (`apps/backend/eslint/noRawErrorLog.js`); here it accepts
  // `{ err }` because every pino logger carries `errors/log-safe.ts`. Tests
  // are exempt, they log nothing that ships. No source file is skipped: the
  // 27 sites in 11 files once listed here were fixed on 2026-11-10 (count
  // measured with `eslint .` that day).
  {
    files: ['**/*.ts', '**/*.mjs'],
    ignores: ['**/*.test.ts'],
    plugins: { edc: { rules: { 'no-raw-error-log': noRawErrorLog } } },
    rules: { 'edc/no-raw-error-log': 'error' },
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
  // The TEST-ONLY fake provider: plain Node ESM, run with `node` directly.
  {
    files: ['test-support/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);

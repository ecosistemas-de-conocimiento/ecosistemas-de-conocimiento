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

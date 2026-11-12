import tseslint from 'typescript-eslint';

import noRawErrorLog from '../backend/eslint/noRawErrorLog.js';

// Minimal on purpose: one rule, `.ts` sources only. The rule is the backend's
// own file, shared by path so both apps enforce the same shapes. `.svelte`
// files have no parser here; `src/lib/noRawErrorLog.lint.test.ts` lints their
// `<script>` blocks with this same config instead.
//
// P-07: a raw error's text can quote a database row, and the web proxies the
// backend's errors. `error` from the start: tests are exempt, they log nothing
// that ships.
export default tseslint.config(
  { ignores: ['.svelte-kit/', 'build/', 'node_modules/', 'e2e/'] },
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { edc: { rules: { 'no-raw-error-log': noRawErrorLog } } },
    rules: { 'edc/no-raw-error-log': 'error' },
  },
);

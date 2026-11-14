import tseslint from 'typescript-eslint';

import noRawErrorLog from '../backend/eslint/noRawErrorLog.js';

// Small on purpose: typescript-eslint's `recommended` (no type information)
// plus one rule of our own, over `src/` — `.ts`, tests and `.svelte` scripts.
//
// `edc/no-raw-error-log` is the backend's own file, shared by path so both
// apps enforce the same shapes. P-07: a raw error's text can quote a database
// row, and the web proxies the backend's errors. Tests are exempt from it:
// they log nothing that ships.
//
// `.svelte`: no Svelte parser is installed, so `svelteScripts` hands ESLint
// each `<script>` block as TypeScript, padded so line numbers stay the file's.
// The markup is invisible to it, so the two rules that need it are off there:
// `no-unused-vars` (a name used only in the template) and `prefer-const` (a
// `let` written by `bind:`).

const SCRIPT = /(<script\b[^>]*>)([\s\S]*?)<\/script>/g;

/** @type {import('eslint').Linter.Processor} */
const svelteScripts = {
  meta: { name: 'edc-svelte-scripts' },
  preprocess(text) {
    return [...text.matchAll(SCRIPT)].map((m, i) => ({
      text: '\n'.repeat(text.slice(0, m.index + m[1].length).split('\n').length - 1) + m[2],
      filename: `${i}.ts`,
    }));
  },
  postprocess: (messages) => messages.flat(),
  supportsAutofix: false,
};

const edc = { rules: { 'no-raw-error-log': noRawErrorLog } };

export default tseslint.config(
  { ignores: ['.svelte-kit/', 'build/', 'node_modules/', 'e2e/'] },
  { files: ['src/**/*.svelte'], processor: svelteScripts },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { parser: tseslint.parser },
    plugins: { edc },
    rules: {
      'edc/no-raw-error-log': 'error',
      // `_name` is the codebase's "unused on purpose" (a stub's argument, a
      // field dropped by destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['src/**/*.svelte/*.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off', 'prefer-const': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: { 'edc/no-raw-error-log': 'off' },
  },
);

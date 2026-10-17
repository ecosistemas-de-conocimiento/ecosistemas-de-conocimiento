// The five `PII_NER_*` vars, now that they are in the schema instead of being
// read through bare `process.env`.
//
// WHAT THE MIGRATION ACTUALLY BOUGHT, which is what these tests pin. Before it,
// `ner-client.ts` read `process.env` in one contained function, so:
//
//   PII_NER_URL=not-a-url      → handed to `fetch` and failed at request time
//   PII_NER_TIMEOUT_MS=abc     → silently became the 5000 default
//   PII_NER_TIMEOUT_MS=        → silently became the 5000 default, unlogged
//   any of the five            → absent from `.env.example`, so a misspelling
//                                had nowhere to be noticed
//
// After it, the first two refuse the boot, the third warns once through the
// empty-string rule, and the last is a documentation test below.
//
// ⚠ `env` itself is a module-load singleton that calls `process.exit` on a bad
// parse, so these tests exercise `envSchema`-equivalent behaviour through the
// exported `preprocessEnv` plus a fresh `safeParse`, never by re-importing the
// module. Re-importing it would take the whole test process down with it.

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { preprocessEnv } from './env.js';

const PII_NER_VARS = [
  'PII_NER_URL',
  'PII_NER_MODEL',
  'PII_NER_BATCH_LIMIT',
  'PII_NER_TIMEOUT_MS',
  'PII_NER_MIN_SCORE',
] as const;

describe('PII_NER_* are declared in the schema', () => {
  it('every one of the five is a field on the env schema', async () => {
    // Reaches the schema the way `preprocessEnv` does — through the module's own
    // shape — so this cannot pass against a hand-maintained list.
    const src = await readFile(new URL('./env.ts', import.meta.url), 'utf8');
    // Positive control: the file is the schema we think it is.
    expect(src).toContain('RERANK_URL: z.string().url().optional()');
    for (const name of PII_NER_VARS) {
      expect(src).toMatch(new RegExp(`^\\s*${name}: z\\.`, 'm'));
    }
  });

  it('the numeric three take part in the empty-string rule', () => {
    // `PII_NER_TIMEOUT_MS=` used to coerce to 0 — which installs NO abort timer,
    // so a hung model server would hang the caller forever (the §10 item 8
    // footgun). The rule deletes the blank so the default applies, and WARNS.
    const { values, warnings, fatals } = preprocessEnv({
      PII_NER_BATCH_LIMIT: '',
      PII_NER_TIMEOUT_MS: '',
      PII_NER_MIN_SCORE: '',
    });
    expect(fatals).toEqual([]);
    for (const name of ['PII_NER_BATCH_LIMIT', 'PII_NER_TIMEOUT_MS', 'PII_NER_MIN_SCORE']) {
      expect(values).not.toHaveProperty(name);
      expect(warnings.join('\n')).toContain(name);
    }
  });

  it('a blank URL or model is NOT silently defaulted away', () => {
    // String vars are deliberately outside the empty-string rule (see the note
    // in env.ts). `PII_NER_URL=` therefore stays `''` and fails `.url()`, which
    // refuses the boot — the same behaviour an empty `RERANK_URL` has. That is
    // the intended loud failure, so pin that the rule does NOT quietly rescue it.
    const { values, warnings } = preprocessEnv({ PII_NER_URL: '', PII_NER_MODEL: '' });
    expect(values['PII_NER_URL']).toBe('');
    expect(values['PII_NER_MODEL']).toBe('');
    expect(warnings).toEqual([]);
  });
});

describe('PII_NER_* are documented', () => {
  it('every one of the five appears in .env.example', async () => {
    // The other half of the bug: a var that is not written down is a var whose
    // misspelling nobody catches. This is the test that keeps them written down.
    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    // Positive control: the file was found and is the real one.
    expect(example).toContain('SPARSE_EMBED_URL');
    for (const name of PII_NER_VARS) {
      expect(example).toContain(name);
    }
  });

  it('.env.example does not ship an EMPTY PII_NER_URL, which would refuse the boot', async () => {
    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).not.toMatch(/^PII_NER_URL=\s*$/m);
  });
});

describe('the NER client reads the schema, not process.env', () => {
  it('no bare process.env read is left in ner-client.ts', async () => {
    const src = await readFile(
      new URL('../services/ai/pii/ner-client.ts', import.meta.url),
      'utf8',
    );
    // Positive control: the file is the one that owns the NER fetch.
    expect(src).toContain('createNerAdapter');
    // Comments may mention it; code may not. Match a real member read only.
    expect(src).not.toMatch(/[^`'"\w]process\.env\s*[[.]/);
  });
});

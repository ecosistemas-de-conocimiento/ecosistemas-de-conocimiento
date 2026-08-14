// The shared client's built-in text-to-sql prompt, rendered through the REAL
// server renderer.
//
// ── Why this test lives here and not in the client package ────────────────
// The client ships a Handlebars TEMPLATE but never renders it: ai-service does,
// with `renderPrompt` below. A test inside `packages/ai-client` could only
// assert against a second Handlebars instance it configured itself, which is
// exactly the drift that would let the real escaping regress while the test
// stayed green. So the assertion runs against the renderer that actually
// answers in production.
//
// ── What it is guarding ───────────────────────────────────────────────────
// Handlebars escapes `{{ }}` for HTML. That rule is correct for a web page and
// nonsense for a model prompt: it turns `Ana's` into `Ana&#x27;s`, `"x"` into
// `&quot;x&quot;`, and `&` into `&amp;` on their way INTO the model. The bug was
// fixed service-wide; this pins it for the SQL built-in, which now carries Spanish
// (far more apostrophes and quotation marks than the ASCII English it replaced)
// and interpolates raw user questions and raw column names.
//
// ⚠ The fixture is deliberately hostile. A plain-ASCII fixture renders
// identically under `{{ }}` and `{{{ }}}` and would prove nothing.
//
// ⚠ BUILD ORDER. `@edc/ai-client` resolves through its `exports` map to
// `dist/index.js`, so this test needs the client BUILT. It is declared as a
// devDependency of this package precisely so `pnpm -r` orders the client's
// build ahead of this suite; running `pnpm --filter @edc/ai-service test` on a
// tree where the client has never been built fails here with a module
// resolution error, not an assertion error.

import { describe, expect, it } from 'vitest';

import { DEFAULT_SQL_PROMPT } from '@edc/ai-client';
import { renderPrompt } from './handlebars.js';

/** Every entity Handlebars would emit for the characters in the fixture. */
const HTML_ENTITIES = ['&#x27;', '&#39;', '&quot;', '&amp;', '&lt;', '&gt;', '&#x60;', '&#96;'];

// `'` `"` `&` `<` `>` and a backtick, in every interpolated slot.
const FIXTURE = {
  question:
    '¿Cuántos casos de Ana\'s área tienen "etiqueta" & prioridad <alta> o `urgente`?',
  tableName: 'reportes_"2026" & `archivo`',
  columns: 'nombre (text), "razón social" (text), monto<mxn> (numeric), `alias` (text)',
  dialect: "postgres 16 <'main'> & `réplica`",
};

describe('DEFAULT_SQL_PROMPT (shared client built-in)', () => {
  const rendered = renderPrompt(DEFAULT_SQL_PROMPT, FIXTURE);

  it('renders every interpolated value verbatim — no HTML escaping', () => {
    for (const [slot, value] of Object.entries(FIXTURE)) {
      expect(rendered, `\`${slot}\` was mangled on the way into the model`).toContain(value);
    }
  });

  it('emits no HTML entities at all', () => {
    for (const entity of HTML_ENTITIES) {
      expect(rendered, `found ${entity} — a double stache crept back in`).not.toContain(entity);
    }
  });

  it('uses triple stache for every interpolation in the template source', () => {
    // Structural companion to the render assertions: catches a double stache
    // added in a slot no fixture happens to cover.
    const doubleOnly = DEFAULT_SQL_PROMPT.match(/(?<!\{)\{\{(?![{#/>!])/g) ?? [];
    expect(doubleOnly, 'a `{{var}}` interpolation would HTML-escape its value').toEqual([]);
  });

  it('is Spanish — no English instruction wording survived', () => {
    expect(DEFAULT_SQL_PROMPT).not.toMatch(
      /\bYou are\b|\bReturn\b|\bUse ONLY\b|\bUser question\b|\bRespond\b|\bforbidden\b/,
    );
    expect(DEFAULT_SQL_PROMPT).toMatch(/Pregunta del usuario/);
  });

  it('keeps the SQL keywords in English — sql-guard.ts matches on them', () => {
    // `guardReadOnlySelect` tests the model's OUTPUT with /^select\b/i and a
    // forbidden-keyword regex. Translating these would make compliant output
    // fail the guard, which reads as "the model is bad at SQL".
    for (const kw of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'DROP',
      'ALTER',
      'CREATE',
      'GRANT',
      'TRUNCATE',
      'COPY',
    ]) {
      expect(DEFAULT_SQL_PROMPT).toContain(kw);
    }
  });
});

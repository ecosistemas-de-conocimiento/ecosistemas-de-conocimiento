// Text-to-SQL sub-API.
//
// SQL GENERATION is an ai-service-backed capability: it calls /v1/generate/sync
// with the `text-to-sql` unit-type. The default prompt is supplied inline (so
// it works with zero registry config); projects override it by registering the
// `text-to-sql` unit-type in the registry.
//
// The READ-ONLY GUARD is applied CLIENT-SIDE (pure, see ./sql-guard.ts) so the
// product validates without a second round-trip. ai-service NEVER executes
// SQL — `textToSql` returns the validated string; the product runs it against
// its own Postgres.

import type { HttpClient } from './http.js';
import { AIServiceError } from './errors.js';
import { guardReadOnlySelect } from './sql-guard.js';
import type { SyncResult, TextToSqlRequest, TextToSqlResult } from './types.js';

/** Registry unit-type projects register to override the SQL-gen prompt/model. */
export const TEXT_TO_SQL_UNIT_TYPE = 'text-to-sql';

/**
 * Capability this sub-API needs from the ai-service it is pointed at, because
 * the built-in prompt now rides in the `specDefault` FLOOR slot. Declare it in
 * `client.capabilities.negotiate({ require: [...] })` at boot to turn a
 * mid-request 400 into a deploy-time message.
 */
export const TEXT_TO_SQL_REQUIRED_CAPABILITY = 'specDefaultSlot';

// Default SQL-generation prompt (Handlebars, Mexican Spanish). Project-agnostic;
// mirrors a read-only-SQL consumer's constraints.
//
// ⚠ SPANISH, deliberately. The product's users are Spanish-speaking, and a
// built-in is what fires when the project has registered nothing — so an
// English fallback was the default for every consumer that never customised it.
//
// ⚠ The SQL KEYWORDS STAY ENGLISH. They are not prose: `sql-guard.ts` matches
// the model's output with `/^select\b/i` and a FORBIDDEN_SQL_RE built from these
// exact words. Translating `SELECT` here would produce output the guard then
// rejects — a failure that surfaces as "the model is bad at SQL".
//
// ⚠ TRIPLE stache on every interpolation. ai-service compiles templates with
// Handlebars' default escaping on, so a double stache would ship `it&#x27;s`,
// `&lt;`, `&amp;` and `&quot;` to the model — an HTML rule applied to text no
// browser will ever render, and Spanish carries far more apostrophes and
// quotation marks through it than the ASCII English original did.
// `{{{question}}}` is raw user text, and column names/quotes get mangled the
// same way. Block helpers (`{{#if}}`) are not interpolations and would stay
// double if any were added. Covered by
// `src/services/render/sql-default-prompt.test.ts`, which renders THIS constant
// through ai-service's real renderer against a quote/entity-heavy fixture.
export const DEFAULT_SQL_PROMPT = [
  'Eres un generador de SQL de SOLO LECTURA para {{{dialect}}}.',
  'Devuelve EXCLUSIVAMENTE una sola consulta SELECT: sin explicaciones, sin punto y coma final, sin comentarios.',
  'Queda terminantemente prohibido usar INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, GRANT, TRUNCATE, COPY o varias sentencias.',
  'Usa ÚNICAMENTE la tabla "{{{tableName}}}" con estas columnas: {{{columns}}}.',
  'Pregunta del usuario: {{{question}}}',
  'Responde solamente con el SELECT.',
].join('\n');

/** The built-in spec this sub-API ships. A FLOOR, never a ceiling. */
const BUILT_IN_SPEC = {
  promptTemplate: DEFAULT_SQL_PROMPT,
  // The cheapest tier is a DEFAULT, not a decision: a project that registers
  // the unit-type with `defaultEffort: 'deep'` gets deep. A caller's explicit
  // `req.effortLevel` still wins over both — it rides at request level.
  effortLevel: 'quick' as const,
};

/**
 * True when this 400 is an older ai-service rejecting the `specDefault` key
 * rather than a real complaint about the request.
 *
 * The unit schema is `.strict()`, so a deployment without the `specDefaultSlot`
 * capability answers `Unrecognized key(s) in object: 'specDefault'`. Matching
 * the field NAME (not a generic 400) keeps this from swallowing a genuine bad
 * request: anything else propagates untouched.
 */
function isUnknownSpecDefaultKey(err: unknown): boolean {
  return (
    err instanceof AIServiceError &&
    err.status === 400 &&
    /specDefault/.test(err.message)
  );
}

export class TextToSqlAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Sticky downgrade to the pre-`specDefault` wire shape. Set once, on the
   * first 400 that names the key, so an old deployment costs exactly one
   * wasted round-trip per client instance instead of one per query.
   */
  private legacySpecSlot = false;

  /**
   * Generate a read-only SELECT for `question` over `{tableName, columns}`,
   * then validate it with the pure client-side guard. The returned `sql` is
   * normalised (fence stripped, LIMIT appended) when `valid` is true.
   *
   * Never throws on a rejected query — `{ valid: false, rejectionReason }` is
   * returned so callers branch instead of catching. (Network/auth errors from
   * the generate call still throw as typed AIServiceError.)
   */
  async textToSql(req: TextToSqlRequest): Promise<TextToSqlResult> {
    const dialect = req.dialect ?? 'postgres';
    const columns = req.columns.map((c) => `${c.name} (${c.type})`).join(', ');
    const input = {
      question: req.question,
      tableName: req.tableName,
      columns,
      dialect,
    };

    let gen: SyncResult;
    if (this.legacySpecSlot) {
      gen = await this.send(input, req, 'specOverride');
    } else {
      try {
        gen = await this.send(input, req, 'specDefault');
      } catch (err) {
        // Only the one condition we can fix by retrying. Everything else — a
        // real 400, budget, auth, network — is the caller's to see.
        if (!isUnknownSpecDefaultKey(err)) throw err;
        this.legacySpecSlot = true;
        gen = await this.send(input, req, 'specOverride');
      }
    }

    // Apply the pure read-only guard client-side. No second round-trip.
    return guardReadOnlySelect(gen.text ?? '', req.rowLimit);
  }

  /** One `/v1/generate/sync` call with the built-in spec in the chosen slot. */
  private send(
    input: Record<string, unknown>,
    req: TextToSqlRequest,
    slot: 'specDefault' | 'specOverride',
  ): Promise<SyncResult> {
    return this.http.json<SyncResult>({
      method: 'POST',
      path: '/v1/generate/sync',
      body: {
        unit: {
          unitKey: TEXT_TO_SQL_UNIT_TYPE,
          unitType: TEXT_TO_SQL_UNIT_TYPE,
          input,
          // FLOOR, not ceiling. In `specOverride` — where this shipped until
          // now — a project that registered the `text-to-sql` unit-type had its
          // prompt resolved and then discarded, so registry edits did nothing
          // and said nothing. `specOverride` survives only as the fallback for
          // a deployment that predates the `specDefaultSlot` capability, where
          // it is the sole slot that exists.
          [slot]: {
            ...BUILT_IN_SPEC,
            // The legacy slot is a ceiling, so the caller's explicit effort has
            // to be re-stated inside it or it would be pinned to 'quick'.
            ...(slot === 'specOverride' && req.effortLevel
              ? { effortLevel: req.effortLevel }
              : {}),
          },
        },
        // Request level: an explicit caller choice, and it beats the registry
        // on purpose. Unchanged by the floor migration.
        ...(req.effortLevel ? { effortLevel: req.effortLevel } : {}),
        ...(req.modelOverride ? { modelOverride: req.modelOverride } : {}),
      },
    });
  }
}

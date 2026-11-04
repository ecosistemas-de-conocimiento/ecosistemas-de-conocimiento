// The FIVE error envelopes ai-service actually puts on the wire.
//
// Not three, not one. Every one of these is produced by code on this tree
// today, and the OpenAPI document declared exactly one of them (the flat one)
// on every error status — so eight `/v1/corpora` + `/v1/corpus` routes
// published a body shape they have never sent. These schemas exist so the
// document can reference the RIGHT envelope per route per status, and so a
// test can parse a real `app.inject` body through the schema that claims to
// describe it.
//
//   1. `flatErrorBodySchema`       `{ error, ...fields, message }`
//      `AiServiceError.toBody()` (`src/errors/base.ts`). `error` is the CLASS
//      NAME by default — `@edc/ai-client`'s `errorFromResponse`
//      switches on it. Extra fields are class-specific (`retryAfterMs`,
//      `lostJobs`, …), hence passthrough.
//
//   2. `codedErrorBodySchema`      `{ error, code, ...fields, message }`
//      `CodedEnvelopeError.toBody()` — the flat envelope PLUS the stable
//      `ERR_*` string. Seven classes send it (`EmbeddingDimensionMismatch`,
//      `InvalidTextSearchConfig`, `InvalidValidityInterval`,
//      `CallbackUrlBlocked`, `RegistryConflict`, `RegistryNotFound` and their
//      siblings). It is a SEPARATE named schema, not a `describe()` on the
//      flat one, because `code` is REQUIRED here and absent from every
//      pre-existing flat body — a consumer branching on `err.code` without a
//      client bump needs the document to say which statuses carry it.
//
//   3. `nestedErrorBodySchema`     `{ error: { code, message } }`
//      `NestedEnvelopeError.toBody()`. The RAG control plane (`/v1/corpora`,
//      `/v1/corpus`) predates the flat envelope and `code` is SCREAMING_SNAKE
//      (the class's `ERR_` prefix stripped), not a class name. Consumers parse
//      this shape today; it is kept deliberately.
//
//   4. `sensibleErrorBodySchema`   `{ statusCode, error, message }`
//      fastify-sensible (`reply.badRequest`, `reply.notFound`, …) and the
//      redacted 500 arm of the `/v1` error handler in `src/server.ts`. This is
//      also what EVERY request-body validation failure looks like — the routes
//      `safeParse` and hand the joined issue messages to `reply.badRequest`,
//      pinned byte-for-byte in `validation-wire-golden.json`.
//
//   5. `rateLimitedBodySchema`     `{ error, message, retryAfterMs }`
//      The 429 re-shaped by the `/v1` error handler. Producible on EVERY `/v1`
//      route (the limiter is registered on the whole prefix), which is why the
//      route table attaches it to all of them rather than to a chosen few.
//
// ── ONE CLASS, ONE ENVELOPE — and why a STATUS still carries two ──────────
// The original fix removed the nine route-layer catches that
// re-flattened a typed error, so a CLASS now has exactly one wire shape:
// `CorpusNotFoundError` is nested on `POST /v1/retrieve` as well as on
// `/v1/corpora`, and `routes/registry.ts` no longer re-sends its own two flat
// classes through fastify-sensible.
//
// A STATUS is still allowed two shapes, for a different reason: one status on
// one route can be reached by two DIFFERENT producers. Every `400` on a route
// that `safeParse`s its body is `sensibleErrorBodySchema` when validation
// fails and the raising class's own envelope when the handler throws. The
// route table therefore declares a `oneOf` on those six statuses — envelope
// per ROUTE per STATUS, never per class.

import { z } from './zod.js';

/** `{ error: <ClassName>, ...classFields, message }` — `AiServiceError.toBody()`. */
export const flatErrorBodySchema = z
  .object({
    error: z.string().describe('Stable discriminator. The error class name.'),
    message: z.string(),
  })
  .passthrough();
export type FlatErrorBody = z.infer<typeof flatErrorBodySchema>;

/**
 * `{ error: <ClassName>, code: 'ERR_*', ...classFields, message }` —
 * `CodedEnvelopeError.toBody()` (`src/errors/base.ts`).
 *
 * `code` is REQUIRED. That is the whole point of the separate schema: it is
 * the field `@edc/ai-client`'s `DISCRIMINATOR_BY_CODE` fallback reads
 * to resolve a class the installed client version does not know by name.
 */
export const codedErrorBodySchema = z
  .object({
    error: z.string().describe('Stable discriminator. The error class name.'),
    code: z.string().describe('Stable machine string, `ERR_*`. Always present on this envelope.'),
    message: z.string(),
  })
  .passthrough();
export type CodedErrorBody = z.infer<typeof codedErrorBodySchema>;

/** `{ error: { code, message } }` — `NestedEnvelopeError.toBody()`. */
export const nestedErrorBodySchema = z.object({
  error: z.object({
    code: z.string().describe('SCREAMING_SNAKE code, the class `ERR_` string minus its prefix.'),
    message: z.string(),
  }),
});
export type NestedErrorBody = z.infer<typeof nestedErrorBodySchema>;

/** `{ statusCode, error, message }` — fastify-sensible, and the redacted 500. */
export const sensibleErrorBodySchema = z.object({
  statusCode: z.number().int(),
  error: z.string().describe('HTTP reason phrase, e.g. `Bad Request`.'),
  message: z.string(),
});
export type SensibleErrorBody = z.infer<typeof sensibleErrorBodySchema>;

/** Request-body validation failure. Byte-identical to the sensible envelope. */
export const validationErrorBodySchema = sensibleErrorBodySchema;

/** `{ error: 'RateLimitExceeded', message, retryAfterMs }` — the `/v1` 429. */
export const rateLimitedBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  retryAfterMs: z
    .number()
    .int()
    .nonnegative()
    .describe('Milliseconds until the bucket refills. Mirrors the `retry-after` header, in ms.'),
});
export type RateLimitedBody = z.infer<typeof rateLimitedBodySchema>;

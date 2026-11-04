// Parity + mapping contract for the client's error taxonomy.
//
// ⚠ This file deliberately imports NOTHING from the service's `src/`. The
// package is dependency-free and its build must not reach outside
// `packages/ai-client`, so the server's inventory is restated below as a
// LITERAL table. That restatement is the point: it is a second, independent
// reading of the contract, and `scripts/check-error-parity.mjs` is the third —
// it re-derives the server's set by scanning `src/**` and diffs it against
// `WIRE_ERRORS`, so a class added to ai-service without a client mapping goes
// red instead of degrading into an untyped `AIServiceError`.
//
// Sabotage check (run it after touching either side): delete one entry from
// `WIRE_ERRORS` in `errors.ts` and both the first test here and the script
// must fail, naming the code.

import { describe, expect, it } from 'vitest';

import type {
  BudgetMisconfiguredError,
  CrossBatchDependencyError,
  DependencyCycleError,
  IdempotencyConflictError,
  SpecResolutionError} from './errors.js';
import {
  AIServiceError,
  AliasNameConflictError,
  ApiKeyExpiredError,
  AuthError,
  BadRequestError,
  BudgetExceededError,
  BudgetNotConfiguredError,
  CallbackUrlBlockedError,
  CallbackSecretMissingError,
  IngestNotFoundError,
  ChunkSizeShrinkNotAllowedError,
  ConflictError,
  CorpusAlreadyExistsError,
  CorpusNameIsAliasError,
  CorpusNotFoundError,
  DocumentNotFoundError,
  EmbeddingDimensionMismatchError,
  EmbeddingModelChangeNotAllowedError,
  InvalidTextSearchConfigError,
  InvalidValidityIntervalError,
  NotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitError,
  RegistryConflictError,
  RegistryNotFoundError,
  RenderError,
  SERVER_ONLY_ERROR_CODES,
  TargetCorpusNotFoundError,
  WIRE_ERRORS,
  errorFromResponse,
} from './errors.js';

/**
 * Every `ERR_` string ai-service declares, transcribed by hand from the class
 * inventory in its `src/` (`git grep "extends AiServiceError\|extends
 * NestedEnvelopeError"`). Twenty-five classes, twenty-five codes.
 */
const SERVER_ERR_CODES = [
  'ERR_ALIAS_NAME_CONFLICT',
  'ERR_BUDGET_EXCEEDED',
  'ERR_BUDGET_MISCONFIGURED',
  'ERR_BUDGET_NOT_CONFIGURED',
  'ERR_CALLBACK_SECRET_MISSING',
  'ERR_CALLBACK_URL_BLOCKED',
  'ERR_CHUNK_SIZE_LOCKED',
  'ERR_CORPUS_ALREADY_EXISTS',
  'ERR_CORPUS_NAME_IS_ALIAS',
  'ERR_CORPUS_NOT_FOUND',
  'ERR_DEPENDENCY_CYCLE',
  'ERR_DEPENDENCY_OUT_OF_BATCH',
  'ERR_DOCUMENT_NOT_FOUND',
  'ERR_EMBEDDING_DIMENSION_MISMATCH',
  'ERR_EMBEDDING_MODEL_LOCKED',
  'ERR_IDEMPOTENCY_CONFLICT',
  'ERR_INGEST_NOT_FOUND',
  'ERR_INVALID_TEXT_SEARCH_CONFIG',
  'ERR_INVALID_VALIDITY_INTERVAL',
  'ERR_PII_MINIMISATION_FAILED',
  'ERR_PII_NER_NOT_CONFIGURED',
  'ERR_PROVIDER_TIMEOUT',
  'ERR_PROVIDER_UNAVAILABLE',
  'ERR_REGISTRY_CONFLICT',
  'ERR_REGISTRY_NOT_FOUND',
  'ERR_RENDER',
  'ERR_RERANK_CREDENTIAL_MISSING',
  'ERR_RERANK_ENDPOINT_INVALID',
  'ERR_RERANK_NOT_CONFIGURED',
  'ERR_SPARSE_EMBED_NOT_CONFIGURED',
  'ERR_SPEC_RESOLUTION',
  'ERR_TARGET_CORPUS_NOT_FOUND',
].sort();

describe('parity with ai-service`s ERR_ inventory', () => {
  it('every server code is either mapped in WIRE_ERRORS or declared server-only', () => {
    const known = new Set<string>([
      ...Object.values(WIRE_ERRORS).flatMap((e) => (e.code === null ? [] : [e.code])),
      ...SERVER_ONLY_ERROR_CODES,
    ]);
    expect([...known].sort()).toEqual(SERVER_ERR_CODES);
  });

  it('the `expose = false` codes are the ONLY ones with no wire mapping', () => {
    // They can never reach a caller: ai-service answers a generic 500 and the
    // detail goes to its own logs. Anything else in this list would be a class
    // a consumer can receive but cannot recognise.
    //
    // The duplication against SERVER_ONLY_ERROR_CODES is deliberate: this is the
    // copy that makes ADDING a code a conscious act rather than a silent one.
    expect([...SERVER_ONLY_ERROR_CODES].sort()).toEqual([
      'ERR_PII_MINIMISATION_FAILED',
      'ERR_PII_NER_NOT_CONFIGURED',
      'ERR_RERANK_CREDENTIAL_MISSING',
      'ERR_RERANK_ENDPOINT_INVALID',
      'ERR_RERANK_NOT_CONFIGURED',
      'ERR_SPARSE_EMBED_NOT_CONFIGURED',
    ]);
  });

  it('the only entries without an ERR_ code are the two ai-service sends inline', () => {
    const codeless = Object.entries(WIRE_ERRORS)
      .filter(([, e]) => e.code === null)
      .map(([k]) => k)
      .sort();
    expect(codeless).toEqual(['RateLimitExceeded', 'api_key_expired']);
  });
});

describe('reachability — spelling parity is not the same as working', () => {
  // These counts are MEASURED against a running ai-service, not derived from
  // the table agreeing with itself. `scripts/check-error-parity.mjs` prints the
  // same tally so a green gate cannot be read as "every code is branchable".
  it('NOTHING is flattened any more — the six that were are now typed', () => {
    // Was six: CallbackUrlBlocked, EmbeddingDimensionMismatch,
    // InvalidTextSearchConfig, InvalidValidityInterval, RegistryConflict,
    // RegistryNotFound. ai-service removed the seven
    // route sites that re-sent them through fastify-sensible, and the six
    // classes now put `error` AND `code` on the body. Pinned server-side in
    // `src/errors/wire-golden.test.ts`.
    //
    // This assertion is deliberately an EMPTY-list equality, not a
    // `toBeLessThan`: a route that starts flattening again names itself here.
    const flattened = Object.entries(WIRE_ERRORS)
      .filter(([, e]) => e.reachable === 'flattened')
      .map(([k]) => k)
      .sort();
    expect(flattened).toEqual([]);
  });

  it('the six that changed are typed, and carry an ERR_ code to resolve by', () => {
    for (const key of [
      'CallbackUrlBlockedError',
      'EmbeddingDimensionMismatchError',
      'InvalidTextSearchConfigError',
      'InvalidValidityIntervalError',
      'RegistryConflictError',
      'RegistryNotFoundError',
    ]) {
      const entry = WIRE_ERRORS[key];
      expect(entry, `${key} left the table`).toBeDefined();
      expect(entry?.reachable, `${key} reachability`).toBe('typed');
      // `code` is what lets a pre-0.18 consumer resolve it with no republish.
      expect(entry?.code, `${key} code`).toMatch(/^ERR_/);
    }
  });

  it('the tally is 25 typed / 0 flattened / 3 unverified', () => {
    // +2 unverified in 0.24.0: CallbackSecretMissingError and IngestNotFoundError
    // are route-tested server side but not yet measured against a deploy.
    const tally = { typed: 0, flattened: 0, unverified: 0 };
    for (const e of Object.values(WIRE_ERRORS)) tally[e.reachable] += 1;
    expect(tally).toEqual({ typed: 25, flattened: 0, unverified: 3 });
  });

  it('every entry states its reachability', () => {
    for (const [key, e] of Object.entries(WIRE_ERRORS)) {
      expect(['typed', 'flattened', 'unverified'], `${key} has no reachability`).toContain(
        e.reachable,
      );
    }
  });
});

describe('400 — the status family that had no class', () => {
  it("fastify-sensible's flattened envelope lands as BadRequestError, not a bare error", () => {
    // What a consumer ACTUALLY receives today for all four 400-flattened
    // classes: the discriminator is 'Bad Request', so only the status family
    // and the message survive. `code` is undefined — that is the known gap,
    // recorded here so it cannot regress silently in either direction.
    const err = errorFromResponse(400, {
      statusCode: 400,
      error: 'Bad Request',
      message: "corpus 'x' embedding dimension 1536 does not fit vector(1024)",
    });
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toBeInstanceOf(AIServiceError);
    expect(err.status).toBe(400);
    expect(err.code).toBeUndefined();
    expect(err.message).toContain('does not fit');
  });

  it('RegistryNotFound flattens to a generic NotFoundError, keeping its message', () => {
    const err = errorFromResponse(404, {
      statusCode: 404,
      error: 'Not Found',
      message: "unit type 'brief' has no version '3'",
    });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.constructor).toBe(NotFoundError);
    expect(err.code).toBeUndefined();
  });
});

describe('body-carried `code` resolves the class when the discriminator does not', () => {
  // Forward compatibility: ai-service does NOT put the ERR_ string in
  // fastify-sensible's envelope today, so this path is inert for the flattened
  // six. The day it does, consumers already on this version get the precise
  // class with no republish and no client change.
  it('a generic envelope carrying `code` still resolves to the precise class', () => {
    const err = errorFromResponse(400, {
      statusCode: 400,
      error: 'Bad Request',
      code: 'ERR_EMBEDDING_DIMENSION_MISMATCH',
      message: 'dimension mismatch',
    });
    expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(err.code).toBe('ERR_EMBEDDING_DIMENSION_MISMATCH');
  });

  it('a real wire discriminator still wins over the body `code`', () => {
    const err = errorFromResponse(409, {
      error: { code: 'CORPUS_ALREADY_EXISTS', message: "corpus 'a' already exists" },
    });
    expect(err).toBeInstanceOf(CorpusAlreadyExistsError);
  });

  it('an unknown ERR_ code does not invent a class', () => {
    const err = errorFromResponse(400, {
      error: 'Bad Request',
      code: 'ERR_FROM_THE_FUTURE',
      message: 'nope',
    });
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.code).toBe('ERR_FROM_THE_FUTURE');
  });
});

describe('flat envelope → typed class', () => {
  const flat: ReadonlyArray<readonly [string, number, unknown, string | undefined]> = [
    ['RenderError', 400, RenderError, 'ERR_RENDER'],
    ['RegistryConflictError', 400, RegistryConflictError, 'ERR_REGISTRY_CONFLICT'],
    ['RegistryNotFoundError', 404, RegistryNotFoundError, 'ERR_REGISTRY_NOT_FOUND'],
    ['CallbackUrlBlockedError', 400, CallbackUrlBlockedError, 'ERR_CALLBACK_URL_BLOCKED'],
    ['CallbackSecretMissingError', 400, CallbackSecretMissingError, 'ERR_CALLBACK_SECRET_MISSING'],
    ['IngestNotFoundError', 404, IngestNotFoundError, 'ERR_INGEST_NOT_FOUND'],
    [
      'InvalidTextSearchConfigError',
      400,
      InvalidTextSearchConfigError,
      'ERR_INVALID_TEXT_SEARCH_CONFIG',
    ],
    [
      'InvalidValidityIntervalError',
      400,
      InvalidValidityIntervalError,
      'ERR_INVALID_VALIDITY_INTERVAL',
    ],
    [
      'EmbeddingDimensionMismatchError',
      400,
      EmbeddingDimensionMismatchError,
      'ERR_EMBEDDING_DIMENSION_MISMATCH',
    ],
    ['ProviderTimeout', 504, ProviderTimeoutError, 'ERR_PROVIDER_TIMEOUT'],
  ];

  it('ProviderTimeout: `truncated` is true only when the server said the call was cut unbilled', () => {
    const cut = errorFromResponse(504, {
      error: 'ProviderTimeout',
      code: 'ERR_PROVIDER_TIMEOUT',
      truncated: true,
      reason: 'provider_timeout',
      message: 'The upstream LLM provider exceeded the request timeout.',
    });
    expect(cut).toBeInstanceOf(ProviderTimeoutError);
    expect((cut as ProviderTimeoutError).truncated).toBe(true);
    // The older two-field body (still sent on a shutdown cut) is not one.
    const legacy = errorFromResponse(504, { error: 'ProviderTimeout', message: 'timed out' });
    expect((legacy as ProviderTimeoutError).truncated).toBe(false);
  });

  it.each(flat)('%s → its class, its status and its code', (discriminator, status, cls, code) => {
    const err = errorFromResponse(status, { error: discriminator, message: 'the real message' });
    expect(err).toBeInstanceOf(cls as new () => AIServiceError);
    expect(err.message).toBe('the real message');
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });

  it('ProviderUnavailable keeps its retry hint, its ERR_ code and retryable', () => {
    const err = errorFromResponse(503, {
      error: 'ProviderUnavailable',
      code: 'ERR_PROVIDER_UNAVAILABLE',
      retryAfterMs: 30_000,
      message: 'breaker open',
    });
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as ProviderUnavailableError).retryAfterMs).toBe(30_000);
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('ERR_PROVIDER_UNAVAILABLE');
    expect(err.status).toBe(503);
  });

  it('ProviderUnavailable falls back to the Retry-After header when the body has none', () => {
    const err = errorFromResponse(
      503,
      { error: 'ProviderUnavailable', message: 'breaker open' },
      { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '30' : null) },
    );
    expect((err as ProviderUnavailableError).retryAfterMs).toBe(30_000);
  });

  it('api_key_expired is an AuthError still, and narrower', () => {
    const err = errorFromResponse(401, { error: 'api_key_expired', message: 'API key expired' });
    expect(err).toBeInstanceOf(ApiKeyExpiredError);
    // The regression guard: it was an `AuthError` before 0.17.0 and must stay one.
    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(401);
  });
});

describe('nested envelope `{ error: { code, message } }`', () => {
  const nested: ReadonlyArray<readonly [string, number, unknown, string]> = [
    ['CORPUS_NOT_FOUND', 404, CorpusNotFoundError, 'ERR_CORPUS_NOT_FOUND'],
    ['TARGET_CORPUS_NOT_FOUND', 404, TargetCorpusNotFoundError, 'ERR_TARGET_CORPUS_NOT_FOUND'],
    ['DOCUMENT_NOT_FOUND', 404, DocumentNotFoundError, 'ERR_DOCUMENT_NOT_FOUND'],
    ['ALIAS_NAME_CONFLICT', 409, AliasNameConflictError, 'ERR_ALIAS_NAME_CONFLICT'],
    ['CORPUS_ALREADY_EXISTS', 409, CorpusAlreadyExistsError, 'ERR_CORPUS_ALREADY_EXISTS'],
    ['CORPUS_NAME_IS_ALIAS', 409, CorpusNameIsAliasError, 'ERR_CORPUS_NAME_IS_ALIAS'],
    [
      'EMBEDDING_MODEL_LOCKED',
      409,
      EmbeddingModelChangeNotAllowedError,
      'ERR_EMBEDDING_MODEL_LOCKED',
    ],
    ['CHUNK_SIZE_LOCKED', 409, ChunkSizeShrinkNotAllowedError, 'ERR_CHUNK_SIZE_LOCKED'],
  ];

  it.each(nested)('%s → its own class, not a look-alike', (code, status, cls) => {
    const err = errorFromResponse(status, { error: { code, message: `detail for ${code}` } });
    expect(err).toBeInstanceOf(cls as new () => AIServiceError);
  });

  it.each(nested)('%s keeps the SERVER`s message, not a synthetic one', (code, status) => {
    // The 0.16.0 bug: `body.message` is absent in this envelope, so every one
    // of these arrived as `ai-service request failed (status N)` and the field
    // naming the offending corpus / alias / document was thrown away.
    const err = errorFromResponse(status, { error: { code, message: `detail for ${code}` } });
    expect(err.message).toBe(`detail for ${code}`);
    expect(err.message).not.toContain('ai-service request failed');
  });

  it.each(nested)(
    '%s re-prefixes the envelope code back to its ERR_ string',
    (code, status, _cls, errCode) => {
      expect(errorFromResponse(status, { error: { code, message: 'x' } }).code).toBe(errCode);
    },
  );

  it('the three 404s stay `NotFoundError`s — the class they already were', () => {
    for (const code of ['CORPUS_NOT_FOUND', 'TARGET_CORPUS_NOT_FOUND', 'DOCUMENT_NOT_FOUND']) {
      expect(errorFromResponse(404, { error: { code, message: 'x' } })).toBeInstanceOf(
        NotFoundError,
      );
    }
  });

  it('the five 409s share `ConflictError`, and so does IdempotencyConflict', () => {
    for (const code of [
      'ALIAS_NAME_CONFLICT',
      'CORPUS_ALREADY_EXISTS',
      'CORPUS_NAME_IS_ALIAS',
      'EMBEDDING_MODEL_LOCKED',
      'CHUNK_SIZE_LOCKED',
    ]) {
      expect(errorFromResponse(409, { error: { code, message: 'x' } })).toBeInstanceOf(
        ConflictError,
      );
    }
    expect(
      errorFromResponse(409, { error: 'IdempotencyConflict', existingRequestId: 'r', message: 'm' }),
    ).toBeInstanceOf(ConflictError);
  });

  it('an UNKNOWN nested code still yields the real message and the status class', () => {
    const err = errorFromResponse(409, {
      error: { code: 'SOMETHING_ADDED_LATER', message: 'a message from a newer service' },
    });
    expect(err.message).toBe('a message from a newer service');
    expect(err).toBeInstanceOf(ConflictError);
    // Re-prefixed from the envelope even though this client has no class for it.
    expect(err.code).toBe('ERR_SOMETHING_ADDED_LATER');
  });
});

describe('what 0.16.0 consumers match must keep matching', () => {
  it('the three budget classes keep their names, statuses, fields and sibling shape', () => {
    const exceeded = errorFromResponse(402, {
      error: 'BudgetExceeded',
      org: 'acme',
      requested: 1.5,
      remaining: 0.25,
      shortfallUsd: 1.25,
      message: 'budget exceeded',
    }) as BudgetExceededError;
    expect(exceeded).toBeInstanceOf(BudgetExceededError);
    expect(exceeded.name).toBe('BudgetExceededError');
    expect([exceeded.org, exceeded.requested, exceeded.remaining, exceeded.shortfallUsd]).toEqual([
      'acme', 1.5, 0.25, 1.25,
    ]);

    const notConfigured = errorFromResponse(402, {
      error: 'BudgetNotConfigured',
      org: 'acme',
      message: 'no budget',
    }) as BudgetNotConfiguredError;
    expect(notConfigured.name).toBe('BudgetNotConfiguredError');
    expect(notConfigured.org).toBe('acme');

    const misconfigured = errorFromResponse(402, {
      error: 'BudgetMisconfigured',
      org: 'acme',
      estimatedCostUsdPerCall: null,
      message: 'metering broken',
    }) as BudgetMisconfiguredError;
    expect(misconfigured.name).toBe('BudgetMisconfiguredError');
    expect(misconfigured.estimatedCostUsdPerCall).toBeNull();

    // These three are SIBLINGS.
    expect(notConfigured).not.toBeInstanceOf(BudgetExceededError);
    expect(misconfigured).not.toBeInstanceOf(BudgetNotConfiguredError);
  });

  it('the four generate-path classes are unchanged, and now carry `code`', () => {
    const spec = errorFromResponse(400, {
      error: 'SpecResolutionError',
      cause: 'no model',
      message: 'no model',
    }) as SpecResolutionError;
    expect(spec.resolutionCause).toBe('no model');
    expect(spec.code).toBe('ERR_SPEC_RESOLUTION');

    const cycle = errorFromResponse(400, {
      error: 'DependencyCycleError',
      cycle: ['a', 'b', 'a'],
      message: 'cycle',
    }) as DependencyCycleError;
    expect(cycle.cycle).toEqual(['a', 'b', 'a']);

    const cross = errorFromResponse(400, {
      error: 'CrossBatchDependencyError',
      missing: ['x'],
      message: 'missing',
    }) as CrossBatchDependencyError;
    expect(cross.missing).toEqual(['x']);

    const idem = errorFromResponse(409, {
      error: 'IdempotencyConflict',
      existingRequestId: 'req-1',
      message: 'conflict',
    }) as IdempotencyConflictError;
    expect(idem.existingRequestId).toBe('req-1');
    expect(idem.code).toBe('ERR_IDEMPOTENCY_CONFLICT');
  });

  it('a 429 is still a RateLimitError with its retryAfterMs', () => {
    const err = errorFromResponse(429, {
      error: 'RateLimitExceeded',
      retryAfterMs: 4_000,
      message: 'slow down',
    }) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(4_000);
    expect(err.retryable).toBe(true);
  });

  it('an unrecognised discriminator still degrades to a plain AIServiceError', () => {
    const err = errorFromResponse(418, { error: 'SomethingFromTheFuture', message: 'teapot' });
    expect(err.constructor).toBe(AIServiceError);
    expect(err.status).toBe(418);
    expect(err.code).toBeUndefined();
    expect(err.retryable).toBe(false);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('a non-object body is still tolerated', () => {
    expect(errorFromResponse(500, 'plain text').message).toBe('plain text');
    expect(errorFromResponse(500, null).status).toBe(500);
  });

  it('a Fastify `FST_ERR_*` code is NOT mistaken for a taxonomy code', () => {
    const err = errorFromResponse(400, {
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      error: 'Bad Request',
      message: 'body must have required property `x`',
    });
    expect(err.code).toBeUndefined();
  });
});

// GOLDEN WIRE CONTRACT for every error class `/v1/generate*` maps.
//
// Written against `main` BEFORE the error-taxonomy refactor and asserted with
// literal expectations, so any change to a status, a discriminator, a field
// name, or a field's JSON encoding turns this file red. `@edc/ai-client`
// 0.16.0 switches on exactly these values (`packages/ai-client/src/errors.ts`
// → `errorFromResponse`), and consumers switch on the budget
// discriminators by string, so a red line here is a consumer break, never a
// test to update casually.
//
// Both transports are pinned:
//   • `mapGenerateError`    — POST /v1/generate, /sync, /:requestId/cancel
//   • `classifyStreamError` — the terminal SSE `error` frame on /stream
//
// The bodies are additionally round-tripped through JSON, because the wire is
// JSON: `NaN`/`Infinity` collapse to `null` there and nowhere else.
//
// The last three blocks pin the ROUTE layer as well, through `app.inject`, and
// they are not decoration: a class can declare the right body and a route can
// still throw it away. That is precisely what seven route sites did before the
// fix — see the table at the bottom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── route-layer harness ───────────────────────────────────────────────────
// The services are mocked at the class boundary so a handler can be made to
// raise one exact class; nothing here touches Postgres or Redis. Every mock
// spreads `importActual`, so the ERROR CLASSES these modules export stay real —
// mocking them away would make the assertions tautological.
const createCorpusMock = vi.fn();
const updateCorpusMock = vi.fn();
const ingestBatchMock = vi.fn();
const setValidityMock = vi.fn();
const retrieveMock = vi.fn();
const createVersionMock = vi.fn();
const activateVersionMock = vi.fn();

vi.mock('../db/client.js', () => ({ db: {} }));

vi.mock('../services/rag/corpus-crud.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/rag/corpus-crud.js')>(
      '../services/rag/corpus-crud.js',
    );
  return {
    ...actual,
    CorpusService: class {
      createCorpus = (...a: unknown[]) => createCorpusMock(...a);
      updateCorpus = (...a: unknown[]) => updateCorpusMock(...a);
      listCorpora = () => Promise.resolve([]);
      getCorpus = () => Promise.resolve(null);
    },
  };
});

vi.mock('../services/rag/ingest.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/rag/ingest.js')>(
      '../services/rag/ingest.js',
    );
  return {
    ...actual,
    IngestService: class {
      ingestBatch = (...a: unknown[]) => ingestBatchMock(...a);
      getIngestStatus = () => Promise.resolve({});
    },
  };
});

vi.mock('../services/rag/document-validity.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/rag/document-validity.js')>(
      '../services/rag/document-validity.js',
    );
  return {
    ...actual,
    DocumentValidityService: class {
      setValidity = (...a: unknown[]) => setValidityMock(...a);
    },
  };
});

vi.mock('../services/rag/retrieve.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/rag/retrieve.js')>(
      '../services/rag/retrieve.js',
    );
  return {
    ...actual,
    RetrieveService: class {
      retrieve = (...a: unknown[]) => retrieveMock(...a);
    },
  };
});

vi.mock('../db/registry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../db/registry.js')>('../db/registry.js');
  return {
    ...actual,
    createVersion: (...a: unknown[]) => createVersionMock(...a),
    activateVersion: (...a: unknown[]) => activateVersionMock(...a),
  };
});

vi.hoisted(() => {
  process.env.API_KEYS = JSON.stringify({
    'app-key': { org: 'acme', project: 'chat', role: 'app' },
    'admin-key': { org: 'acme', project: 'chat', role: 'admin' },
  });
  // The unknown-error block below asserts on the LOG as well as the body —
  // half of that contract is that the detail still reaches the operator. This
  // has to be set before `env.ts` is first loaded, hence `vi.hoisted`, and the
  // capture helper swallows the lines so the suite output stays quiet.
  process.env.LOG_LEVEL = 'info';
});

import { AiServiceError, CodedEnvelopeError } from './base.js';
import { classifyStreamError, mapGenerateError } from './generate-map.js';
import { ProviderUnavailable } from '../services/ai/router/router.js';
import { EmptyCompletion } from '../services/ai/router/empty-completion.js';
import {
  BudgetExceeded,
  BudgetMisconfigured,
  BudgetNotConfigured,
} from '../services/budget/errors.js';
import {
  CrossBatchDependencyError,
  DependencyCycleError,
} from '../services/generation/types.js';
import { IdempotencyConflictError } from '../services/idempotency.js';
import { SpecResolutionError } from '../services/registry/resolve.js';
import { RenderError } from '../services/render/handlebars.js';
import { RegistryConflictError, RegistryNotFoundError } from '../db/registry.js';
import { CallbackUrlBlockedError } from '../services/callbacks/url-guard.js';
import {
  AliasNameConflictError,
  TargetCorpusNotFoundError,
} from '../services/rag/corpus-alias.js';
import { InvalidTextSearchConfigError } from '../services/rag/corpus-crud.js';
import { InvalidValidityIntervalError } from '../services/rag/document-validity.js';
import { EmbeddingDimensionMismatchError } from '../services/rag/embedding-models.js';
import { CorpusNotFoundError } from '../services/rag/errors.js';

/** What the wire actually carries: JSON, not the in-memory object. */
const overWire = (body: unknown): unknown => JSON.parse(JSON.stringify(body));

describe('golden: mapGenerateError (JSON transports)', () => {
  it('SpecResolutionError → 400 SpecResolutionError + cause', () => {
    const err = new SpecResolutionError({ cause: 'no model' });
    const mapped = mapGenerateError(err);
    expect(mapped?.status).toBe(400);
    expect(overWire(mapped?.body)).toEqual({
      error: 'SpecResolutionError',
      cause: 'no model',
      message: 'no model',
    });
    expect(mapped?.headers).toBeUndefined();
  });

  it('RenderError → 400 RenderError', () => {
    const mapped = mapGenerateError(new RenderError('Handlebars parse error: boom'));
    expect(mapped?.status).toBe(400);
    expect(overWire(mapped?.body)).toEqual({
      error: 'RenderError',
      message: 'Handlebars parse error: boom',
    });
  });

  it('IdempotencyConflictError → 409 IdempotencyConflict + existingRequestId', () => {
    const mapped = mapGenerateError(new IdempotencyConflictError('req-123'));
    expect(mapped?.status).toBe(409);
    expect(overWire(mapped?.body)).toEqual({
      error: 'IdempotencyConflict',
      existingRequestId: 'req-123',
      message: 'clientRequestId already used with a different payload (request req-123)',
    });
  });

  it('DependencyCycleError → 400 DependencyCycleError + cycle', () => {
    const mapped = mapGenerateError(new DependencyCycleError(['a', 'b', 'a']));
    expect(mapped?.status).toBe(400);
    expect(overWire(mapped?.body)).toEqual({
      error: 'DependencyCycleError',
      cycle: ['a', 'b', 'a'],
      message: 'dependsOn cycle detected: a → b → a',
    });
  });

  it('CrossBatchDependencyError → 400 CrossBatchDependencyError + missing', () => {
    const mapped = mapGenerateError(new CrossBatchDependencyError(['x', 'y']));
    expect(mapped?.status).toBe(400);
    expect(overWire(mapped?.body)).toEqual({
      error: 'CrossBatchDependencyError',
      missing: ['x', 'y'],
      message: 'dependsOn references unitKeys not in batch: x, y',
    });
  });

  it('BudgetNotConfigured → 402 BudgetNotConfigured + org', () => {
    const mapped = mapGenerateError(new BudgetNotConfigured('acme'));
    expect(mapped?.status).toBe(402);
    expect(overWire(mapped?.body)).toEqual({
      error: 'BudgetNotConfigured',
      org: 'acme',
      message: 'no budget configured for org acme',
    });
  });

  it('BudgetMisconfigured → 402 BudgetMisconfigured + org + finite estimate', () => {
    const err = new BudgetMisconfigured('acme', 0, { project: 'p', unitKey: 'u' });
    const mapped = mapGenerateError(err);
    expect(mapped?.status).toBe(402);
    expect(overWire(mapped?.body)).toEqual({
      error: 'BudgetMisconfigured',
      org: 'acme',
      estimatedCostUsdPerCall: 0,
      message: err.message,
    });
  });

  it('BudgetMisconfigured with a non-finite estimate → null on the wire', () => {
    // The exact value survives in `message` only; `NaN` has no JSON encoding.
    const err = new BudgetMisconfigured('acme', Number.NaN);
    const body = overWire(mapGenerateError(err)?.body) as Record<string, unknown>;
    expect(body['estimatedCostUsdPerCall']).toBeNull();
    expect(String(err.message)).toContain('estimatedCostUsdPerCall=NaN');
  });

  it('BudgetExceeded → 402 BudgetExceeded + org/requested/remaining/shortfallUsd', () => {
    const err = new BudgetExceeded('acme', 1.5, 0.25);
    const mapped = mapGenerateError(err);
    expect(mapped?.status).toBe(402);
    expect(overWire(mapped?.body)).toEqual({
      error: 'BudgetExceeded',
      org: 'acme',
      requested: 1.5,
      remaining: 0.25,
      shortfallUsd: 1.25,
      message: err.message,
    });
    expect(err.message).toContain('Budget exceeded for org=acme');
  });

  it('ProviderUnavailable → 503 + Retry-After header + retryAfterMs body', () => {
    const err = new ProviderUnavailable(30_000);
    const mapped = mapGenerateError(err);
    expect(mapped?.status).toBe(503);
    expect(mapped?.headers).toEqual({ 'retry-after': '30' });
    expect(overWire(mapped?.body)).toEqual({
      error: 'ProviderUnavailable',
      code: 'ERR_PROVIDER_UNAVAILABLE',
      retryAfterMs: 30_000,
      message: err.message,
    });
  });

  it('EmptyCompletion → 502 EmptyCompletion + code + traceId', () => {
    const err = new EmptyCompletion({ traceId: 'trace-1' });
    const mapped = mapGenerateError(err);
    expect(mapped?.status).toBe(502);
    expect(mapped?.headers).toBeUndefined();
    expect(overWire(mapped?.body)).toEqual({
      error: 'EmptyCompletion',
      code: 'ERR_EMPTY_COMPLETION',
      traceId: 'trace-1',
      message: 'The LLM provider returned an empty answer.',
    });
  });

  it('an unmapped error returns undefined so Fastify produces the generic 500', () => {
    expect(mapGenerateError(new Error('internal detail: db password rejected'))).toBeUndefined();
    expect(mapGenerateError('not an error at all')).toBeUndefined();
  });

  it('one of OURS marked `expose = false` also returns undefined — no body, no leak', () => {
    class Internal extends AiServiceError {
      readonly code = 'ERR_INTERNAL_THING';
      readonly status = 503;
      override readonly expose = false;
    }
    expect(mapGenerateError(new Internal('upstream said: <secret body snippet>'))).toBeUndefined();
  });
});

describe('golden: classifyStreamError (SSE transport)', () => {
  it('ProviderUnavailable → typed code + errorCode + retryAfterMs', () => {
    const err = new ProviderUnavailable(30_000);
    expect(classifyStreamError(err)).toEqual({
      code: 'ProviderUnavailable',
      errorCode: 'ERR_PROVIDER_UNAVAILABLE',
      retryAfterMs: 30_000,
      message: err.message,
    });
  });

  it('EmptyCompletion → typed code + errorCode + traceId', () => {
    expect(classifyStreamError(new EmptyCompletion({ traceId: 'trace-1' }))).toEqual({
      code: 'EmptyCompletion',
      errorCode: 'ERR_EMPTY_COMPLETION',
      traceId: 'trace-1',
      message: 'The LLM provider returned an empty answer.',
    });
  });

  it.each([
    ['SpecResolutionError', new SpecResolutionError({ cause: 'no model' }), 'SpecResolutionError'],
    ['RenderError', new RenderError('boom'), 'RenderError'],
    ['BudgetNotConfigured', new BudgetNotConfigured('acme'), 'BudgetNotConfigured'],
    ['BudgetMisconfigured', new BudgetMisconfigured('acme', 0), 'BudgetMisconfigured'],
    ['BudgetExceeded', new BudgetExceeded('acme', 1, 0), 'BudgetExceeded'],
  ])('%s → code %s, message verbatim, no extra frame fields', (_label, err, code) => {
    expect(classifyStreamError(err)).toEqual({ code, message: (err as Error).message });
  });

  it.each([
    'IdempotencyConflictError',
    'DependencyCycleError',
    'CrossBatchDependencyError',
  ])('%s is NOT reachable post-hijack, so it collapses to INTERNAL', (label) => {
    const err =
      label === 'IdempotencyConflictError'
        ? new IdempotencyConflictError('req-1')
        : label === 'DependencyCycleError'
          ? new DependencyCycleError(['a', 'a'])
          : new CrossBatchDependencyError(['x']);
    expect(classifyStreamError(err)).toEqual({ code: 'INTERNAL', message: 'generation failed' });
  });

  it('an unknown error leaks nothing: INTERNAL + a generic message', () => {
    expect(classifyStreamError(new Error('db password rejected'))).toEqual({
      code: 'INTERNAL',
      message: 'generation failed',
    });
    expect(classifyStreamError({ nope: true })).toEqual({
      code: 'INTERNAL',
      message: 'generation failed',
    });
  });

  it('a budget error from a DUPLICATE class identity is still typed', () => {
    // Guards the cross-module-identity hazard: an `instanceof` chain misses a
    // class loaded twice (two resolutions of the same file) and the frame
    // silently degrades to INTERNAL mid-generation. A brand does not.
    class BudgetExceededTwin extends AiServiceError {
      readonly code = 'ERR_BUDGET_EXCEEDED';
      readonly status = 402;
      override readonly midStream = true;
      constructor() {
        super('Budget exceeded for org=acme: ...');
        this.name = 'BudgetExceeded';
      }
    }
    const twin = new BudgetExceededTwin();
    expect(twin instanceof BudgetExceeded).toBe(false);
    expect(classifyStreamError(twin)).toEqual({
      code: 'BudgetExceeded',
      message: 'Budget exceeded for org=acme: ...',
    });
  });

  it('a plain Error merely NAMED like ours is not typed — the brand is the test', () => {
    // Tightened deliberately: `classifyStreamError` used to duck-type on
    // `err.name`, so any error a library happened to name `BudgetExceeded`
    // would have been echoed to the client as a budget refusal.
    const impostor = new Error('internal detail');
    impostor.name = 'BudgetExceeded';
    expect(classifyStreamError(impostor)).toEqual({
      code: 'INTERNAL',
      message: 'generation failed',
    });
  });

  it('an exposed error that is NOT mid-stream still collapses to INTERNAL', () => {
    class PreHijackOnly extends AiServiceError {
      readonly code = 'ERR_PRE_HIJACK';
      readonly status = 400;
    }
    expect(classifyStreamError(new PreHijackOnly('detail'))).toEqual({
      code: 'INTERNAL',
      message: 'generation failed',
    });
  });

  it('a mid-stream class marked `expose = false` still collapses — no snippet in a frame', () => {
    // The mirror of the `mapGenerateError` case above. A frame has no status
    // line to redact, so `message` IS the whole leak surface here.
    class LeakyMidStream extends AiServiceError {
      readonly code = 'ERR_LEAKY_MID_STREAM';
      readonly status = 503;
      override readonly expose = false;
      override readonly midStream = true;
    }
    expect(classifyStreamError(new LeakyMidStream('upstream said: <secret body snippet>'))).toEqual(
      { code: 'INTERNAL', message: 'generation failed' },
    );
  });
});

// ---------------------------------------------------------------------------
// CHANGED vs main — declared, deliberate, and exactly one
// ---------------------------------------------------------------------------
//
// Everything above is byte-for-byte what `main` sent. This block is the sole
// exception, recorded here so the diff cannot be mistaken for drift.
//
// `POST /v1/embed`. On `main` the route caught budget refusals in a two-arm
// `instanceof` chain — `BudgetNotConfigured` and `BudgetExceeded`, both 402 —
// and rethrew anything else. `BudgetMisconfigured` was NOT in that chain (on
// `main` it extended plain `Error` with no `statusCode`), so `budget.reserve()`
// raising it answered a Fastify generic 500.
//
// It now answers 402 with the typed body below, because the route stopped
// re-deciding and the /v1 handler reads the class. That is the intended fix: a
// zero/NaN `estimatedCostUsdPerCall` on an effort profile is a caller-visible
// CONFIG fault an admin can act on, not a server error — and it is the answer
// `/v1/generate` has always given for the same class, so this REMOVES a
// per-route divergence rather than adding one.
//
// Consumer impact: a client that treats 5xx as retryable and 402 as terminal
// stops retrying a request that could never have succeeded. Nothing in
// `@edc/ai-client` switches on 500 for this route.
describe('changed vs main: /v1/embed answers BudgetMisconfigured 402, not 500', () => {
  it('the class carries the 402 the route no longer decides', () => {
    const err = new BudgetMisconfigured('acme', 0, { project: 'p', unitKey: 'u' });
    expect(err.status).toBe(402);
    expect(err.expose).toBe(true);
    const mapped = mapGenerateError(err);
    expect(mapped?.status).toBe(402);
    expect(overWire(mapped?.body)).toEqual({
      error: 'BudgetMisconfigured',
      org: 'acme',
      estimatedCostUsdPerCall: 0,
      message: err.message,
    });
  });

  it('its two siblings are unchanged — they WERE in the old chain', () => {
    expect(mapGenerateError(new BudgetNotConfigured('acme'))?.status).toBe(402);
    expect(mapGenerateError(new BudgetExceeded('acme', 1.5, 0.25))?.status).toBe(402);
  });
});

// ---------------------------------------------------------------------------
// CHANGED — the route layer stopped flattening
// ---------------------------------------------------------------------------
//
// Seven route sites caught a typed `AiServiceError` and re-sent it through
// fastify-sensible (`reply.badRequest` / `reply.notFound`), which serialises
// `{statusCode, error: 'Bad Request' | 'Not Found', message}`. The taxonomy
// discriminator was gone before the body was written, so SIX `ERR_` codes had
// no way to reach a caller and `@edc/ai-client` recorded them as
// `reachable: 'flattened'`.
//
// Those catches are removed. Each class now reaches the ONE `/v1` error handler
// and goes out as its own `toBody()`. The six flat classes additionally extend
// `CodedEnvelopeError`, so the body carries `code` — which is what makes them
// branchable on a client version that predates the class name.
//
// ⚠ EVERY `it` below is a DECLARED WIRE CHANGE. A red line here is a consumer
// break, not a test to update. Sabotage check: restore any one `reply.badRequest
// (err.message)` / `reply.notFound(err.message)` arm in the named route and the
// matching case goes red on the body (and, for RegistryNotFound, on nothing
// else — the status was already right, which is exactly why nobody noticed).
//
//   route                                 before (the fix)                              after
//   POST   /v1/corpora                     400 {statusCode,error:'Bad Request',message}  400 {error:'EmbeddingDimensionMismatchError',code:'ERR_EMBEDDING_DIMENSION_MISMATCH',message}
//   PATCH  /v1/corpora/:name               400 {statusCode,error:'Bad Request',message}  400 {error:'InvalidTextSearchConfigError',code:'ERR_INVALID_TEXT_SEARCH_CONFIG',message}
//                                                    ″                                   400 {error:'EmbeddingDimensionMismatchError',code:'ERR_EMBEDDING_DIMENSION_MISMATCH',message}
//   POST   /v1/ingest                      400 {statusCode,error:'Bad Request',message}  400 {error:'EmbeddingDimensionMismatchError',code:…,message}
//                                                    ″                                   400 {error:'CallbackUrlBlockedError',code:'ERR_CALLBACK_URL_BLOCKED',message}
//   POST   /v1/generate                    400 {statusCode,error:'Bad Request',message}  400 {error:'CallbackUrlBlockedError',code:'ERR_CALLBACK_URL_BLOCKED',message}
//   PATCH  /v1/corpus/:n/documents/:e/validity
//                                          400 {statusCode,error:'Bad Request',message}  400 {error:'InvalidValidityIntervalError',code:'ERR_INVALID_VALIDITY_INTERVAL',message}
//   POST   /v1/registry/…/versions         400 {statusCode,error:'Bad Request',message}  400 {error:'RegistryConflictError',code:'ERR_REGISTRY_CONFLICT',message}
//   POST   /v1/registry/…/:v/activate      404 {statusCode,error:'Not Found',message}    404 {error:'RegistryNotFoundError',code:'ERR_REGISTRY_NOT_FOUND',message}
//   POST   /v1/retrieve                    404 {statusCode,error:'Not Found',message}    404 {error:{code:'CORPUS_NOT_FOUND',message}}
//
// The STATUS is unchanged on every row. Only the body shape moves.
//
// `RegistryConflictError` keeps its 400. Its name suggests 409, but 400 is what
// `POST /v1/registry/…/versions` has answered since M3 and the class already
// declared it; changing the status AND the body in one commit would give a
// consumer two things to follow at once. Recorded as an open item, not fixed
// here.
//
// NOT changed, and deliberately: `POST /v1/corpus/:name/alias` used to
// hand-build a 404/409 with the class's OWN nested shape but a SHORTER message
// that omitted `(org=…, project=…)`. The shortening moved into
// `TargetCorpusNotFoundError` / `AliasNameConflictError` themselves, so those
// two routes send byte-identical bodies while the route stops re-deciding.
// Pinned below so the message cannot silently regrow the caller's scope.

describe('changed vs the earlier contract: the six flattened classes now send their own envelope', () => {
  it.each([
    [
      'EmbeddingDimensionMismatchError',
      new EmbeddingDimensionMismatchError('baai/bge-m3', 1024, 1536),
      400,
      'ERR_EMBEDDING_DIMENSION_MISMATCH',
    ],
    [
      'InvalidTextSearchConfigError',
      new InvalidTextSearchConfigError('klingon'),
      400,
      'ERR_INVALID_TEXT_SEARCH_CONFIG',
    ],
    [
      'InvalidValidityIntervalError',
      new InvalidValidityIntervalError('validFrom must be before validTo'),
      400,
      'ERR_INVALID_VALIDITY_INTERVAL',
    ],
    [
      'CallbackUrlBlockedError',
      new CallbackUrlBlockedError('callback URL host is not allowed'),
      400,
      'ERR_CALLBACK_URL_BLOCKED',
    ],
    [
      'RegistryConflictError',
      new RegistryConflictError("version '1' already exists"),
      400,
      'ERR_REGISTRY_CONFLICT',
    ],
    [
      'RegistryNotFoundError',
      new RegistryNotFoundError("version '9' not found"),
      404,
      'ERR_REGISTRY_NOT_FOUND',
    ],
  ])('%s → flat body carrying its own discriminator AND `code`', (name, err, status, code) => {
    const e = err as AiServiceError;
    expect(e.status).toBe(status);
    expect(e.expose).toBe(true);
    // `mapGenerateError` and the /v1 error handler both send exactly this.
    expect(overWire(e.toBody())).toEqual({
      error: name,
      code,
      message: (err as Error).message,
    });
    expect(mapGenerateError(e)?.status).toBe(status);
  });
});

describe('changed vs the earlier contract: CorpusNotFoundError has ONE envelope again', () => {
  // Was: nested from /v1/corpora + /v1/corpus, flat fastify-sensible from
  // /v1/retrieve. The nested one wins — it is what every consumer of the corpus
  // control plane parses, and `@edc/ai-client` resolves it to the class
  // by the SCREAMING key `CORPUS_NOT_FOUND`.
  it('sends the nested envelope, whichever route raised it', () => {
    const err = new CorpusNotFoundError({ corpus: 'missing', org: 'acme', project: 'chat' });
    expect(err.status).toBe(404);
    expect(overWire(err.toBody())).toEqual({
      error: {
        code: 'CORPUS_NOT_FOUND',
        message: "corpus 'missing' not found in (org=acme, project=chat)",
      },
    });
  });
});

describe('unchanged vs the earlier contract: the alias 404/409 messages stay scope-free', () => {
  // The route used to shorten these by hand. The CLASS does it now, so the
  // wire is identical — but a future edit that puts `(org=…, project=…)` back
  // into either message would start echoing the caller's scope into a body
  // that today names only the colliding corpus. That regression is what these
  // two lines exist to catch.
  it('TargetCorpusNotFoundError names the target, not the scope', () => {
    const err = new TargetCorpusNotFoundError({ target: 'other', org: 'acme', project: 'chat' });
    expect(err.status).toBe(404);
    expect(overWire(err.toBody())).toEqual({
      error: { code: 'TARGET_CORPUS_NOT_FOUND', message: "target corpus 'other' not found" },
    });
    expect(err.org).toBe('acme'); // still available to the log line
  });

  it('AliasNameConflictError names the alias, not the scope', () => {
    const err = new AliasNameConflictError({ name: 'docs', org: 'acme', project: 'chat' });
    expect(err.status).toBe(409);
    expect(overWire(err.toBody())).toEqual({
      error: {
        code: 'ALIAS_NAME_CONFLICT',
        message: "'docs' already names a corpus; alias names cannot collide with corpora",
      },
    });
    expect(err.project).toBe('chat');
  });
});

// ---------------------------------------------------------------------------
// The ROUTE layer, through `app.inject`
// ---------------------------------------------------------------------------
//
// The block above proves each CLASS declares the right body. This block proves
// each ROUTE actually sends it — the property that was false before the fix, where
// every one of these classes was correct and seven routes discarded it anyway.
//
// SABOTAGE CHECK, one per site. Restore the arm in the named route and the
// named case goes red:
//   routes/corpora.ts   POST  → `if (err instanceof EmbeddingDimensionMismatchError)
//                                  return reply.badRequest(err.message);`
//   routes/corpora.ts   PATCH → the two-arm version of the same
//   routes/ingest.ts    POST  → the EmbeddingDimensionMismatch + CallbackUrlBlocked arms
//   routes/generate.ts  POST  → the try/catch around `assertSafeCallbackUrl`
//   routes/corpus.ts    PATCH validity → the InvalidValidityInterval arm
//   routes/registry.ts  POST versions  → the RegistryConflict arm
//   routes/registry.ts  POST activate  → the RegistryNotFound arm
//   routes/retrieve.ts  POST  → the CorpusNotFound arm

const APP = 'app-key';
const ADMIN = 'admin-key';

/**
 * The pino stream of the most recent `makeApp()`, captured.
 *
 * Two jobs. It gives the unknown-error block below its log assertions, and it
 * keeps `LOG_LEVEL=info` (set in the `vi.hoisted` above) from writing every
 * request line in this file to the suite output. Reset in `afterEach`.
 */
let capture: { lines: Record<string, unknown>[]; stop: () => void } | undefined;

async function makeApp() {
  const { buildServer } = await import('../server.js');
  const app = await buildServer();
  capture = captureLogs(app);
  return app;
}

beforeEach(() => {
  for (const m of [
    createCorpusMock,
    updateCorpusMock,
    ingestBatchMock,
    setValidityMock,
    retrieveMock,
    createVersionMock,
    activateVersionMock,
  ]) {
    m.mockReset();
  }
});

afterEach(() => {
  capture?.stop();
  capture = undefined;
  vi.clearAllMocks();
});

describe('changed vs the earlier contract: the routes send the class body, not a flattened one', () => {
  it.each([
    [
      'POST /v1/corpora',
      () =>
        createCorpusMock.mockRejectedValueOnce(
          new EmbeddingDimensionMismatchError('baai/bge-m3', 1024, 1536),
        ),
      {
        method: 'POST' as const,
        url: '/v1/corpora',
        token: APP,
        payload: { name: 'policies', embeddingModel: 'baai/bge-m3' },
      },
      400,
      'EmbeddingDimensionMismatchError',
      'ERR_EMBEDDING_DIMENSION_MISMATCH',
    ],
    [
      'PATCH /v1/corpora/:name',
      () =>
        updateCorpusMock.mockRejectedValueOnce(new InvalidTextSearchConfigError('klingon')),
      {
        method: 'PATCH' as const,
        url: '/v1/corpora/policies',
        token: APP,
        payload: { chunkSize: 900 },
      },
      400,
      'InvalidTextSearchConfigError',
      'ERR_INVALID_TEXT_SEARCH_CONFIG',
    ],
    [
      'POST /v1/ingest (dimension mismatch)',
      () =>
        ingestBatchMock.mockRejectedValueOnce(
          new EmbeddingDimensionMismatchError('baai/bge-m3', 1024, 1536),
        ),
      {
        method: 'POST' as const,
        url: '/v1/ingest',
        token: APP,
        payload: { corpus: 'docs', documents: [{ text: 'hello' }] },
      },
      400,
      'EmbeddingDimensionMismatchError',
      'ERR_EMBEDDING_DIMENSION_MISMATCH',
    ],
    [
      'POST /v1/ingest (blocked callback)',
      () =>
        ingestBatchMock.mockRejectedValueOnce(
          new CallbackUrlBlockedError('callback URL host is not allowed'),
        ),
      {
        method: 'POST' as const,
        url: '/v1/ingest',
        token: APP,
        payload: { corpus: 'docs', documents: [{ text: 'hello' }] },
      },
      400,
      'CallbackUrlBlockedError',
      'ERR_CALLBACK_URL_BLOCKED',
    ],
    [
      'PATCH /v1/corpus/:name/documents/:externalId/validity',
      () =>
        setValidityMock.mockRejectedValueOnce(
          new InvalidValidityIntervalError('validFrom must be before validTo'),
        ),
      {
        method: 'PATCH' as const,
        url: '/v1/corpus/policies/documents/doc-1/validity',
        token: APP,
        payload: { validTo: '2020-01-01T00:00:00.000Z' },
      },
      400,
      'InvalidValidityIntervalError',
      'ERR_INVALID_VALIDITY_INTERVAL',
    ],
    [
      'POST /v1/registry/unit-types/:unitType/versions',
      () =>
        createVersionMock.mockRejectedValueOnce(
          new RegistryConflictError("version '1' already exists for unitType 'summary'"),
        ),
      {
        method: 'POST' as const,
        url: '/v1/registry/unit-types/summary/versions',
        token: ADMIN,
        payload: { version: '1', promptTemplate: 'hi' },
      },
      400,
      'RegistryConflictError',
      'ERR_REGISTRY_CONFLICT',
    ],
    [
      'POST /v1/registry/unit-types/:unitType/versions/:version/activate',
      () =>
        activateVersionMock.mockRejectedValueOnce(
          new RegistryNotFoundError("version '9' not found for unitType 'summary'"),
        ),
      {
        method: 'POST' as const,
        url: '/v1/registry/unit-types/summary/versions/9/activate',
        token: ADMIN,
        payload: {},
      },
      404,
      'RegistryNotFoundError',
      'ERR_REGISTRY_NOT_FOUND',
    ],
  ])('%s → %#', async (_label, arrange, req, status, discriminator, code) => {
    (arrange as () => void)();
    const app = await makeApp();
    const r = req as { method: 'POST' | 'PATCH'; url: string; token: string; payload: unknown };
    const res = await app.inject({
      method: r.method,
      url: r.url,
      headers: { authorization: `Bearer ${r.token}` },
      payload: r.payload as object,
    });
    expect(res.statusCode).toBe(status);
    const body = res.json() as Record<string, unknown>;
    // The two fields fastify-sensible's envelope could never carry.
    expect(body['error']).toBe(discriminator);
    expect(body['code']).toBe(code);
    expect(typeof body['message']).toBe('string');
    // And the field that proves it is NOT the flattened envelope.
    expect(body['statusCode']).toBeUndefined();
    await app.close();
  });

  it('POST /v1/generate answers a blocked callbackUrl with the typed class', async () => {
    // The real SSRF guard runs — no mock — so this also pins that the guard's
    // own class, not a route-invented message, is what the caller sees.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP}` },
      payload: { units: [{ unitKey: 'k-1' }], callbackUrl: 'http://169.254.169.254/meta' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body['error']).toBe('CallbackUrlBlockedError');
    expect(body['code']).toBe('ERR_CALLBACK_URL_BLOCKED');
    expect(body['statusCode']).toBeUndefined();
    await app.close();
  });

  it('POST /v1/retrieve answers CorpusNotFoundError with the NESTED envelope', async () => {
    // Was fastify-sensible's flat `{statusCode:404, error:'Not Found', message}`
    // — the same class that `/v1/corpora` answered nested. One class, one shape.
    retrieveMock.mockRejectedValueOnce(
      new CorpusNotFoundError({ corpus: 'missing', org: 'acme', project: 'chat' }),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: { authorization: `Bearer ${APP}` },
      payload: { corpus: 'missing', query: 'q' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'CORPUS_NOT_FOUND',
        message: "corpus 'missing' not found in (org=acme, project=chat)",
      },
    });
    await app.close();
  });

  it('CodedEnvelopeError is what puts `code` on the wire', () => {
    // Guards the base class itself: drop the override and every case above
    // loses its `code` while still passing on `error` alone.
    expect(new RegistryNotFoundError('x') instanceof CodedEnvelopeError).toBe(true);
    expect(new CallbackUrlBlockedError('x') instanceof CodedEnvelopeError).toBe(true);
  });
});

// ── capture what pino actually wrote ──────────────────────────────────────
// The DESTINATION, not `process.stdout.write`: pino writes through SonicBoom
// straight to fd 1, so a `process.stdout` spy captures nothing. The stream
// object is shared by every child logger, so grabbing it off the root instance
// also catches `req.log`. (Same helper as `redaction.test.ts`.)
function captureLogs(app: { log: unknown }): { lines: Record<string, unknown>[]; stop: () => void } {
  const log = app.log as Record<symbol, unknown>;
  const streamSym = Object.getOwnPropertySymbols(log).find((s) => s.description === 'pino.stream');
  if (!streamSym) throw new Error('pino stream symbol not found on the fastify logger');
  const stream = log[streamSym] as { write: (chunk: string) => unknown };
  const original = stream.write.bind(stream);
  const lines: Record<string, unknown>[] = [];
  stream.write = (chunk: string) => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* not our JSON line */
      }
    }
    return true;
  };
  return { lines, stop: () => void (stream.write = original) };
}

describe('changed vs the earlier contract: an UNKNOWN error is redacted, not published', () => {
  // ── what changed ────────────────────────────────────────────────────────
  // Before the fix the /v1 error handler's last arm `throw error`,
  // handing anything that is not an `AiServiceError` to Fastify's default
  // handler. `fastify/lib/error-handler.js` → `fallbackErrorHandler` puts
  // `error.message` — and `error.code` — verbatim on the 500 body. So a
  // `node-postgres` failure published its SQLSTATE and the driver's message
  // (schema, table and constraint names) to whoever made the request.
  //
  // The `expose = false` arm already answered such a leak itself. This block
  // pins the SAME treatment for unknown errors: generic body, detail to pino.
  //
  // ⚠ SABOTAGE (measured): restore `throw error` in place of the generic
  // `reply.code(500).send(...)` at the end of `v1.setErrorHandler` and both
  // cases below go red on the body assertions.

  const GENERIC = { statusCode: 500, error: 'Internal Server Error', message: 'internal error' };

  it('(a) a plain Error keeps its message off the body and puts it in the log', async () => {
    createCorpusMock.mockRejectedValueOnce(new Error('secret detail'));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: `Bearer ${APP}` },
      payload: { name: 'policies', embeddingModel: 'baai/bge-m3' },
    });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(GENERIC);
    // The whole payload, not the parsed message: the leak was a field.
    expect(res.payload).not.toContain('secret detail');

    // …and the operator still gets everything, at error level, scoped.
    const line = capture!.lines.find(
      (l) => l['msg'] === 'unhandled error on /v1' && JSON.stringify(l).includes('secret detail'),
    );
    expect(line).toBeDefined();
    expect(line?.['level']).toBe(50);
    expect(line?.['org']).toBe('acme');
    expect(line?.['project']).toBe('chat');
    expect(typeof line?.['httpRequestId']).toBe('string');
  });

  it('(b) a pg driver error keeps its message AND its SQLSTATE off the body', async () => {
    // Shaped like what `node-postgres` throws: `code` is the SQLSTATE, and
    // Fastify's fallback handler serialises `code` onto the body next to
    // `message`, so both had to be checked.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      severity: 'ERROR',
      table: 'corpora',
      constraint: 'corpora_org_project_name_key',
      detail: 'Key (org, project, name)=(acme, chat, policies) already exists.',
    });
    createCorpusMock.mockRejectedValueOnce(pgError);
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: `Bearer ${APP}` },
      payload: { name: 'policies', embeddingModel: 'baai/bge-m3' },
    });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(GENERIC);
    expect(res.payload).not.toContain('23505');
    expect(res.payload).not.toContain('duplicate key');
    expect(res.payload).not.toContain('corpora_org_project_name_key');
    expect(res.payload).not.toContain('already exists');

    const line = capture!.lines.find(
      (l) => l['msg'] === 'unhandled error on /v1' && JSON.stringify(l).includes('23505'),
    );
    expect(line).toBeDefined();
    expect(line?.['level']).toBe(50);
    expect(JSON.stringify(line)).toContain('duplicate key value violates unique constraint');
  });

  it('unchanged: a 4xx that is exposed BY DESIGN still ships its own envelope', async () => {
    // The other half of the arm. Fastify's `FST_ERR_VALIDATION` and
    // fastify-sensible's typed 4xx are written FOR the caller, so they are
    // still rethrown — widening the redaction to every non-taxonomy error
    // would swallow them into a 500 and this case is what catches that.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: `Bearer ${APP}` },
      payload: { embeddingModel: 'baai/bge-m3' },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body['statusCode']).toBe(400);
    expect(body['message']).not.toBe('internal error');
    // Not an ai-service fault: it must not be logged at error level.
    expect(capture!.lines.filter((l) => l['level'] === 50)).toEqual([]);
  });
});

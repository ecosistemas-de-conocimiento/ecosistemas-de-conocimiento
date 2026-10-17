// The bad requests whose 400 bodies are pinned by
// `validation-wire-golden.test.ts` against `validation-wire-golden.json`.
//
// WHY THIS EXISTS. Every /v1 route renders a validation failure as
//
//     reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '))
//
// so the DEFAULT MESSAGE STRING OF A ZOD ISSUE IS ON THE WIRE, byte for byte,
// in `body.message`. That makes a Zod major upgrade a wire event: Zod rewords
// its built-in messages between majors, and a consumer that reads the message
// (a UI that shows it, a log matcher, a test fixture) sees the change.
//
// The cases below are chosen to cover the distinct ISSUE KINDS the surface can
// produce — missing key, wrong type, min/max on string, number and array,
// enum, format (url), unrecognized key under `.strict()`, a custom `.refine`
// message, and a nested path — across both request transports (the JSON
// routes and `/v1/generate/stream`, which validates the same body before it
// upgrades to SSE and therefore answers a plain JSON 400).
//
// Every case must fail validation BEFORE any service call, so the golden runs
// with no Postgres, no Redis and no provider.

/** One recorded request. `name` keys the golden file. */
export interface ValidationGoldenCase {
  readonly name: string;
  readonly method: 'POST' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly payload: unknown;
}

export const VALIDATION_GOLDEN_CASES: readonly ValidationGoldenCase[] = [
  {
    name: 'retrieve/missing-required-keys',
    method: 'POST',
    url: '/v1/retrieve',
    payload: {},
  },
  {
    name: 'retrieve/wrong-scalar-type',
    method: 'POST',
    url: '/v1/retrieve',
    payload: { corpus: 'docs', query: 'q', topK: 'three' },
  },
  {
    name: 'retrieve/number-out-of-range',
    method: 'POST',
    url: '/v1/retrieve',
    payload: { corpus: 'docs', query: 'q', topK: 0, mmr: 5 },
  },
  {
    name: 'retrieve/unrecognized-key-under-strict',
    method: 'POST',
    url: '/v1/retrieve',
    payload: { corpus: 'docs', query: 'q', nope: 1 },
  },
  {
    name: 'generate/empty-body',
    method: 'POST',
    url: '/v1/generate',
    payload: {},
  },
  {
    name: 'generate/empty-array-and-bad-url',
    method: 'POST',
    url: '/v1/generate',
    payload: { units: [], callbackUrl: 'not-a-url' },
  },
  {
    name: 'generate/nested-path-and-min-string',
    method: 'POST',
    url: '/v1/generate',
    payload: { units: [{ unitKey: '', specOverride: { promptTemplate: 42 } }] },
  },
  {
    name: 'generate-sync/missing-nested-object',
    method: 'POST',
    url: '/v1/generate/sync',
    payload: { effortLevel: 'quick' },
  },
  {
    name: 'generate-sync/bad-enum',
    method: 'POST',
    url: '/v1/generate/sync',
    payload: { unit: { unitKey: 'u1' }, effortLevel: 'turbo' },
  },
  {
    name: 'generate-stream/empty-body',
    method: 'POST',
    url: '/v1/generate/stream',
    payload: {},
  },
  {
    name: 'route/refine-message',
    method: 'POST',
    url: '/v1/route',
    payload: {
      question: 'q',
      candidates: [{ id: 'a', description: 'd' }],
      defaultRouteId: 'nope',
    },
  },
  {
    name: 'route/union-and-array-min',
    method: 'POST',
    url: '/v1/route',
    payload: { question: '', candidates: [] },
  },
  {
    name: 'embed/wrong-container-type',
    method: 'POST',
    url: '/v1/embed',
    payload: { texts: 'not-an-array' },
  },
  {
    name: 'corpora/create-missing-name',
    method: 'POST',
    url: '/v1/corpora',
    payload: { chunkSize: 'big' },
  },
  {
    name: 'ingest/missing-documents',
    method: 'POST',
    url: '/v1/ingest',
    payload: { corpus: 'docs' },
  },
];

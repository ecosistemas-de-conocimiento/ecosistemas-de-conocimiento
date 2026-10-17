// End-to-end tests for `client.ingest.*` going through the process-wide gate.
//
// These use a fake `fetch`, so they assert the property that matters: no call
// site can reach `POST /v1/ingest` without being admitted first.

import { describe, expect, it, beforeEach } from 'vitest';

import { AIClient } from './index.js';
import { IngestNotFoundError, NotFoundError, RateLimitError } from './errors.js';
import {
  IngestBatchTooLargeError,
  IngestRateLimitExhaustedError,
  _resetIngestGatesForTests,
  type IngestGateConfig,
} from './ingest-gate.js';
import type { IngestDocument, IngestResult } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for a CONDITION, never for a duration.
 *
 * 🔴 THE REASON THIS EXISTS. This file used to prove rate limiting by sleeping a
 * fixed 80ms and asserting a count, and by asserting a floor on the gap between
 * recorded fetches. Both are measurements of the MACHINE, and both failed on a
 * loaded box: the gap floor of 130 came back 129, 123 and 77, and the fixed
 * sleep returned 6 admissions where it wanted 3. Run alone the file passed 4 of
 * 5 — the signature of a test whose result depends on what else the host is
 * doing.
 *
 * A slow host must make this WAIT LONGER, never fail. The timeout is a
 * backstop for a condition that will never come true, and it rejects loudly
 * rather than resolving and letting the assertion after it run against a state
 * that never arrived.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(1);
  }
}

function tiny(over: Partial<IngestGateConfig> = {}): Partial<IngestGateConfig> {
  return {
    maxConcurrent: 4,
    maxPerWindow: 3,
    windowMs: 150,
    maxAttempts: 3,
    deadlineMs: { interactive: 600, bulk: 3_000 },
    queueDeadlineMs: { interactive: 400, bulk: 8_000 },
    maxRetryAfterMs: 800,
    retryAfterPaddingMs: 0,
    fallbackRetryAfterMs: 20,
    ...over,
  };
}

interface Call {
  path: string;
  at: number;
  body: { corpus?: string; documents?: IngestDocument[] } | undefined;
}

/** Records every request and answers with whatever `answer` returns. */
function harness(answer: (n: number, call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const t0 = Date.now();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const call: Call = {
      path: url.replace('https://ai.test', ''),
      at: Date.now() - t0,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(calls.length, call);
  };
  return { calls, fetchImpl };
}

const accepted = (id: string, total: number): Response =>
  new Response(JSON.stringify({ ingestId: id, corpusId: 'corp', totalDocs: total } satisfies IngestResult), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });

const refused = (retryAfterMs: number | null, headers: Record<string, string> = {}): Response =>
  new Response(
    JSON.stringify({
      error: 'RateLimitExceeded',
      message: `Rate limit exceeded. Retry after ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    }),
    { status: 429, headers: { 'content-type': 'application/json', ...headers } },
  );

const docs = (n: number, prefix = 'd'): IngestDocument[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `text ${i}` }));

let keyCounter = 0;
function client(gate: Partial<IngestGateConfig>, fetchImpl: typeof fetch): AIClient {
  keyCounter += 1;
  return new AIClient({
    baseUrl: 'https://ai.test',
    apiKey: `k-${keyCounter}`,
    fetch: fetchImpl,
    ingestGate: gate,
  });
}

beforeEach(() => {
  _resetIngestGatesForTests();
});

// ---------------------------------------------------------------------------

describe('the gate cannot be defeated by one-document calls', () => {
  // This is the exact shape that neutralised a prior batch-shaped throttle: a
  // per-row hook handing over one document at a time, so a batch of 40 never
  // filled and its delay never fired. 98.8% of a failed production seed was
  // this shape.
  //
  // 🔴 THESE ASSERT THE GATE'S DECISION, NOT ELAPSED MILLISECONDS, AND THAT IS
  // THE WHOLE POINT OF THE REWRITE. `IngestGate.stats()` reports the limiter's
  // OWN accounting — `admitsInWindow` and `waiting` — so the test can read what
  // the gate decided instead of inferring it from a stopwatch. The budget being
  // applied is the contract; the milliseconds are an implementation detail that
  // a loaded box perturbs. See `until` above for what the old form cost.
  //
  // The gate is constructed and injected rather than passed as config so the
  // test holds the instance and can ask it. `_setIngestGateForTests` with no
  // scope is a process-wide override — see the injection tests at the bottom.
  const install = async (over: Record<string, unknown>) => {
    const { IngestGate, _setIngestGateForTests } = await import('./ingest-gate.js');
    const gate = new IngestGate({ maxConcurrent: 10, maxPerWindow: 3, windowMs: 150, ...over });
    _setIngestGateForTests(gate);
    return gate;
  };

  const fanOut = (c: AIClient, n: number) =>
    Array.from({ length: n }, (_, i) =>
      c.ingest.enqueue({ corpus: 'c', documents: docs(1, `row${i}-`) }, { lane: 'bulk' }),
    );

  it('bounds ADMISSIONS, not documents — 10 single-doc enqueues respect maxPerWindow', async () => {
    const gate = await install({ maxPerWindow: 3 });
    const { calls, fetchImpl } = harness((n) => accepted(`i${n}`, 1));
    const c = new AIClient({ baseUrl: 'https://ai.test', apiKey: 'k-admissions', fetch: fetchImpl });
    const all = fanOut(c, 10);

    // Wait for the gate to have DECIDED — first admission out the door — rather
    // than sleeping a fixed 80ms and hoping the decision landed inside it.
    await until(() => calls.length > 0, 'the first admission');

    // The decision itself, read off the limiter: it never let more than the
    // budget through in a window, and it therefore refused the rest for now.
    // Both are UPPER bounds, so a slow host can only make them more true.
    expect(gate.stats().admitsInWindow).toBeLessThanOrEqual(3);
    expect(calls.length).toBeLessThan(10); // NOT 10 — the whole point
    expect(gate.stats().waiting).toBeGreaterThan(0); // the rest are parked, not dropped

    // Liveness: parked is not lost. Everything eventually goes.
    await Promise.all(all);
    expect(calls.length).toBe(10);
  });

  it('🔴 the budget is the CONFIGURED one — a smaller maxPerWindow admits fewer', async () => {
    // Without this, the test above would pass just as happily against a gate
    // that ignored its config and admitted some arbitrary smaller number. This
    // is the assertion that catches a limiter reading the wrong budget, and it
    // contains no clock at all.
    const gate = await install({ maxPerWindow: 1 });
    const { calls, fetchImpl } = harness((n) => accepted(`i${n}`, 1));
    const c = new AIClient({ baseUrl: 'https://ai.test', apiKey: 'k-budget', fetch: fetchImpl });
    const all = fanOut(c, 10);

    await until(() => calls.length > 0, 'the first admission');
    expect(gate.stats().admitsInWindow).toBeLessThanOrEqual(1);
    expect(gate.stats().waiting).toBeGreaterThan(0);

    await Promise.all(all);
    expect(calls.length).toBe(10);
  });
});

describe('the 100-document schema cap', () => {
  it('enqueue refuses an oversized batch BEFORE the network call', async () => {
    const { calls, fetchImpl } = harness(() => accepted('i1', 1));
    const c = client(tiny(), fetchImpl);
    const err = await c.ingest.enqueue({ corpus: 'c', documents: docs(101) }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestBatchTooLargeError);
    expect(err.documentCount).toBe(101);
    expect(err.message).toContain('enqueueAll');
    expect(calls.length).toBe(0); // no round trip, no rate slot burnt
  });

  it('enqueueAll chunks 250 documents into 100 / 100 / 50', async () => {
    const { calls, fetchImpl } = harness((n) => accepted(`i${n}`, 1));
    const c = client(tiny({ maxPerWindow: 100, windowMs: 60_000 }), fetchImpl);
    const seen: Array<{ id: string; n: number }> = [];
    const results = await c.ingest.enqueueAll(
      { corpus: 'c', documents: docs(250) },
      { lane: 'bulk', onBatch: (r, d) => seen.push({ id: r.ingestId, n: d.length }) },
    );
    expect(calls.map((x) => x.body?.documents?.length)).toEqual([100, 100, 50]);
    expect(results.map((r) => r.ingestId)).toEqual(['i1', 'i2', 'i3']);
    // One ingestId PER BATCH, handed over as each lands.
    expect(seen).toEqual([{ id: 'i1', n: 100 }, { id: 'i2', n: 100 }, { id: 'i3', n: 50 }]);
  });

  it('a mid-sequence failure names EVERY unsent document and the batches that DID land', async () => {
    const { fetchImpl } = harness((n) => (n === 1 ? accepted('i1', 100) : refused(5)));
    const c = client(tiny({ maxAttempts: 2, maxPerWindow: 100, windowMs: 60_000 }), fetchImpl);
    const err: IngestRateLimitExhaustedError = await c.ingest
      .enqueueAll({ corpus: 'c', documents: docs(250) }, { lane: 'bulk' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IngestRateLimitExhaustedError);
    // batch 2 (100) + batch 3 (50) = 150 unsent, named individually
    expect(err.documentIds).toHaveLength(150);
    expect(err.documentIds[0]).toBe('d100');
    expect(err.documentIds.at(-1)).toBe('d249');
    // batch 1 DID land — a caller must not treat this as a no-op
    expect(err.partialResults?.map((r) => r.ingestId)).toEqual(['i1']);
    expect(err.describe()).toContain('i1');
  });

  it('labels documents that carry no id, so a failure is still re-drivable', async () => {
    const { fetchImpl } = harness(() => refused(5));
    const c = client(tiny({ maxAttempts: 1, maxPerWindow: 100, windowMs: 60_000 }), fetchImpl);
    const err: IngestRateLimitExhaustedError = await c.ingest
      .enqueue({ corpus: 'c', documents: [{ text: 'a', title: 'Chapter One' }, { text: 'b' }] })
      .catch((e) => e);
    expect(err.documentIds).toEqual(['(no id, title="Chapter One")', '(no id, document #1)']);
  });
});

describe('429 handling through the real client', () => {
  it('retries after the server-stated wait and then succeeds', async () => {
    const { calls, fetchImpl } = harness((n) => (n === 1 ? refused(200) : accepted('i2', 1)));
    const c = client(tiny({ maxPerWindow: 100, windowMs: 60_000 }), fetchImpl);
    const out = await c.ingest.enqueue({ corpus: 'c', documents: docs(1) });
    expect(out.ingestId).toBe('i2');
    expect(calls.length).toBe(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(180);
  });

  it('🔴 reads Retry-After from the RESPONSE HEADER when the body carries no retryAfterMs', async () => {
    // `HttpClient.json()` used to discard the `Response`, so no consumer could
    // ever see a response header. Fixed in this package.
    const { fetchImpl } = harness((n) => (n === 1 ? refused(null, { 'retry-after': '59' }) : accepted('i2', 1)));
    const c = client(tiny(), fetchImpl);
    const err: unknown = await c.http
      .json({ method: 'POST', path: '/v1/ingest', body: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(59_000);
  });
});

describe('status polls are deliberately NOT gated', () => {
  it('a status poll goes straight through while the gate is saturated', async () => {
    const { calls, fetchImpl } = harness(async (_n, call) => {
      if (call.path.startsWith('/v1/ingest/')) {
        return new Response(
          JSON.stringify({ ingestId: 'x', totalDocs: 1, completedDocs: 1, failedDocs: 0, status: 'completed' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      await sleep(250); // hold the single concurrency slot
      return accepted('i1', 1);
    });
    const c = client(tiny({ maxConcurrent: 1, maxPerWindow: 50, windowMs: 60_000 }), fetchImpl);
    const first = c.ingest.enqueue({ corpus: 'c', documents: docs(1) }, { lane: 'bulk' });
    const queued = c.ingest.enqueue({ corpus: 'c', documents: docs(1, 'z') }, { lane: 'bulk' });
    await sleep(20);
    // The gate is saturated: one call in flight for 250ms, one waiting.
    const t = Date.now();
    const st = await c.ingest.status('x');
    expect(Date.now() - t).toBeLessThan(120); // not parked behind the queue
    expect(st.status).toBe('completed');
    await Promise.all([first, queued]);
    expect(calls.some((x) => x.path === '/v1/ingest/x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test-injection ergonomics
// ---------------------------------------------------------------------------

describe('_setIngestGateForTests', () => {
  it('with no scope, a real AIClient uses the injected gate', async () => {
    // 🔴 The trap this proves closed: `AIClient` derives its gate scope from
    // (baseUrl, apiKey). If the test helper installed only under the DEFAULT
    // scope, a suite injecting a fast gate would be silently ignored — the
    // client would quietly run against the production 40/min budget and look
    // like a hang. A scope-less injection is a process-wide override.
    const { IngestGate, _setIngestGateForTests } = await import('./ingest-gate.js');
    const { calls, fetchImpl } = harness((n) => accepted(`i${n}`, 1));
    const gate = new IngestGate({ maxConcurrent: 10, maxPerWindow: 2, windowMs: 5_000 });
    _setIngestGateForTests(gate);
    const c = new AIClient({ baseUrl: 'https://ai.test', apiKey: 'k-inject', fetch: fetchImpl });
    const all = Array.from({ length: 4 }, (_, i) =>
      c.ingest.enqueue({ corpus: 'c', documents: docs(1, `q${i}-`) }, { lane: 'bulk' }),
    );
    // Same decision-not-duration shape as the admissions tests above: this used
    // to `sleep(80)` and assert an exact count, which is the identical construct
    // that failed returning 6 where it wanted 3. Nothing here had gone red yet —
    // it was the same latent flake sitting next to the one that had.
    await until(() => calls.length > 0, 'the injected gate to admit');
    expect(gate.stats().admitsInWindow).toBeLessThanOrEqual(2); // the INJECTED budget, not the default 40
    expect(calls.length).toBeLessThan(4);
    // The window is 5s, so the remaining two stay parked; do not wait them out.
    expect(gate.stats().waiting).toBeGreaterThan(0);
    await Promise.race([Promise.all(all), sleep(200)]);
  });

  it('an explicit scope still targets exactly that gate', async () => {
    const { IngestGate, _setIngestGateForTests, getIngestGate, ingestGateScopeFor } =
      await import('./ingest-gate.js');
    const mine = new IngestGate({ maxPerWindow: 2 });
    const scope = ingestGateScopeFor('https://ai.test', 'k-scoped');
    _setIngestGateForTests(mine, scope);
    expect(getIngestGate(scope)).toBe(mine);
    expect(getIngestGate('some-other-scope')).not.toBe(mine);
  });
});

// ---------------------------------------------------------------------------
// status(): unknown id → typed 404 (0.24.0)
// ---------------------------------------------------------------------------

describe('ingest.status — unknown id', () => {
  const notFound = (body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });

  it('throws IngestNotFoundError, which is also a NotFoundError', async () => {
    const { fetchImpl } = harness(() =>
      notFound({
        error: 'IngestNotFoundError',
        code: 'ERR_INGEST_NOT_FOUND',
        ingestId: '00000000-0000-4000-8000-000000000000',
        message: "ingest '00000000-0000-4000-8000-000000000000' not found in this org/project",
      }),
    );
    const c = client(tiny(), fetchImpl);
    const err = await c.ingest.status('00000000-0000-4000-8000-000000000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestNotFoundError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as IngestNotFoundError).status).toBe(404);
    expect((err as IngestNotFoundError).code).toBe('ERR_INGEST_NOT_FOUND');
  });

  it('resolves by code alone when the discriminator is generic', async () => {
    const { fetchImpl } = harness(() =>
      notFound({ error: 'Not Found', code: 'ERR_INGEST_NOT_FOUND', message: 'gone' }),
    );
    const c = client(tiny(), fetchImpl);
    await expect(c.ingest.status('x')).rejects.toBeInstanceOf(IngestNotFoundError);
  });

  it('passes per-document chunk counts through on a terminal batch', async () => {
    const body = {
      ingestId: 'i',
      totalDocs: 1,
      completedDocs: 1,
      failedDocs: 0,
      status: 'completed',
      chunkCount: 3,
      documents: [{ docId: 'doc-a', chunkCount: 3 }],
    };
    const { fetchImpl } = harness(
      () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const c = client(tiny(), fetchImpl);
    const st = await c.ingest.status('i');
    expect(st.chunkCount).toBe(3);
    expect(st.documents).toEqual([{ docId: 'doc-a', chunkCount: 3 }]);
  });
});

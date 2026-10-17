// Tests for the coalescing ingest batcher.
//
// Real timers, tiny numbers, same posture as `ingest-gate.test.ts`. Each test
// was run against a deliberately broken batcher to prove it can fail; the
// mutations and their results are in the branch's commit message.

import { beforeEach, describe, expect, it } from 'vitest';

import { IngestAPI } from './ingest.js';
import { IngestBatcher, IngestBatcherFullError, type IngestBatchFailure } from './ingest-batcher.js';
import { IngestGate, _resetIngestGatesForTests, _setIngestGateForTests } from './ingest-gate.js';
import type { IngestDocument, IngestRequest, IngestResult } from './types.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Call {
  req: IngestRequest;
  lane: string | undefined;
}

/** A fake `client.ingest` that records every call and can be told to fail. */
function fakeIngest(opts: { fail?: (req: IngestRequest) => unknown; delayMs?: number } = {}) {
  const calls: Call[] = [];
  let n = 0;
  return {
    calls,
    enqueue: async (req: IngestRequest, o: { lane?: string } = {}): Promise<IngestResult> => {
      calls.push({ req, lane: o.lane });
      if (opts.delayMs) await sleep(opts.delayMs);
      const err = opts.fail?.(req);
      if (err) throw err;
      n += 1;
      return { ingestId: `ing-${n}`, corpusId: 'cid', totalDocs: req.documents.length };
    },
  };
}

const doc = (id: string, text = `text of ${id}`): IngestDocument => ({ id, text });
const ids = (c: Call) => c.req.documents.map((d) => d.id);

function collect() {
  const failures: IngestBatchFailure[] = [];
  const landed: Array<{ result: IngestResult; documents: IngestDocument[] }> = [];
  return {
    failures,
    landed,
    onError: (f: IngestBatchFailure) => failures.push(f),
    onBatch: (result: IngestResult, documents: IngestDocument[]) => landed.push({ result, documents }),
  };
}

beforeEach(() => _resetIngestGatesForTests());

describe('coalescing', () => {
  it('last write wins per (corpus, id), and sends on the bulk lane', async () => {
    const ingest = fakeIngest();
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 30 });
    b.add({ corpus: 'c' }, doc('a', 'v1'));
    b.add({ corpus: 'c' }, doc('b'));
    b.add({ corpus: 'c' }, doc('a', 'v2'));
    await sleep(80);
    expect(ingest.calls).toHaveLength(1);
    expect(ids(ingest.calls[0]!)).toEqual(['b', 'a']);
    expect(ingest.calls[0]!.req.documents.find((d) => d.id === 'a')!.text).toBe('v2');
    expect(ingest.calls[0]!.lane).toBe('bulk');
  });

  it('never merges across corpora or across different batch-level fields', async () => {
    const ingest = fakeIngest();
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 30 });
    b.add({ corpus: 'c1' }, doc('a'));
    b.add({ corpus: 'c2' }, doc('a'));
    b.add({ corpus: 'c1', callbackUrl: 'https://x/cb' }, doc('b'));
    // Same fields, different key order: same batch.
    b.add({ callbackUrl: 'https://x/cb', corpus: 'c1' }, doc('c'));
    await sleep(80);
    const shapes = ingest.calls.map((c) => `${c.req.corpus}|${c.req.callbackUrl ?? ''}|${ids(c).join(',')}`);
    expect(shapes.sort()).toEqual(['c1|https://x/cb|b,c', 'c1||a', 'c2||a']);
  });
});

describe('flush timing', () => {
  it('waits for quietMs of silence before sending', async () => {
    const ingest = fakeIngest();
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 60, maxWaitMs: 1_000 });
    b.add({ corpus: 'c' }, doc('a'));
    await sleep(30);
    b.add({ corpus: 'c' }, doc('b')); // resets the quiet clock
    await sleep(40);
    expect(ingest.calls).toHaveLength(0);
    await sleep(60);
    expect(ingest.calls).toHaveLength(1);
    expect(ids(ingest.calls[0]!)).toEqual(['a', 'b']);
  });

  it('maxWaitMs bounds the delay under a steady trickle that never goes quiet', async () => {
    const ingest = fakeIngest();
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 50, maxWaitMs: 150 });
    const t0 = Date.now();
    let i = 0;
    while (ingest.calls.length === 0 && Date.now() - t0 < 600) {
      b.add({ corpus: 'c' }, doc(`d${i++}`));
      await sleep(20);
    }
    expect(ingest.calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(300);
    await b.close();
  });

  it('flushes at maxBatch at once, and never exceeds 100 docs per call', async () => {
    const ingest = fakeIngest();
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 10_000, maxBatch: 500 });
    for (let i = 0; i < 250; i += 1) b.add({ corpus: 'c' }, doc(`d${i}`));
    await sleep(20);
    // Two full batches went without waiting for the 10 s quiet period.
    expect(ingest.calls.map((c) => c.req.documents.length)).toEqual([100, 100]);
    await b.close();
    expect(ingest.calls.map((c) => c.req.documents.length)).toEqual([100, 100, 50]);
  });
});

describe('ordering', () => {
  it('a document re-written while its batch is in flight goes in the NEXT batch, after the first settles', async () => {
    const ingest = fakeIngest({ delayMs: 60 });
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 10 });
    b.add({ corpus: 'c' }, doc('a', 'v1'));
    await sleep(30); // v1 is in flight
    b.add({ corpus: 'c' }, doc('a', 'v2'));
    await sleep(30); // v2's quiet period has passed, v1 still in flight
    expect(ingest.calls).toHaveLength(1);
    await b.close();
    expect(ingest.calls.map((c) => c.req.documents[0]!.text)).toEqual(['v1', 'v2']);
  });
});

describe('no silent drops', () => {
  it('a failed batch reaches onError with every document and the error', async () => {
    const boom = new Error('budget exceeded');
    const ingest = fakeIngest({ fail: () => boom });
    const c = collect();
    const b = new IngestBatcher({ ingest, ...c, quietMs: 10 });
    b.add({ corpus: 'c' }, doc('a'));
    b.add({ corpus: 'c' }, doc('b'));
    await b.close();
    expect(c.landed).toHaveLength(0);
    expect(c.failures).toHaveLength(1);
    expect(c.failures[0]!.error).toBe(boom);
    expect(c.failures[0]!.documents.map((d) => d.id)).toEqual(['a', 'b']);
    expect(c.failures[0]!.request.corpus).toBe('c');
    expect(b.stats()).toEqual({ pending: 0, inFlight: 0 });
  });

  it('a landed batch reaches onBatch with its ingestId', async () => {
    const ingest = fakeIngest();
    const c = collect();
    const b = new IngestBatcher({ ingest, ...c, quietMs: 10 });
    b.add({ corpus: 'c' }, doc('a'));
    await b.close();
    expect(c.failures).toHaveLength(0);
    expect(c.landed.map((l) => [l.result.ingestId, l.documents.map((d) => d.id)])).toEqual([['ing-1', ['a']]]);
  });

  it('an onBatch that throws is reported through onError WITH the result, not swallowed', async () => {
    const ingest = fakeIngest();
    const failures: IngestBatchFailure[] = [];
    const b = new IngestBatcher({
      ingest,
      quietMs: 10,
      onError: (f) => failures.push(f),
      onBatch: () => {
        throw new Error('db down');
      },
    });
    b.add({ corpus: 'c' }, doc('a'));
    await b.close();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.result?.ingestId).toBe('ing-1');
  });

  it('close() sends what is pending immediately and refuses later adds', async () => {
    const ingest = fakeIngest();
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 60_000, maxWaitMs: 60_000 });
    b.add({ corpus: 'c' }, doc('a'));
    const t0 = Date.now();
    await b.close();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ingest.calls).toHaveLength(1);
    expect(() => b.add({ corpus: 'c' }, doc('b'))).toThrow(/closed/);
  });

  it('refuses a document with no id, loudly', () => {
    const b = new IngestBatcher({ ingest: fakeIngest(), ...collect() });
    expect(() => b.add({ corpus: 'c' }, { text: 'x' })).toThrow(TypeError);
    expect(b.stats().pending).toBe(0);
  });
});

describe('bounded buffer', () => {
  it('throws IngestBatcherFullError past maxBuffered, counting in-flight docs; a re-write still fits', async () => {
    const ingest = fakeIngest({ delayMs: 80 });
    const b = new IngestBatcher({ ingest, ...collect(), quietMs: 10, maxBuffered: 3 });
    b.add({ corpus: 'c' }, doc('a'));
    b.add({ corpus: 'c' }, doc('b'));
    await sleep(30); // a, b in flight
    b.add({ corpus: 'c' }, doc('c'));
    b.add({ corpus: 'c' }, doc('c', 'v2')); // replacing a pending doc is free
    let thrown: unknown;
    try {
      b.add({ corpus: 'c' }, doc('d'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IngestBatcherFullError);
    expect((thrown as IngestBatcherFullError).documentId).toBe('d');
    expect(b.stats()).toEqual({ pending: 1, inFlight: 2 });
    await b.close();
    expect(b.stats()).toEqual({ pending: 0, inFlight: 0 });
  });
});

describe('through the real gate', () => {
  it('360 single-row bulk writes become 4 gated calls, and an upload still gets in', async () => {
    // A saturating gate: 3 per 200 ms window, 1 reserved for interactive.
    const gate = new IngestGate({
      maxConcurrent: 4,
      maxPerWindow: 3,
      windowMs: 200,
      interactiveReserveShare: 0.34,
      queueDeadlineMs: { interactive: 100, bulk: 5_000 },
    });
    _setIngestGateForTests(gate);
    let n = 0;
    const posted: IngestRequest[] = [];
    const http = {
      json: async ({ body }: { body: IngestRequest }) => {
        posted.push(body);
        n += 1;
        return { ingestId: `ing-${n}`, corpusId: 'cid', totalDocs: body.documents.length };
      },
    };
    const api = new IngestAPI(http as never);
    const c = collect();
    const b = new IngestBatcher({ ingest: api, ...c, quietMs: 20 });
    for (let i = 0; i < 360; i += 1) b.add({ corpus: 'brainstorm' }, doc(`row-${i}`));
    await sleep(5);
    const t0 = Date.now();
    await api.enqueue({ corpus: 'uploads', documents: [doc('u1')] }); // interactive (default lane)
    expect(Date.now() - t0).toBeLessThan(100);
    await b.close();
    const bulk = posted.filter((p) => p.corpus === 'brainstorm');
    expect(bulk.map((p) => p.documents.length)).toEqual([100, 100, 100, 60]);
    expect(c.failures).toHaveLength(0);
    expect(c.landed.flatMap((l) => l.documents)).toHaveLength(360);
  });
});

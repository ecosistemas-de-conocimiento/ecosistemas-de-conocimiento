// A local HTTP server that speaks the rerank wire shape, for exercising the
// REAL rerank client offline.
//
// WHY A SERVER AND NOT A FUNCTION STUB
// ------------------------------------
// `fixtureReranker` is injected as a `Reranker` function, which is the right
// stub for measuring the rerank RUNG — but it replaces the client entirely, so
// everything between "the service wants a rerank" and "a relevance score comes
// back" is untested: the request envelope (`{ model, query, documents, top_n }`),
// the response envelope and its field aliases (`relevance_score` /
// `relevanceScore` / `score`), the abort signal, the non-OK and non-JSON paths.
// That is precisely the code a real `rerank-service` run depends on, and a
// gate that skips when the sibling is absent verifies none of it.
//
// So this binds `node:http` on an ephemeral port and answers like the sibling.
// The eval drives `callRerank` against it — real `fetch`, real JSON, real
// parsing — and `EVAL_REAL_RERANKER=1` with a reachable `RERANK_URL` then
// points the same code at the real service with no test-code change.
//
// It also RECORDS every request body, so the eval can assert what actually went
// over the wire rather than trusting that it did.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { fixtureRerankScore } from './fixture-reranker.js';

/** The request envelope `rerank-client.ts` sends. */
export interface CapturedRerankRequest {
  model?: string;
  query?: string;
  documents?: string[];
  top_n?: number;
}

/**
 * How the stub scores.
 *   - `overlap`  — `fixtureRerankScore`, i.e. a plausible reranker. Used for
 *     the quality A/B.
 *   - `reverse`  — score = position in `documents`, so the LAST candidate the
 *     service sent scores highest. A forced, exactly-predictable inversion:
 *     it proves the returned order comes from the server's scores rather than
 *     from the fused order that happened to be there already.
 *   - `error`    — a 503 with the documented error envelope, for exercising the
 *     rerank rung's fail-safe against a real HTTP failure rather than a thrown
 *     stub function.
 *   - `slow`     — accepts the request and NEVER answers. The client's own
 *     `RERANK_TIMEOUT_MS` abort is the only thing that ends the call, which is
 *     what makes a timeout test FORCED rather than raced: there is no response
 *     to win the race with. `close()` destroys the held sockets.
 *   - `partial`  — scores only the first two documents, so the caller must
 *     backfill the rest of `topK` from the fused order. A reranker is allowed to
 *     return fewer results than it was sent, and that partial case is otherwise
 *     unreachable from a stub that always answers in full.
 */
export type StubRerankMode = 'overlap' | 'reverse' | 'error' | 'slow' | 'partial';

export interface StubRerankServer {
  url: string;
  /** Every request body received, in order. */
  requests: CapturedRerankRequest[];
  /** Switch scoring behaviour between phases of a test. */
  setMode: (mode: StubRerankMode) => void;
  close: () => Promise<void>;
}

/**
 * Start the stub. Binds `127.0.0.1` on an ephemeral port — never a fixed one,
 * so a busy machine cannot turn a passing suite into a mysterious ECONNREFUSED
 * or, worse, route the test at whatever else is listening.
 */
export async function startStubRerankServer(
  initialMode: StubRerankMode = 'overlap',
): Promise<StubRerankServer> {
  const requests: CapturedRerankRequest[] = [];
  let mode: StubRerankMode = initialMode;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: CapturedRerankRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedRerankRequest;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }
      requests.push(body);

      if (mode === 'error') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'reranker unavailable', code: 'down' } }));
        return;
      }

      // Hold the socket open and never write. Nothing here races the client: the
      // only way out is the caller's abort.
      if (mode === 'slow') return;

      const documents = body.documents ?? [];
      // Score EVERY document and ignore `top_n`. The contract explicitly allows
      // a backend to return fewer results in any order, and the caller maps by
      // `index` — so answering in full, unsorted, exercises the caller's own
      // re-sort rather than leaning on the server to have done it.
      const scoreable = mode === 'partial' ? documents.slice(0, 2) : documents;
      const results = scoreable.map((doc, index) => ({
        index,
        relevance_score:
          mode === 'reverse' ? index : fixtureRerankScore(body.query ?? '', doc),
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: body.model ?? 'stub-reranker', results }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/rerank`,
    requests,
    setMode: (next) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `slow` mode leaves requests in flight, and `server.close()` waits for
        // every open connection — without this a timeout test would hang the
        // suite in teardown rather than fail.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

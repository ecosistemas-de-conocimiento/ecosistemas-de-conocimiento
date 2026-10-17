// 🔴 End-to-end proof that the rerank CREDENTIAL is real: a server that
// actually checks the bearer token, the REAL `callRerank` client, the REAL
// `RetrieveService` fail-safe, and `legs` as the verdict.
//
// WHY NOT A HAPPY-PATH TEST
// -------------------------
// Rerank failure is invisible. `applyRerank` catches everything and returns the
// fused order, so an UNAUTHENTICATED reranker produces a 200 that is
// byte-identical to `rerank: false` minus `rerankScore`. A test that sends a
// valid key and asserts "it worked" would pass just as happily against a client
// that sends no Authorization header at all, because the assertion never
// depends on the header existing.
//
// So every case here is a DIFFERENCE: the same request, the same server, the
// same service, with only the credential changed — and `legs` containing
// `rerank` is what changes. That is the one field that distinguishes a working
// reranker from a dead one, and it is what a deploy canary would watch.
//
// WHY A REAL SERVER rather than a `fetch` mock: a mock cannot reject a request.
// The 401 here is produced by a server reading the header the client really
// sent, so "the header went out" is proved by the server's behaviour rather
// than by the test inspecting the client's own arguments.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { env } from '../../config/env.js';
import { RetrieveService, type Embedder } from './retrieve.js';
import { WhereRecorder } from '../../test/where-recorder.js';

const ORG = 'org-1';
const PROJECT = 'proj-1';
const TOKEN = 'rerank-token-under-test';

const SEED_CORPUS = {
  id: '00000000-0000-4000-8000-000000000001',
  org: ORG,
  project: PROJECT,
  name: 'docs',
  embeddingModel: 'test/embed',
  embeddingDim: 1024,
  chunkStrategy: 'recursive-char',
  chunkSize: 800,
  chunkOverlap: 100,
  textSearchConfig: 'spanish',
};

const wheres = new WhereRecorder();

function tableName(table: unknown): string {
  const name = (table as Record<symbol, unknown> | null)?.[Symbol.for('drizzle:Name')];
  return typeof name === 'string' ? name : 'unknown';
}

/** Stub db: fixed corpus row, scripted `execute` results. */
function makeDb(results: Array<Record<string, unknown>[]>) {
  let i = 0;
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const guard = wheres.guard(tableName(table));
        const rows = () => Promise.resolve(guard.settle([SEED_CORPUS]));
        return {
          where: (predicate: unknown) => {
            guard.where(predicate);
            return { limit: () => Promise.resolve(guard.settle([SEED_CORPUS])) };
          },
          limit: rows,
          then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
            rows().then(resolve, reject),
        };
      },
    }),
    execute: vi.fn(async () => results[i++] ?? []),
  };
  return db as unknown as import('../../db/client.js').Db;
}

const embedder: Embedder = (async ({ model }: { model: string }) => ({
  embeddings: [[0.1, 0.2, 0.3]],
  model,
  usage: { inputTokens: 1, estimatedCostUsd: 0 },
})) as unknown as Embedder;

function row(id: string) {
  return {
    id,
    document_id: `doc-${id}`,
    ordinal: 0,
    text: `text ${id}`,
    metadata: null,
    score: 0.5,
  };
}

const ctx = { org: ORG, project: PROJECT };

/**
 * A reranker that DEMANDS `Authorization: Bearer <TOKEN>` and 401s otherwise —
 * the behaviour of every hosted rerank API, and the behaviour our own client
 * could not satisfy at all before this change.
 *
 * Records each request's Authorization header so a test can also state what
 * went over the wire, not only what the server decided about it.
 */
interface AuthRerankServer {
  url: string;
  seenAuth: Array<string | undefined>;
  /** Every request body received, so a test can assert what went over the wire. */
  seenBodies: Array<Record<string, unknown>>;
  /**
   * `cohere` answers the shape our default adapter parses. `deepinfra` answers
   * the OTHER shape while still returning 200 — the wire mismatch, which is the
   * failure a credential slot alone does not cover.
   */
  setWire: (wire: 'cohere' | 'deepinfra') => void;
  close: () => Promise<void>;
}

async function startAuthRerankServer(): Promise<AuthRerankServer> {
  const seenAuth: Array<string | undefined> = [];
  const seenBodies: Array<Record<string, unknown>> = [];
  let wire: 'cohere' | 'deepinfra' = 'cohere';

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenAuth.push(req.headers.authorization);

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api token', code: 'unauthorized' } }));
      return;
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { documents?: string[] };
      seenBodies.push(parsed as Record<string, unknown>);
      const documents = parsed.documents ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (wire === 'deepinfra') {
        // A perfectly healthy reranker speaking the OTHER wire. 200, valid
        // JSON, no error envelope — and our `cohere` adapter understands none
        // of it. This is what a wrong RERANK_PROVIDER looks like on the wire.
        res.end(
          JSON.stringify({
            scores: documents.map((_d, i) => i / 10),
            input_tokens: 42,
            inference_status: { status: 'succeeded', cost: 0.0000071 },
          }),
        );
        return;
      }

      // Score in REVERSE, so a successful rerank is distinguishable from the
      // fused order by more than a flag: the last candidate must come first.
      const results = documents.map((_d, index) => ({
        index,
        relevance_score: index / Math.max(documents.length, 1),
      }));
      res.end(JSON.stringify({ model: 'stub/reranker', results }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/rerank`,
    seenAuth,
    seenBodies,
    setWire: (w) => {
      wire = w;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * `env` is a module-load singleton, so the rerank knobs are set by mutation —
 * the same approach `rerank-degraded.integration.test.ts` uses. Restored in
 * `afterEach` so no case leaks a credential into the next.
 */
type MutableRerankEnv = {
  RERANK_ENABLED: boolean;
  RERANK_URL: string | undefined;
  RERANK_API_KEY: string | undefined;
  RERANK_PROVIDER: 'rerank-api' | 'deepinfra';
  RERANK_MODEL: string;
};

let server: AuthRerankServer;
let saved: MutableRerankEnv;

function rerankEnv(): MutableRerankEnv {
  return env as unknown as MutableRerankEnv;
}

beforeAll(async () => {
  server = await startAuthRerankServer();
  const e = rerankEnv();
  saved = {
    RERANK_ENABLED: e.RERANK_ENABLED,
    RERANK_URL: e.RERANK_URL,
    RERANK_API_KEY: e.RERANK_API_KEY,
    RERANK_PROVIDER: e.RERANK_PROVIDER,
    RERANK_MODEL: e.RERANK_MODEL,
  };
});

afterAll(async () => {
  Object.assign(rerankEnv(), saved);
  await server.close();
});

afterEach(() => {
  Object.assign(rerankEnv(), saved);
  server.setWire('cohere');
  wheres.reset();
});

/**
 * Run one `rerank: true` retrieve through the PRODUCTION path — no injected
 * reranker, so `RERANK_ENABLED` + `RERANK_URL` are the real gate and the real
 * `callRerank` makes the real HTTP call.
 */
async function retrieveWithRerank(): Promise<{ legs: readonly string[]; rerankScores: Array<number | undefined> }> {
  const db = makeDb([[row('a'), row('b')]]);
  const svc = new RetrieveService({ db, embedder, logger: { warn: vi.fn() } });
  const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true, topK: 2 }, ctx);
  return { legs: out.legs ?? [], rerankScores: out.chunks.map((c) => c.rerankScore) };
}

describe('🔴 rerank credential — proved by `legs`, against a server that checks it', () => {
  it('WITH the key: `legs` contains `rerank` and the chunks carry scores', async () => {
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: TOKEN,
    });

    const before = server.seenAuth.length;
    const { legs, rerankScores } = await retrieveWithRerank();

    expect(legs).toContain('rerank');
    expect(rerankScores.every((s) => s !== undefined)).toBe(true);
    // The server saw a real credential — this is the assertion a `fetch` mock
    // could not make, because a mock has no opinion about the header.
    expect(server.seenAuth[before]).toBe(`Bearer ${TOKEN}`);
  });

  it('🔴 WITHOUT the key: the same request 401s, fails safe, and `legs` OMITS `rerank`', async () => {
    // The pre-change behaviour of this client for EVERY hosted provider. The
    // response below is what a consumer would have received forever, with no
    // field to tell them reranking never happened.
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api', // not key-required, so the call goes out BARE
      RERANK_API_KEY: undefined,
    });

    const before = server.seenAuth.length;
    const { legs, rerankScores } = await retrieveWithRerank();

    expect(legs).not.toContain('rerank');
    expect(legs).toEqual(['dense']);
    // Fail-safe held: the rows still came back, just un-reranked.
    expect(rerankScores).toEqual([undefined, undefined]);
    // The server confirms the header was absent, not merely wrong.
    expect(server.seenAuth[before]).toBeUndefined();
  });

  it('🔴 with a WRONG key: also 401s and omits `rerank` — a stale token is not silently fine', async () => {
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: 'rotated-away-last-month',
    });

    const before = server.seenAuth.length;
    const { legs } = await retrieveWithRerank();

    expect(legs).not.toContain('rerank');
    expect(server.seenAuth[before]).toBe('Bearer rotated-away-last-month');
  });

  it('🔴 a key-REQUIRING provider with no key never reaches the network at all', async () => {
    // `deepinfra` refuses in the client, before `fetch`. The outcome a consumer
    // sees is the same fail-safe, but the server is never touched — so a
    // misconfigured deploy cannot be mistaken for a flaky vendor.
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'deepinfra',
      // The only model in DEEPINFRA_RERANK_MODELS; anything else is refused
      // before the wire, which would turn these cases into allowlist tests.
      RERANK_MODEL: 'Qwen/Qwen3-Reranker-0.6B',
      RERANK_API_KEY: undefined,
    });

    const before = server.seenAuth.length;
    const { legs } = await retrieveWithRerank();

    expect(legs).not.toContain('rerank');
    expect(server.seenAuth).toHaveLength(before);
  });
});

describe('🔴 a SILENTLY-EMPTY rerank is detectable — the wire mismatch, end to end', () => {
  // The credential gates cover a reranker that REFUSES us. This covers one that
  // answers us happily in a language we do not speak: 200, valid JSON, no error
  // envelope, correct credential, healthy vendor. Before the guard, the client
  // returned `{results: []}`, `applyRerank` backfilled all of topK from the
  // fused order, and the response was byte-identical to `rerank: false`.
  //
  // Note the server AUTHENTICATES SUCCESSFULLY in every case here. That is the
  // point: this failure survives a correct credential, so a test that only
  // proved the key works would still have shipped it.

  it('🔴 a 200 in the WRONG wire shape omits `rerank` from `legs`', async () => {
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: TOKEN,
    });
    server.setWire('deepinfra');

    const before = server.seenAuth.length;
    const { legs, rerankScores } = await retrieveWithRerank();

    // The credential was accepted — this is not an auth failure in disguise.
    expect(server.seenAuth[before]).toBe(`Bearer ${TOKEN}`);
    // ...and the rerank still did not happen, and `legs` says so.
    expect(legs).not.toContain('rerank');
    expect(legs).toEqual(['dense']);
    expect(rerankScores).toEqual([undefined, undefined]);
  });

  it('the SAME request on the RIGHT wire shape does name `rerank` — the difference is the only claim', async () => {
    // The control. Identical env, identical server, identical credential; only
    // the wire shape changes. Without this pair, the assertion above could be
    // passing for any reason at all.
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: TOKEN,
    });
    server.setWire('cohere');

    const { legs, rerankScores } = await retrieveWithRerank();

    expect(legs).toContain('rerank');
    expect(rerankScores.every((s) => s !== undefined)).toBe(true);
  });

  it('the fail-safe still holds — a mismatched reranker never costs the caller their rows', async () => {
    // Loud about the defect, silent about the user: the query must not 500 and
    // must not return fewer chunks than the un-reranked path would have.
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: TOKEN,
    });
    server.setWire('deepinfra');

    const db = makeDb([[row('a'), row('b')]]);
    const warn = vi.fn();
    const svc = new RetrieveService({ db, embedder, logger: { warn } });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true, topK: 2 }, ctx);

    expect(out.chunks).toHaveLength(2);
    // And it was NAMED, not merely survived — a warning fired for the rung.
    expect(warn).toHaveBeenCalled();
  });
});

describe('🔴 the DEEPINFRA path, exercised end to end — not a branch that never runs', () => {
  // Rodrigo chose DeepInfra as the TARGET on measured price; `cohere` is the
  // portable default, not the intended destination. So the DeepInfra adapter
  // has to be proved through the SAME full stack as the default one — real
  // HTTP, real credential check, real RetrieveService, `legs` as the verdict —
  // or the path that ships is the one that was never exercised.

  it('names `rerank` in `legs` over the DeepInfra wire, with the credential accepted', async () => {
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'deepinfra',
      // The only model in DEEPINFRA_RERANK_MODELS; anything else is refused
      // before the wire, which would turn these cases into allowlist tests.
      RERANK_MODEL: 'Qwen/Qwen3-Reranker-0.6B',
      RERANK_API_KEY: TOKEN,
    });
    server.setWire('deepinfra');

    const before = server.seenAuth.length;
    const { legs, rerankScores } = await retrieveWithRerank();

    expect(server.seenAuth[before]).toBe(`Bearer ${TOKEN}`);
    expect(legs).toContain('rerank');
    expect(rerankScores.every((s) => s !== undefined)).toBe(true);
  });

  it('sends `queries` PARALLEL to `documents` on the real wire, and no Cohere fields', async () => {
    // The one shape detail a mock cannot check, because a mock only ever
    // asserts on its own arguments: what a server actually received.
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'deepinfra',
      // The only model in DEEPINFRA_RERANK_MODELS; anything else is refused
      // before the wire, which would turn these cases into allowlist tests.
      RERANK_MODEL: 'Qwen/Qwen3-Reranker-0.6B',
      RERANK_API_KEY: TOKEN,
    });
    server.setWire('deepinfra');

    const before = server.seenBodies.length;
    await retrieveWithRerank();

    const body = server.seenBodies[before]!;
    expect(Array.isArray(body['documents'])).toBe(true);
    expect(body['queries']).toEqual(
      new Array((body['documents'] as string[]).length).fill('q'),
    );
    expect('top_n' in body).toBe(false);
    expect('query' in body).toBe(false);
  });

  it('🔴 refuses before the network when the DeepInfra key is missing', async () => {
    // The whole reason `deepinfra` declares a credential requirement: a bare
    // call would 401 and vanish into the fail-safe.
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'deepinfra',
      // The only model in DEEPINFRA_RERANK_MODELS; anything else is refused
      // before the wire, which would turn these cases into allowlist tests.
      RERANK_MODEL: 'Qwen/Qwen3-Reranker-0.6B',
      RERANK_API_KEY: undefined,
    });
    server.setWire('deepinfra');

    const before = server.seenAuth.length;
    const { legs } = await retrieveWithRerank();

    expect(legs).not.toContain('rerank');
    expect(server.seenAuth).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// 🔴 Item 0 part 2 — the SUCCESS line proves the scrub, end to end.
//
// Real `RetrieveService`, real `callRerank`, a real server reading the real
// body. `piiMinimised: true` on the `rerank ok` line must mean the pool that
// crossed the wire was scrubbed — so this asserts the log line AND the wire
// together, and pins the line's no-text rule on a payload that carries PII.
// ---------------------------------------------------------------------------

describe('🔴 `rerank ok` — the success path is observable, and says the pool was scrubbed', () => {
  it('logs piiMinimised + counts on a real rerank, and neither the wire nor the line carries the CURP', async () => {
    const { PROBE_CURP } = await import('../ai/pii/fixtures.js');
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: TOKEN,
    });

    const piiRow = { ...row('a'), text: `Acta con CURP ${PROBE_CURP}.` };
    const db = makeDb([[piiRow, row('b')]]);
    const info = vi.fn();
    const svc = new RetrieveService({ db, embedder, logger: { warn: vi.fn(), info } });
    const before = server.seenBodies.length;

    const out = await svc.retrieve(
      { corpus: 'docs', query: `quien es ${PROBE_CURP}`, rerank: true, topK: 2 },
      ctx,
    );

    expect(out.legs).toContain('rerank');
    // The wire: scrubbed. Positive control first — the prose DID go out.
    const sent = JSON.stringify(server.seenBodies[before]);
    expect(sent).toContain('Acta con CURP');
    expect(sent).not.toContain(PROBE_CURP);

    // The line: one, at info, under the shared message, with the proof fields.
    const lines = info.mock.calls.filter((c) => c[1] === RERANK_OK_MESSAGE);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual({
      corpus: 'docs',
      org: ORG,
      project: PROJECT,
      model: env.RERANK_MODEL,
      provider: 'rerank-api',
      poolSize: 2,
      scored: 2,
      topK: 2,
      piiMinimised: true,
      // Query + one document each carried the CURP.
      piiRedactions: 2,
      piiCounts: { curp: 2 },
    });
    // Never any text — not the raw query, not a chunk, not even scrubbed prose.
    const line = JSON.stringify(lines[0]![0]);
    expect(line).not.toContain(PROBE_CURP);
    expect(line).not.toContain('quien es');
    expect(line).not.toContain('Acta con');
  });

  it('writes NO `rerank ok` line when the rerank failed (401 → fail-safe)', async () => {
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    Object.assign(rerankEnv(), {
      RERANK_ENABLED: true,
      RERANK_URL: server.url,
      RERANK_PROVIDER: 'rerank-api',
      RERANK_API_KEY: 'wrong-token',
    });
    const info = vi.fn();
    const svc = new RetrieveService({ db: makeDb([[row('a'), row('b')]]), embedder, logger: { warn: vi.fn(), info } });
    await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true, topK: 2 }, ctx);
    expect(info.mock.calls.filter((c) => c[1] === RERANK_OK_MESSAGE)).toHaveLength(0);
  });
});

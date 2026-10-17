import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/generate` end to end, faked ONLY at the network boundary.
 *
 * Every collaborator is the real module: the corpora / session / documents /
 * lenguas reads, the Domain Adapter, the engine's `prepareTurn` + `respond`,
 * query expansion, the GraphRAG provider and the ai-service client. The one
 * fake is `globalThis.fetch`, routed by URL to a fake backend and a fake
 * ai-service. So the assertions read what actually went over the wire.
 *
 * 🔴 Audit C-2: removing `retrievalFilter`, `retrievalPolicy` or
 * `graphProvider` from `engineTurnArgs` in `+server.ts` used to keep the whole
 * web suite green. Each of those three now turns one test below red.
 *
 * `$env/dynamic/private` resolves once, so it is mocked with a mutable object.
 */

const ENV: Record<string, string | undefined> = vi.hoisted(() => ({
  BACKEND_URL: 'http://backend.test',
  AI_SERVICE_URL: 'http://ai.test',
  AI_SERVICE_API_KEY: 'test-key',
}));
vi.mock('$env/dynamic/private', () => ({ env: ENV }));

import { POST } from './+server';
import { resetHybridCapabilityCache } from '$lib/server/engine/hybrid';
import { ANSWER_NOT_SAVED_CODE } from '$lib/aiMessages';

const SESSION = '5';
const ECO = '7';
const QUESTION = '¿qué dicen sobre la partería tradicional?';

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface World {
  organization: string | null;
  saveStatus: number;
  graphCalls: number;
  sessionDocs: Array<Record<string, unknown>>;
  /** What `GET /v1/capabilities` answers. */
  capabilities: Record<string, boolean>;
  /** What `/v1/retrieve/multi` answers, whatever it was asked. */
  multiChunks: Array<Record<string, unknown>>;
}

let calls: Call[];
let world: World;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const raw = typeof init?.body === 'string' ? init.body : undefined;
  const body = raw ? JSON.parse(raw) : undefined;
  calls.push({ url, method, headers: headersOf(init), body });

  if (url.host === 'backend.test') {
    const p = url.pathname;
    if (p === `/api/sessions/${SESSION}/corpora`) {
      return json({
        corpora: [`eco-${ECO}`, `eco-${ECO}-draft-1`],
        published: `eco-${ECO}`,
        draft: `eco-${ECO}-draft-1`,
        asOf: '2026-10-17T00:00:00.000Z',
      });
    }
    if (p === `/api/sessions/${SESSION}` && method === 'GET') {
      return json({ id: Number(SESSION), organization: world.organization });
    }
    if (p === `/api/sessions/${SESSION}` && method === 'PATCH') return json({});
    if (p === '/api/documents') {
      return json({ docs: world.sessionDocs });
    }
    if (p === '/api/lenguas') return json({ lenguas: [{ lengua: 'mixe', documentos: 1 }] });
    if (p.startsWith('/api/organizations')) {
      return p === '/api/organizations'
        ? json({ docs: [{ id: Number(ECO), name: 'Eco de prueba' }] })
        : json({ id: Number(ECO), name: 'Eco de prueba' });
    }
    if (p === '/api/graph/retrieve') {
      world.graphCalls += 1;
      return json({
        entities: [{ id: 'e1', type: 'tema', label: 'partería', support: 3 }],
        edges: [],
        documents: [],
        terms: ['parteras', 'comadronas'],
      });
    }
    if (p === '/api/messages' && method === 'POST') {
      return world.saveStatus < 300
        ? json({ doc: { id: 99 } }, world.saveStatus)
        : json({ errors: [{ message: 'db down' }] }, world.saveStatus);
    }
    return json({ docs: [] });
  }

  if (url.host === 'ai.test') {
    if (url.pathname === '/v1/capabilities') return json({ capabilities: world.capabilities });
    if (url.pathname === '/v1/retrieve/multi') {
      const corpora = (body as { corpora: string[] }).corpora;
      return json({
        chunks: world.multiChunks,
        corpora: corpora.map((corpus) => ({ corpus, matched: 1 })),
      });
    }
    if (url.pathname === '/v1/retrieve') {
      return json({
        chunks: [
          {
            documentId: 'uuid-11',
            chunkId: `c-${(body as { corpus: string }).corpus}`,
            score: 0.9,
            denseScore: 0.7,
            rerankScore: 0.9,
            text: 'Las parteras acompañan los nacimientos en la comunidad.',
            metadata: { docId: '11', title: 'informe.pdf' },
          },
        ],
      });
    }
    if (url.pathname === '/v1/generate/sync') {
      const isExpansion = (raw ?? '').includes('Escribe exactamente tres');
      return json(
        isExpansion
          ? {
              text: 'partería en comunidades\nparteras y nacimientos\nLas parteras atienden partos.',
              costUsd: 0.0002,
              modelUsed: 'quick-model',
              provider: 'fake',
              traceId: 'tx',
              systemPromptApplied: true,
            }
          : {
              text: 'Según el informe, las parteras acompañan los nacimientos [1].',
              costUsd: 0.003,
              modelUsed: 'chat-model',
              provider: 'fake',
              traceId: 't1',
              systemPromptApplied: true,
            },
      );
    }
    if (url.pathname === '/v1/generate/stream') {
      const done = {
        type: 'done',
        text: 'Respuesta en streaming.',
        costUsd: 0.004,
        modelUsed: 'chat-model',
        provider: 'fake',
        traceId: 't2',
        systemPromptApplied: true,
      };
      const sse =
        `data: ${JSON.stringify({ type: 'delta', text: 'Respuesta ' })}\n\n` +
        `data: ${JSON.stringify(done)}\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  }
  return new Response('not found', { status: 404 });
}

vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => fakeFetch(input, init));

function event(body: Record<string, unknown>, stream = false) {
  const request = new Request(`http://web.test/api/generate${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    locals: { user: { id: 1, email: 'ana@example.org' }, token: 'tok' },
    url: new URL(request.url),
  } as unknown as Parameters<typeof POST>[0];
}

const turn = (extra: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  messages: [{ role: 'user', content: QUESTION }],
  ...extra,
});

const retrieves = () =>
  calls.filter((c) => c.url.host === 'ai.test' && c.url.pathname === '/v1/retrieve');
const generates = () =>
  calls.filter((c) => c.url.host === 'ai.test' && c.url.pathname.startsWith('/v1/generate'));
const saves = () =>
  calls.filter((c) => c.url.pathname === '/api/messages' && c.method === 'POST');

async function readSse(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

beforeEach(() => {
  calls = [];
  world = {
    organization: ECO,
    saveStatus: 201,
    graphCalls: 0,
    sessionDocs: [
      { id: 11, name: 'informe.pdf', kind: 'pdf', contentKind: 'documento', publicationStatus: 'draft' },
    ],
    capabilities: { orgDelegation: true, metadataFilterIn: true },
    multiChunks: [],
  };
  ENV.QUERY_EXPANSION = undefined;
  ENV.CHAT_RERANK = undefined;
  ENV.CHAT_RETRIEVAL_MODE = undefined;
  resetHybridCapabilityCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/generate — sync', () => {
  it('🔴 sends `rerank: true` on the corpus retrieves (retrievalPolicy)', async () => {
    const res = await POST(event(turn()));
    expect(res.status).toBe(200);
    const original = retrieves().filter((c) => (c.body as { query: string }).query === QUESTION);
    expect(original.length).toBeGreaterThan(0);
    expect(original.every((c) => (c.body as { rerank?: boolean }).rerank === true)).toBe(true);
    // Every retrieve is scoped by `asOf` and goes to the ecosistema's org.
    for (const c of retrieves()) {
      expect((c.body as { asOf?: string }).asOf).toBe('2026-10-17T00:00:00.000Z');
      expect(c.headers['x-ai-org']).toBe(`eco-${ECO}`);
    }
  });

  it('🔴 calls the graph provider with the turn\'s query (graphProvider)', async () => {
    await POST(event(turn()));
    expect(world.graphCalls).toBe(1);
    const graph = calls.find((c) => c.url.pathname === '/api/graph/retrieve')!;
    expect(graph.body).toMatchObject({ organization: ECO, query: QUESTION });
    // Its widened retrieve carries the graph's terms, on the published corpus only.
    const widened = retrieves().find((c) =>
      String((c.body as { query: string }).query).includes('parteras'),
    );
    expect(widened?.body).toMatchObject({ corpus: `eco-${ECO}` });
  });

  it('🔴 forwards `lengua` as the retrieve `filter`, on every leg, and skips the graph', async () => {
    await POST(event(turn({ lengua: 'mixe' })));
    expect(retrieves().length).toBeGreaterThan(0);
    for (const c of retrieves()) {
      expect((c.body as { filter?: unknown }).filter).toEqual({ lengua: 'mixe' });
    }
    expect(world.graphCalls).toBe(0);
  });

  it('saves the assistant message with its provenance and returns its id', async () => {
    const res = await POST(event(turn()));
    const body = (await res.json()) as Record<string, unknown>;
    expect(saves()).toHaveLength(1);
    const saved = saves()[0]!.body as Record<string, unknown>;
    expect(saved).toMatchObject({
      session: Number(SESSION),
      role: 'assistant',
      content: 'Según el informe, las parteras acompañan los nacimientos [1].',
    });
    expect((saved.provenance as { chunks: unknown[] }).chunks.length).toBeGreaterThan(0);
    expect(body.messageId).toBe('99');
    expect(body.warnings).toBeUndefined();
  });

  it('C-6: records the expansion call\'s cost next to the answer\'s', async () => {
    await POST(event(turn()));
    const meta = (saves()[0]!.body as { generationMeta: Record<string, unknown> }).generationMeta;
    expect(meta.costUsd).toBe(0.003);
    expect(meta.expansionCostUsd).toBe(0.0002);
  });

  it('C-6: no expansion cost is recorded when expansion is off', async () => {
    ENV.QUERY_EXPANSION = 'off';
    await POST(event(turn()));
    const meta = (saves()[0]!.body as { generationMeta: Record<string, unknown> }).generationMeta;
    expect(meta).not.toHaveProperty('expansionCostUsd');
    expect(generates()).toHaveLength(1);
  });

  it('without an ecosistema: no X-AI-Org, no graph, and it says so', async () => {
    world.organization = null;
    const res = await POST(event(turn()));
    expect(res.status).toBe(200);
    expect(world.graphCalls).toBe(0);
    for (const c of generates()) expect(c.headers['x-ai-org']).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no ecosistema for session 5'));
  });

  it('🔴 C-14: a failed save is logged, and the turn carries `messageId: null` + a warning', async () => {
    world.saveStatus = 500;
    const res = await POST(event(turn()));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.messageId).toBeNull();
    expect(body.warnings).toEqual([expect.objectContaining({ code: ANSWER_NOT_SAVED_CODE })]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('could not save the answer for session 5 (backend 500)'),
    );
  });
});

describe('POST /api/generate — gated attachments (privacy)', () => {
  // A testimony's `name` is free text the uploader typed and it never went
  // through the anonymisation gate. The backend still returns it to the
  // UPLOADER (and a platform admin), so a read with the user's own access is
  // not enough: the prompt leaves for a hosted model, and the summary line
  // naming the attached documents must use the neutral title.
  const RAW_NAME = 'Entrevista con Juana Pérez de San Mateo.m4a';
  const promptOf = () =>
    JSON.stringify(
      generates().find((c) => !JSON.stringify(c.body).includes('Escribe exactamente tres'))!.body,
    );

  it('🔴 names an attached testimonio "Testimonio" in the prompt, never its filename', async () => {
    world.sessionDocs = [
      { id: 21, name: RAW_NAME, kind: 'audio', contentKind: 'testimonio', publicationStatus: 'draft' },
      { id: 11, name: 'informe.pdf', kind: 'pdf', contentKind: 'documento', publicationStatus: 'draft' },
    ];
    await POST(event(turn()));
    const prompt = promptOf();
    expect(prompt).not.toContain('Juana');
    expect(prompt).toContain('Testimonio');
    expect(prompt).toContain('informe.pdf');
  });

  it('🔴 a row whose contentKind is missing is treated as gated (fail closed)', async () => {
    world.sessionDocs = [{ id: 22, name: RAW_NAME, kind: 'audio', publicationStatus: 'draft' }];
    await POST(event(turn()));
    expect(promptOf()).not.toContain('Juana');
  });
});

describe('POST /api/generate — stream', () => {
  it('saves the streamed answer and stamps its id on the done frame', async () => {
    const res = await POST(event(turn(), true));
    const frames = await readSse(res);
    const done = frames.find((f) => f.type === 'done')!;
    expect(done.messageId).toBe('99');
    expect(saves()).toHaveLength(1);
    expect((saves()[0]!.body as { generationMeta: Record<string, unknown> }).generationMeta)
      .toMatchObject({ costUsd: 0.004, expansionCostUsd: 0.0002 });
  });

  it('🔴 C-14: a failed save emits `messageId: null` and the warning on the done frame', async () => {
    world.saveStatus = 503;
    const frames = await readSse(await POST(event(turn(), true)));
    const done = frames.find((f) => f.type === 'done')!;
    expect(done.messageId).toBeNull();
    expect(done.warnings).toEqual([expect.objectContaining({ code: ANSWER_NOT_SAVED_CODE })]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('could not save the answer for session 5 (backend 503)'),
    );
  });

  it('🔴 forwards `lengua` on the streaming path too', async () => {
    await readSse(await POST(event(turn({ lengua: 'mixe' }), true)));
    expect(retrieves().length).toBeGreaterThan(0);
    for (const c of retrieves()) {
      expect((c.body as { filter?: unknown }).filter).toEqual({ lengua: 'mixe' });
    }
  });
});

// ── CHAT_RETRIEVAL_MODE=hybrid (audit C-4) ────────────────────────────────────
describe('POST /api/generate — hybrid retrieval', () => {
  const DRAFT = `eco-${ECO}-draft-1`;
  const multis = () =>
    calls.filter((c) => c.url.host === 'ai.test' && c.url.pathname === '/v1/retrieve/multi');
  const capabilityProbes = () =>
    calls.filter((c) => c.url.host === 'ai.test' && c.url.pathname === '/v1/capabilities');
  const multiChunk = (corpus: string, docId: string, text: string) => ({
    corpus,
    documentId: `uuid-${docId}`,
    chunkId: `${corpus}/${docId}`,
    score: 0.03,
    denseScore: 0.6,
    text,
    metadata: { docId, title: `doc-${docId}` },
  });

  it('is off by default: no capability probe, no multi call', async () => {
    await POST(event(turn()));
    expect(capabilityProbes()).toHaveLength(0);
    expect(multis()).toHaveLength(0);
    expect(retrieves().length).toBeGreaterThan(0);
  });

  it('🔴 sends ONE hybrid multi call with the drafts limited to this conversation', async () => {
    ENV.CHAT_RETRIEVAL_MODE = 'hybrid';
    world.multiChunks = [multiChunk(`eco-${ECO}`, '500', 'Las parteras acompañan los partos.')];
    const res = await POST(event(turn()));
    expect(res.status).toBe(200);
    expect(multis()).toHaveLength(1);
    const multi = multis()[0]!;
    expect(multi.body).toMatchObject({
      corpora: [`eco-${ECO}`, DRAFT],
      mode: 'hybrid',
      rerank: true,
      asOf: '2026-10-17T00:00:00.000Z',
      corpusFilters: { [DRAFT]: { docId: { $in: ['11'] } } },
    });
    expect(multi.headers['x-ai-org']).toBe(`eco-${ECO}`);
    // The engine's per-corpus retrieves are gone; only the graph's widened
    // retrieve, on the published corpus, still uses /v1/retrieve.
    for (const c of retrieves()) expect(c.body).toMatchObject({ corpus: `eco-${ECO}` });
    const saved = saves()[0]!.body as { provenance: { chunks: unknown[] } };
    expect(saved.provenance.chunks.length).toBeGreaterThan(0);
  });

  it('🔴 a draft of another conversation never reaches the prompt or the provenance', async () => {
    ENV.CHAT_RETRIEVAL_MODE = 'hybrid';
    world.multiChunks = [
      multiChunk(DRAFT, '999', 'SECRETO DE OTRA CONVERSACION'),
      multiChunk(DRAFT, '11', 'Las parteras acompañan los partos.'),
    ];
    await POST(event(turn()));
    const answerCall = generates().find((c) => !JSON.stringify(c.body).includes('Escribe exactamente tres'));
    expect(JSON.stringify(answerCall!.body)).not.toContain('SECRETO DE OTRA CONVERSACION');
    expect(JSON.stringify(answerCall!.body)).toContain('Las parteras acompañan los partos.');
    expect(JSON.stringify(saves()[0]!.body)).not.toContain('SECRETO DE OTRA CONVERSACION');
  });

  it('🔴 keeps `lengua` on the shared corpus AND on the draft filter', async () => {
    ENV.CHAT_RETRIEVAL_MODE = 'hybrid';
    await POST(event(turn({ lengua: 'mixe' })));
    expect(multis()[0]!.body).toMatchObject({
      filter: { lengua: 'mixe' },
      corpusFilters: { [DRAFT]: { lengua: 'mixe', docId: { $in: ['11'] } } },
    });
  });

  it('🔴 without `metadataFilterIn` it falls back to the dense path, drafts post-filtered', async () => {
    ENV.CHAT_RETRIEVAL_MODE = 'hybrid';
    world.capabilities = { orgDelegation: true };
    await POST(event(turn()));
    expect(multis()).toHaveLength(0);
    expect(retrieves().some((c) => (c.body as { corpus: string }).corpus === DRAFT)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('metadataFilterIn'));
  });

  it('works on the streaming path too', async () => {
    ENV.CHAT_RETRIEVAL_MODE = 'hybrid';
    const res = await POST(event(turn(), true));
    await readSse(res);
    expect(multis()).toHaveLength(1);
  });
});

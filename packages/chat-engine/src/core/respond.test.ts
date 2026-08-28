import { describe, it, expect, vi } from 'vitest';
import { respond, prepareTurn } from './respond.js';
import { buildChatTurn } from './turn.js';
import { condenseQuery } from './condense.js';
import { retrieveContext } from './retrieve.js';
import { syncEntity, backfillScope } from './corpus-sync.js';
import { DEFAULT_ENGINE_CONFIG } from './config.js';
import type {
  AIClient,
  RetrieveRequest,
  RetrieveResult,
  SyncGenerationRequest,
  SyncGenerationResult,
} from './types.js';
import type { DomainAdapter, ResolvedScope } from './adapter.js';

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeAIClient(overrides: Partial<AIClient> = {}): AIClient {
  return {
    generateSync: async (_req: SyncGenerationRequest): Promise<SyncGenerationResult> => ({
      text: 'respuesta del asistente',
      modelUsed: 'mock',
      provider: 'mock',
      costUsd: 0,
      traceId: 't-1',
    }),
    retrieve: async (_req: RetrieveRequest): Promise<RetrieveResult> => ({ matches: [] }),
    ingest: async () => ({ ingested: 0, documentIds: [] }),
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<DomainAdapter> = {}): DomainAdapter {
  return {
    searchEntities: async () => [],
    resolveEntity: async () => '',
    scopeHierarchy: async (): Promise<ResolvedScope> => ({ summaryText: '', corpora: [] }),
    syncEntity: async () => {},
    backfill: async () => {},
    summary: async () => '',
    ...overrides,
  };
}

const baseArgs = () => ({
  config: DEFAULT_ENGINE_CONFIG,
  aiClient: fakeAIClient(),
  adapter: fakeAdapter(),
  orgId: 'edc.example.org',
  userId: 'u1',
  scopeId: 'chat',
  threadId: 42,
  scope: { refs: [{ kind: 'org' as const }] },
  history: [],
  userMessage: '¿qué proyectos hay?',
});

// ── turn assembly (the load-bearing invariant) ────────────────────────────────

describe('buildChatTurn — user-turn injection invariant', () => {
  it('puts ALL factual context in the USER turn, system stays behavioral', () => {
    const { messages } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [],
      summaryText: 'Proyecto Acceso ciudadano: portal de trámites.',
      retrievedMatches: [
        { documentId: 'd1', chunkId: 'c1', score: 0.9, text: 'El portal usa RFC.', corpus: 'k' },
      ],
      inlineRefsText: 'Persona: Ana Torres coordina Plataforma.',
      userMessage: '¿quién coordina?',
    });

    const system = messages.find((m) => m.role === 'system')!;
    const user = messages[messages.length - 1]!;

    expect(user.role).toBe('user');
    // Factual context is in the user turn…
    expect(user.content).toContain('Acceso ciudadano');
    expect(user.content).toContain('El portal usa RFC.');
    expect(user.content).toContain('Ana Torres');
    expect(user.content).toContain('¿quién coordina?');
    // …and NOT in the system message.
    expect(system.content).not.toContain('Acceso ciudadano');
    expect(system.content).not.toContain('Ana Torres');
    expect(system.content).not.toContain('El portal usa RFC.');
  });

  it('snapshot: user-turn structure is stable', () => {
    const { messages, provenance } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'qué tal' }],
      summaryText: 'RESUMEN',
      retrievedMatches: [
        { documentId: 'd1', chunkId: 'c1', score: 0.5, text: 'CHUNK-A', corpus: 'corpus-x' },
      ],
      inlineRefsText: 'REF-TEXT',
      userMessage: 'PREGUNTA',
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3]!.content).toMatchInlineSnapshot(`
      "[CONTEXTO disponible para responder — es tu FUENTE PRINCIPAL y está AQUÍ MISMO; NO digas que no tienes información ni pidas datos que ya aparecen abajo]

      Contexto del proyecto/organización:
      RESUMEN

      ---

      Contexto recuperado de la base de conocimiento:
      [1] CHUNK-A

      ---

      Entidades citadas por el usuario (@):
      REF-TEXT

      ========

      Mensaje del usuario:
      PREGUNTA"
    `);
    // ≥0.3.0: the grounding passage is persisted by default so the citation
    // card can quote it.
    expect(provenance).toEqual({
      chunks: [
        { chunkId: 'c1', documentId: 'd1', score: 0.5, corpus: 'corpus-x', metadata: null, text: 'CHUNK-A' },
      ],
    });
  });

  it('includePassageText:false keeps the legacy lean provenance shape', () => {
    const { provenance } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [],
      summaryText: '',
      retrievedMatches: [
        { documentId: 'd1', chunkId: 'c1', score: 0.5, text: 'CHUNK-A', corpus: 'corpus-x' },
      ],
      userMessage: 'q',
      includePassageText: false,
    });
    expect(provenance).toEqual({
      chunks: [{ chunkId: 'c1', documentId: 'd1', score: 0.5, corpus: 'corpus-x', metadata: null }],
    });
    expect(provenance?.chunks[0]).not.toHaveProperty('text');
  });

  it('includePassageText:<number> truncates the persisted passage', () => {
    const { provenance } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [],
      summaryText: '',
      retrievedMatches: [
        { documentId: 'd1', chunkId: 'c1', score: 0.5, text: 'ABCDEFGHIJ', corpus: 'corpus-x' },
      ],
      userMessage: 'q',
      includePassageText: 4,
    });
    expect(provenance?.chunks[0]?.text).toBe('ABCD');
  });

  it('with no context, the user turn is the raw message (no preamble)', () => {
    const { messages, provenance } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [],
      summaryText: '',
      retrievedMatches: [],
      userMessage: 'sólo la pregunta',
    });
    expect(messages[messages.length - 1]!.content).toBe('sólo la pregunta');
    expect(provenance).toBeNull();
  });
});

// ── condense fail-safe ────────────────────────────────────────────────────────

describe('condenseQuery — fail-safe', () => {
  it('returns the original question on the first turn (no history)', async () => {
    const ai = fakeAIClient({ generateSync: vi.fn() });
    const out = await condenseQuery(ai, {
      condenseSystemPrompt: 'x',
      surface: 'chat',
      orgId: 'o',
      userId: 'u',
      history: [],
      question: '¿y de esos?',
    });
    expect(out).toBe('¿y de esos?');
    expect(ai.generateSync).not.toHaveBeenCalled();
  });

  it('rewrites an anaphoric follow-up when history exists', async () => {
    const ai = fakeAIClient({
      generateSync: async () => ({
        text: '"riesgos de los proyectos de Plataforma"',
        modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 't',
      }),
    });
    const out = await condenseQuery(ai, {
      condenseSystemPrompt: 'x',
      surface: 'chat',
      orgId: 'o',
      userId: 'u',
      history: [{ role: 'user', content: '¿qué proyectos tiene Plataforma?' }],
      question: '¿y de esos qué riesgos hay?',
    });
    expect(out).toBe('riesgos de los proyectos de Plataforma');
  });

  it('falls back to the original question when generate throws', async () => {
    const ai = fakeAIClient({ generateSync: async () => { throw new Error('boom'); } });
    const out = await condenseQuery(ai, {
      condenseSystemPrompt: 'x', surface: 'chat', orgId: 'o', userId: 'u',
      history: [{ role: 'user', content: 'algo' }],
      question: 'pregunta original',
    });
    expect(out).toBe('pregunta original');
  });
});

// ── scoped retrieve via filter ────────────────────────────────────────────────

describe('retrieveContext — scoped retrieve via filter', () => {
  it('forwards the ai-service `filter` to every corpus retrieve', async () => {
    const calls: RetrieveRequest[] = [];
    const ai = fakeAIClient({
      retrieve: async (req) => { calls.push(req); return { matches: [] }; },
    });
    await retrieveContext({
      aiClient: ai,
      orgId: 'edc.example.org',
      fallbackScopeId: 'chat',
      corpora: [{ corpus: 'kb-1', scopeId: 's1' }],
      threadId: 7,
      query: 'tema',
      filter: { sessionId: '7', kind: 'project' },
    });
    // resolver corpus + per-thread corpus both queried, both carry the filter.
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.filter).toEqual({ sessionId: '7', kind: 'project' });
    }
    expect(calls.map((c) => c.corpus).sort()).toEqual(['chat:thread:7', 'kb-1']);
  });

  it('merges + sorts matches by score and caps at 8', async () => {
    const ai = fakeAIClient({
      retrieve: async (req) =>
        req.corpus === 'kb-1'
          ? { matches: [{ documentId: 'd', chunkId: 'hi', score: 0.9, text: 'a' }] }
          : { matches: [{ documentId: 'd', chunkId: 'lo', score: 0.1, text: 'b' }] },
    });
    const out = await retrieveContext({
      aiClient: ai, orgId: 'o', fallbackScopeId: 'chat',
      corpora: [{ corpus: 'kb-1' }], threadId: 1, query: 'q',
    });
    expect(out[0]!.chunkId).toBe('hi');
    expect(out[1]!.chunkId).toBe('lo');
    expect(out[0]!.corpus).toBe('kb-1');
  });

  it('swallows a per-corpus failure (best-effort)', async () => {
    const ai = fakeAIClient({
      retrieve: async (req) => {
        if (req.corpus === 'kb-1') throw new Error('down');
        return { matches: [{ documentId: 'd', chunkId: 'ok', score: 0.5, text: 'b' }] };
      },
    });
    const out = await retrieveContext({
      aiClient: ai, orgId: 'o', fallbackScopeId: 'chat',
      corpora: [{ corpus: 'kb-1' }], threadId: 1, query: 'q',
    });
    expect(out.map((m) => m.chunkId)).toEqual(['ok']);
  });
});

// ── respond() orchestrator ────────────────────────────────────────────────────

describe('respond() orchestrator', () => {
  it('chains condense → scope → retrieve → resolve → generate; injects context in the user turn', async () => {
    const generateCalls: SyncGenerationRequest[] = [];
    const ai = fakeAIClient({
      // condense (effort quick) returns a rewrite; main generate returns text.
      generateSync: async (req) => {
        generateCalls.push(req);
        if (req.effort === 'quick' && req.maxTokens === 80) {
          return { text: 'consulta condensada', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 'c' };
        }
        return { text: 'RESPUESTA FINAL', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 'g' };
      },
      retrieve: async () => ({
        matches: [{ documentId: 'd1', chunkId: 'k1', score: 0.8, text: 'El proyecto X usa RFC.' }],
      }),
    });
    const adapter = fakeAdapter({
      scopeHierarchy: async () => ({
        summaryText: 'Proyectos: Acceso ciudadano, Presupuesto participativo.',
        corpora: [{ corpus: 'kb-org', scopeId: 'chat' }],
      }),
      resolveEntity: async (ref) =>
        ref.kind === 'project' ? 'Proyecto Acceso ciudadano: portal de trámites municipales.' : '',
    });

    const res = await respond({
      ...baseArgs(),
      aiClient: ai,
      adapter,
      history: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hola' }],
      userMessage: '¿de qué trata ese proyecto?',
      inlineRefs: [{ kind: 'project', id: 1 }],
    });

    expect(res.generation.text).toBe('RESPUESTA FINAL');
    expect(res.retrievalQuery).toBe('consulta condensada');
    expect(res.summaryText).toContain('Acceso ciudadano');
    expect(res.provenance?.chunks[0]!.chunkId).toBe('k1');

    // The main generate's user turn carries summary + chunk + resolved ref.
    const main = generateCalls.find((c) => c.maxTokens !== 80)!;
    const userTurn = main.messages[main.messages.length - 1]!;
    expect(userTurn.role).toBe('user');
    expect(userTurn.content).toContain('Acceso ciudadano'); // summary + ref
    expect(userTurn.content).toContain('El proyecto X usa RFC.'); // retrieved chunk
    expect(userTurn.content).toContain('portal de trámites'); // resolved @-ref
    expect(userTurn.content).toContain('¿de qué trata ese proyecto?'); // the question
    // System message stays behavioral.
    expect(main.messages[0]!.role).toBe('system');
    expect(main.messages[0]!.content).not.toContain('Acceso ciudadano');
  });

  it('best-effort: a throwing scopeHierarchy does NOT break the turn', async () => {
    const adapter = fakeAdapter({
      scopeHierarchy: async () => { throw new Error('db down'); },
    });
    const res = await respond({ ...baseArgs(), adapter });
    expect(res.generation.text).toBe('respuesta del asistente');
    expect(res.summaryText).toBe('');
  });

  it('prepareTurn alone does not call generate (router seam)', async () => {
    const ai = fakeAIClient({ generateSync: vi.fn(async () => ({ text: '', modelUsed: '', provider: '', costUsd: 0, traceId: '' })) });
    const prepared = await prepareTurn({ ...baseArgs(), aiClient: ai });
    // condense is skipped (no history) so generate is never called.
    expect(ai.generateSync).not.toHaveBeenCalled();
    expect(prepared.messages.at(-1)!.role).toBe('user');
  });
});

// ── entity-corpus sync + backfill ─────────────────────────────────────────────

describe('corpus-sync', () => {
  it('syncEntity ingests the entity-source batches with stable ids', async () => {
    const ingested: Array<{ corpus: string; ids: string[] }> = [];
    const ai = fakeAIClient({
      ingest: async (req) => {
        ingested.push({ corpus: req.corpus, ids: req.documents.map((d) => d.id!) });
        return { ingested: req.documents.length, documentIds: req.documents.map((d) => d.id!) };
      },
    });
    const source = {
      docsForEntity: async (ref: { id?: string | number }) => [
        {
          orgId: 'o', scopeId: 's', corpus: 'entities',
          documents: [{ id: `team:${ref.id}`, title: 'Equipo', text: 'contenido', metadata: { kind: 'team' } }],
        },
      ],
      entitiesInScope: async () => [{ kind: 'team' as const, id: 1 }, { kind: 'team' as const, id: 2 }],
    };
    const r = await syncEntity(ai, source, { kind: 'team', id: 1 });
    expect(r.synced).toBe(1);
    expect(ingested[0]).toEqual({ corpus: 'entities', ids: ['team:1'] });
  });

  it('backfillScope re-syncs every entity in the scope', async () => {
    const ai = fakeAIClient({ ingest: async (req) => ({ ingested: req.documents.length, documentIds: [] }) });
    const source = {
      docsForEntity: async (ref: { id?: string | number }) => [
        { orgId: 'o', scopeId: 's', corpus: 'c', documents: [{ id: `t:${ref.id}`, title: 't', text: 'x', metadata: {} }] },
      ],
      entitiesInScope: async () => [{ kind: 'team' as const, id: 1 }, { kind: 'team' as const, id: 2 }, { kind: 'team' as const, id: 3 }],
    };
    const r = await backfillScope(ai, source, 's');
    expect(r.entities).toBe(3);
    expect(r.docs).toBe(3);
  });

  it('syncEntity swallows an ingest failure (never breaks the write path)', async () => {
    const ai = fakeAIClient({ ingest: async () => { throw new Error('ingest down'); } });
    const source = {
      docsForEntity: async () => [
        { orgId: 'o', scopeId: 's', corpus: 'c', documents: [{ id: 'x', title: 't', text: 'x', metadata: {} }] },
      ],
      entitiesInScope: async () => [],
    };
    const r = await syncEntity(ai, source, { kind: 'team', id: 1 });
    expect(r.synced).toBe(0);
  });
});

// ── fuseMatches — RRF over two ranked lists ───────────────────────────────────

import { fuseMatches, DEFAULT_MERGED_CAP } from './retrieve.js';
import type { RetrievedChunk } from './types.js';
import type { BuildTurnArgs } from './turn.js';
import type { GraphProvider } from './respond.js';

const chunk = (
  chunkId: string,
  score: number,
  extra: Partial<RetrievedChunk> = {},
): RetrievedChunk => ({
  documentId: `doc-${chunkId}`,
  chunkId,
  score,
  text: `text-${chunkId}`,
  corpus: 'kb',
  ...extra,
});

describe('fuseMatches — no graph leg is TODAY’s behaviour, exactly', () => {
  it('with an empty graph list, returns the plain descending-score sort + cap', () => {
    const vector = [
      chunk('c', 0.30), chunk('a', 0.90), chunk('j', 0.05), chunk('b', 0.55),
      chunk('e', 0.20), chunk('h', 0.10), chunk('d', 0.25), chunk('i', 0.07),
      chunk('f', 0.15), chunk('g', 0.12),
    ];
    // Literally the expression `retrieveContext` used before fusion existed.
    const today = [...vector].sort((a, b) => b.score - a.score).slice(0, 8);

    const fused = fuseMatches(vector, []);
    expect(fused).toEqual(today);
    expect(fused.map((m) => m.chunkId)).toEqual(today.map((m) => m.chunkId));
    expect(fused.length).toBe(DEFAULT_MERGED_CAP);
  });

  it('with an empty graph list, keeps ties in input order and does NOT dedupe', () => {
    // Both invariants of the plain sort: `Array#sort` is stable, and nothing
    // was ever deduped by chunkId on this path.
    const vector = [chunk('t1', 0.5), chunk('t2', 0.5), chunk('t1', 0.5), chunk('t3', 0.9)];
    const today = [...vector].sort((a, b) => b.score - a.score);
    const fused = fuseMatches(vector, []);
    expect(fused.map((m) => m.chunkId)).toEqual(today.map((m) => m.chunkId));
    expect(fused.map((m) => m.chunkId)).toEqual(['t3', 't1', 't2', 't1']);
  });

  it('does not mutate either input array', () => {
    const vector = [chunk('lo', 0.1), chunk('hi', 0.9)];
    const graph = [chunk('g', 0.4)];
    fuseMatches(vector, []);
    fuseMatches(vector, graph);
    expect(vector.map((m) => m.chunkId)).toEqual(['lo', 'hi']);
    expect(graph.map((m) => m.chunkId)).toEqual(['g']);
  });

  it('honours a mergedCap override on both paths', () => {
    const vector = [chunk('a', 0.9), chunk('b', 0.8), chunk('c', 0.7)];
    expect(fuseMatches(vector, [], { mergedCap: 2 }).map((m) => m.chunkId)).toEqual(['a', 'b']);
    expect(fuseMatches(vector, [chunk('d', 0.6)], { mergedCap: 2 }).length).toBe(2);
  });
});

describe('fuseMatches — RRF when the graph leg has entries', () => {
  it('a chunk ranked #2 in BOTH legs beats a chunk ranked #1 in one', () => {
    // rrf(shared) = 1/62 + 1/62 > rrf(a) = rrf(c) = 1/61.
    const vector = [chunk('a', 0.90), chunk('shared', 0.80)];
    const graph = [chunk('c', 0.90), chunk('shared', 0.70)];
    expect(fuseMatches(vector, graph).map((m) => m.chunkId)).toEqual(['shared', 'a', 'c']);
  });

  it('an unranked tie block does not outrank the other leg’s genuine #1', () => {
    // Modified competition ranking: the 2-way tie shares the LAST rank of its
    // group (2), so each member scores 1/62 < 1/61. Standard competition
    // ranking (both at 1) or ordinal ranking (1 then 2) would put `a` first.
    const vector = [chunk('a', 0.5), chunk('b', 0.5)];
    const graph = [chunk('c', 0.9)];
    expect(fuseMatches(vector, graph).map((m) => m.chunkId)).toEqual(['c', 'a', 'b']);
  });

  it('dedupes by chunkId, keeping the richer record', () => {
    const vector = [chunk('same', 0.9), chunk('v', 0.4)];
    const graph = [
      chunk('same', 0.3, { text: 'a much longer grounding passage', metadata: { path: 'graph' } }),
    ];
    const fused = fuseMatches(vector, graph);
    expect(fused.filter((m) => m.chunkId === 'same').length).toBe(1);
    const kept = fused.find((m) => m.chunkId === 'same')!;
    expect(kept.metadata).toEqual({ path: 'graph' });
    expect(kept.text).toBe('a much longer grounding passage');
  });

  it('orders by RRF but never rewrites a chunk’s own score', () => {
    // `score` is persisted into provenance and rendered as a relevance % — it
    // has to stay on the retriever's scale, not become ~0.03.
    const fused = fuseMatches([chunk('v', 0.87)], [chunk('g', 0.61)]);
    expect(fused.map((m) => m.score)).toEqual([0.87, 0.61]);
  });

  it('works with an empty vector leg (graph-only turn)', () => {
    const fused = fuseMatches([], [chunk('g2', 0.4), chunk('g1', 0.8)]);
    expect(fused.map((m) => m.chunkId)).toEqual(['g1', 'g2']);
  });
});

// ── the optional graph block in the assembled turn ────────────────────────────

describe('buildChatTurn — optional graph context block', () => {
  const build = (extra: Partial<BuildTurnArgs> = {}) =>
    buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'qué tal' }],
      summaryText: 'RESUMEN',
      retrievedMatches: [
        { documentId: 'd1', chunkId: 'c1', score: 0.5, text: 'CHUNK-A', corpus: 'corpus-x' },
      ],
      inlineRefsText: 'REF-TEXT',
      userMessage: 'PREGUNTA',
      ...extra,
    });

  it('absent/blank graphContext assembles a byte-identical turn', () => {
    const baseline = build();
    expect(build({ graphContext: undefined })).toEqual(baseline);
    expect(build({ graphContext: '' })).toEqual(baseline);
    expect(build({ graphContext: '   ' })).toEqual(baseline);
    expect(baseline.messages[3]!.content).not.toContain('grafo');
  });

  it('renders after the summary and BEFORE the retrieved block', () => {
    const c = build({ graphContext: 'GRAFO' }).messages[3]!.content;
    expect(c).toContain('Contexto del grafo de conocimiento:\nGRAFO');
    expect(c.indexOf('RESUMEN')).toBeLessThan(c.indexOf('GRAFO'));
    expect(c.indexOf('GRAFO')).toBeLessThan(c.indexOf('Contexto recuperado'));
  });

  it('leaves the [N] citation ordinals and the provenance untouched', () => {
    const baseline = build();
    const withGraph = build({ graphContext: 'GRAFO' });
    const c = withGraph.messages[3]!.content;
    expect(c).toContain('[1] CHUNK-A');
    // The graph block carries no ordinal of its own — the only [N] marker in
    // the turn is still the one retrieved chunk's.
    expect(c.match(/\[\d+\]/g)).toEqual(['[1]']);
    expect(withGraph.provenance).toEqual(baseline.provenance);
    expect(withGraph.messages.map((m) => m.role)).toEqual(baseline.messages.map((m) => m.role));
  });

  it('uses a consumer-supplied header, and falls back when the config omits one', () => {
    const custom = {
      ...DEFAULT_ENGINE_CONFIG,
      blockHeaders: { ...DEFAULT_ENGINE_CONFIG.blockHeaders, graph: 'GRAPH BLOCK:' },
    };
    expect(build({ config: custom, graphContext: 'X' }).messages[3]!.content).toContain(
      'GRAPH BLOCK:\nX',
    );

    // A pre-existing config literal with no `graph` header still labels the block.
    const legacy = {
      ...DEFAULT_ENGINE_CONFIG,
      blockHeaders: {
        summary: DEFAULT_ENGINE_CONFIG.blockHeaders.summary,
        retrieved: DEFAULT_ENGINE_CONFIG.blockHeaders.retrieved,
        inlineRefs: DEFAULT_ENGINE_CONFIG.blockHeaders.inlineRefs,
      },
    };
    expect(build({ config: legacy, graphContext: 'X' }).messages[3]!.content).toContain(
      'Contexto del grafo de conocimiento:\nX',
    );
  });
});

// ── prepareTurn — the optional graph retrieval path ───────────────────────────

describe('prepareTurn — graphProvider', () => {
  it('runs the provider CONCURRENTLY with the vector retrieve', async () => {
    // The retrieve blocks on a gate only the graph provider can open. If the
    // two ran sequentially this test would deadlock instead of failing.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const order: string[] = [];

    const ai = fakeAIClient({
      retrieve: async () => {
        order.push('retrieve:start');
        await gate;
        order.push('retrieve:end');
        return { matches: [{ documentId: 'd', chunkId: 'v1', score: 0.9, text: 'V' }] };
      },
    });

    const prepared = await prepareTurn({
      ...baseArgs(),
      aiClient: ai,
      graphProvider: async () => {
        order.push('graph:start');
        openGate();
        return { context: 'BLOQUE DEL GRAFO' };
      },
    });

    expect(order).toEqual(['retrieve:start', 'graph:start', 'retrieve:end']);
    expect(prepared.graphContext).toBe('BLOQUE DEL GRAFO');
    expect(prepared.messages.at(-1)!.content).toContain('BLOQUE DEL GRAFO');
  });

  it('calls the provider with the CONDENSED query', async () => {
    const seen: string[] = [];
    const ai = fakeAIClient({
      generateSync: async () => ({
        text: 'consulta condensada', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 'c',
      }),
    });
    await prepareTurn({
      ...baseArgs(),
      aiClient: ai,
      history: [{ role: 'user', content: '¿qué proyectos tiene Plataforma?' }],
      userMessage: '¿y de esos?',
      graphProvider: async (q) => { seen.push(q); return null; },
    });
    expect(seen).toEqual(['consulta condensada']);
  });

  it('fuses the provider’s chunks into the matches + provenance', async () => {
    const ai = fakeAIClient({
      retrieve: async () => ({
        matches: [{ documentId: 'd1', chunkId: 'v1', score: 0.9, text: 'VECTOR' }],
      }),
    });
    const prepared = await prepareTurn({
      ...baseArgs(),
      aiClient: ai,
      graphProvider: async () => ({
        chunks: [{ documentId: 'd2', chunkId: 'g1', score: 0.5, text: 'GRAFO', corpus: 'kb' }],
      }),
    });
    expect(prepared.matches.map((m) => m.chunkId)).toEqual(['v1', 'g1']);
    expect(prepared.provenance?.chunks.map((c) => c.chunkId)).toEqual(['v1', 'g1']);
    const userTurn = prepared.messages.at(-1)!.content;
    expect(userTurn).toContain('[1] VECTOR');
    expect(userTurn).toContain('[2] GRAFO');
  });

  it('silent fallback: a rejecting provider produces a normal turn', async () => {
    const ai = fakeAIClient({
      retrieve: async () => ({
        matches: [{ documentId: 'd1', chunkId: 'v1', score: 0.9, text: 'VECTOR' }],
      }),
    });
    const withoutGraph = await prepareTurn({ ...baseArgs(), aiClient: ai });
    const rejected = await prepareTurn({
      ...baseArgs(),
      aiClient: ai,
      graphProvider: async () => { throw new Error('graph down'); },
    });
    expect(rejected.messages).toEqual(withoutGraph.messages);
    expect(rejected.matches).toEqual(withoutGraph.matches);
    expect(rejected.graphContext).toBe('');
  });

  it('silent fallback: a synchronously throwing provider is caught too', async () => {
    const boom = (() => { throw new Error('sync boom'); }) as unknown as GraphProvider;
    const prepared = await prepareTurn({ ...baseArgs(), graphProvider: boom });
    expect(prepared.graphContext).toBe('');
    expect(prepared.messages.at(-1)!.role).toBe('user');
  });

  it('silent fallback: a provider that matches nothing changes nothing', async () => {
    const ai = fakeAIClient({
      retrieve: async () => ({
        matches: [{ documentId: 'd1', chunkId: 'v1', score: 0.9, text: 'VECTOR' }],
      }),
    });
    const withoutGraph = await prepareTurn({ ...baseArgs(), aiClient: ai });
    for (const empty of [null, {}, { chunks: [] }, { chunks: [], context: '  ' }]) {
      const prepared = await prepareTurn({
        ...baseArgs(),
        aiClient: ai,
        graphProvider: async () => empty,
      });
      expect(prepared.messages).toEqual(withoutGraph.messages);
      expect(prepared.matches).toEqual(withoutGraph.matches);
      expect(prepared.graphContext).toBe('');
    }
  });

  it('no graphProvider at all: the assembled turn is unchanged', async () => {
    const ai = fakeAIClient({
      retrieve: async () => ({
        matches: [{ documentId: 'd1', chunkId: 'v1', score: 0.9, text: 'VECTOR' }],
      }),
    });
    const prepared = await prepareTurn({ ...baseArgs(), aiClient: ai });
    expect(prepared.graphContext).toBe('');
    expect(prepared.messages.at(-1)!.content).not.toContain('grafo');
  });
});

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

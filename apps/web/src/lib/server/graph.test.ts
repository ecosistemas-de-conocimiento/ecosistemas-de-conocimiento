import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrieveRequest, RetrieveResult } from '@edc/chat-engine/core';

/**
 * 🔴 THE INVARIANT TEST. This suite exists for the three ways the GraphRAG leg
 * breaks SILENTLY — every one of which produces a working chat turn with no
 * error anywhere, and would be debugged as "the graph is bad" rather than as a
 * wiring bug:
 *
 *  1. **`asOf`.** `buildRetrieveBody()` returns `null` without it and the
 *     retrieve yields zero chunks. The provider must therefore go through the
 *     engine's own `AIClient` — which carries the turn's `asOf` — and must
 *     never issue a retrieve of its own.
 *  2. **Corpus names are never composed.** They come from the backend's
 *     `/corpora` response. `makeEngineAIClient` refuses anything outside that
 *     list WITHOUT a network call, so a composed name fails invisibly.
 *  3. **Scope.** Everything except the ecosistema's shared published corpus is
 *     narrowed to the current conversation's documents. The graph leg reads
 *     ecosistema-wide published material, so it must name that corpus — say
 *     nothing and its hits vanish with no error.
 *
 * `$lib/server/auth` is mocked, which also keeps `$env` out of the test.
 */

const backendFetch = vi.fn();
vi.mock('$lib/server/auth', () => ({ backendFetch: (...args: unknown[]) => backendFetch(...args) }));

const {
  fetchGraphEntity,
  fetchGraphRetrieval,
  fetchGraphView,
  graphExpansionCorpus,
  graphViewQuery,
  makeGraphProvider,
  GRAPH_EXPANSION_TOPK,
  GRAPH_PATH_TAG,
} = await import('./graph');

/** Every path `backendFetch` was called with, in order. */
function urls(): string[] {
  return backendFetch.mock.calls.map((c) => String(c[1]));
}

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const PUBLISHED = 'eco:7:published';
const DRAFT = 'user:3:draft';
const CORPORA = [PUBLISHED, DRAFT];

/**
 * A stand-in for the engine `AIClient` built by `makeEngineAIClient`.
 *
 * ⚠ `retrieve` declares its argument so the assertions below can read what the
 * provider ASKED FOR — which corpus, which topK — and not merely that it asked.
 * Invariants 2 and 3 are both statements about that argument.
 */
type Match = RetrieveResult['matches'][number];

function fakeAIClient(matches: Match[] = []) {
  return {
    generateSync: vi.fn(),
    ingest: vi.fn(),
    retrieve: vi.fn(async (_req: RetrieveRequest): Promise<RetrieveResult> => ({ matches })),
  };
}

function providerOptions(overrides: Record<string, unknown> = {}) {
  return {
    token: 'tok',
    organizationId: '7',
    aiClient: fakeAIClient(),
    orgId: 'edc',
    scopeId: 'session-1',
    corpora: CORPORA,
    publishedCorpus: PUBLISHED,
    ...overrides,
  } as unknown as Parameters<typeof makeGraphProvider>[0];
}

/** The shape `POST /api/graph/retrieve` answers with. */
function retrievalBody(extra: Record<string, unknown> = {}) {
  return {
    entities: [
      { id: 'e1', type: 'tema', label: 'Migración', support: 12 },
      { id: 'e2', type: 'lugar', label: 'Tijuana', support: 7 },
    ],
    edges: [{ fromId: 'e1', toId: 'e2', relationType: 'ocurre_en', support: 5 }],
    documents: [{ id: 'd1', title: 'Testimonio 4', contentKind: 'testimonio' }],
    terms: ['Tijuana', 'albergue'],
    ...extra,
  };
}

beforeEach(() => {
  backendFetch.mockReset();
});

describe('graphViewQuery', () => {
  it('always names the organization, and only adds what it was given', () => {
    expect(graphViewQuery({ organizationId: '7' })).toBe('organization=7');
    const full = new URLSearchParams(graphViewQuery({ organizationId: '7', type: 'tema', q: 'mig' }));
    expect(full.get('organization')).toBe('7');
    expect(full.get('type')).toBe('tema');
    expect(full.get('q')).toBe('mig');
  });
});

describe('fetchGraphView', () => {
  it('reads the entities, the hidden count and the threshold', async () => {
    backendFetch.mockResolvedValue(
      reply({
        entities: [
          { id: 'a', type: 'tema', label: 'Agua', support: 3 },
          { id: 'b', type: 'lugar', label: 'Río', support: 9 },
        ],
        hidden: 14,
        minSupport: 3,
      }),
    );
    const { view, ok } = await fetchGraphView('tok', { organizationId: '7' });
    expect(ok).toBe(true);
    expect(urls()[0]).toBe('/api/graph/view?organization=7');
    // Ranked on the way in, so the page never has to re-sort.
    expect(view.entities.map((e) => e.label)).toEqual(['Río', 'Agua']);
    expect(view.hidden).toBe(14);
    expect(view.minSupport).toBe(3);
  });

  // 🔴 PERSONA REACHES THE BROWSER, AND THAT IS SAFE BECAUSE OF WHERE THE
  // PERSON RULE LIVES. It is an EXTRACTION rule, not a serialisation one: the
  // backend cannot produce a person node from a testimonio at all
  // (`personaAllowed(contentKind)`, which fails closed on null). So a name that
  // arrives here came from a `documento` -- a cited author, a named official --
  // and it still had to clear `GRAPH_MIN_SUPPORT` to be sent at all.
  it('passes persona entities through like any other type', async () => {
    backendFetch.mockResolvedValue(
      reply({
        entities: [
          { id: 'p', type: 'persona', label: 'Juana Pérez', support: 40 },
          { id: 'a', type: 'tema', label: 'Agua', support: 3 },
        ],
        hidden: 0,
      }),
    );
    const { view } = await fetchGraphView('tok', { organizationId: '7' });
    expect(view.entities.map((e) => e.id)).toEqual(['p', 'a']);
  });

  // ⚠ The seam still fails closed. A category the backend adds tomorrow does
  // not appear in this product until somebody decides it should.
  it('still drops a type nobody has decided to show', async () => {
    backendFetch.mockResolvedValue(
      reply({
        entities: [
          { id: 'x', type: 'concepto', label: 'Categoría futura', support: 40 },
          { id: 'a', type: 'tema', label: 'Agua', support: 3 },
        ],
        hidden: 0,
      }),
    );
    const { view } = await fetchGraphView('tok', { organizationId: '7' });
    expect(view.entities.map((e) => e.id)).toEqual(['a']);
  });

  // ⚠ An outage is not an empty ecosistema. The page renders `ok: false` as
  // "no pudimos leer el grafo", never as "aún no hay suficientes documentos".
  it('reports a failed read rather than an empty graph', async () => {
    backendFetch.mockResolvedValue(reply({}, 500));
    expect((await fetchGraphView('tok', { organizationId: '7' })).ok).toBe(false);
    backendFetch.mockRejectedValue(new Error('down'));
    expect((await fetchGraphView('tok', { organizationId: '7' })).ok).toBe(false);
  });
});

describe('fetchGraphEntity', () => {
  const detail = {
    entity: { id: 'e1', type: 'tema', label: 'Migración', support: 12 },
    neighbours: [
      { entity: { id: 'e2', type: 'lugar', label: 'Tijuana', support: 7 }, relationType: 'ocurre_en', support: 5 },
    ],
    documents: [{ id: 'd1', title: 'Acta 2024', contentKind: 'documento' }],
  };

  it('scopes the read to the organization', async () => {
    backendFetch.mockResolvedValue(reply(detail));
    const res = await fetchGraphEntity('tok', '7', 'e1');
    expect(urls()[0]).toBe('/api/graph/entity/e1?organization=7');
    expect(res.state).toBe('ok');
    if (res.state === 'ok') expect(res.detail.neighbours[0]!.entity.label).toBe('Tijuana');
  });

  it('percent-encodes an id so it cannot escape the path', async () => {
    backendFetch.mockResolvedValue(reply(detail));
    await fetchGraphEntity('tok', '7', 'a/b?c=d');
    expect(urls()[0]).toBe('/api/graph/entity/a%2Fb%3Fc%3Dd?organization=7');
  });

  // ⚠ A 403 would confirm the id exists in some other ecosistema. That is the
  // one inference an org-scoped surface must not hand out, so both answers look
  // identical from here.
  it('reports 403 and 404 identically, as absent', async () => {
    backendFetch.mockResolvedValue(reply({}, 403));
    expect((await fetchGraphEntity('tok', '7', 'e1')).state).toBe('not-found');
    backendFetch.mockResolvedValue(reply({}, 404));
    expect((await fetchGraphEntity('tok', '7', 'e1')).state).toBe('not-found');
  });

  // ⚠ A 400 is a hand-edited address bar, not an outage. The backend only
  // accepts a numeric id, so "eso ya no aparece en el grafo" is the honest
  // answer; "no pudimos leer el grafo" blames our backend for a typo.
  it('reads a malformed id as absent, not as an outage', async () => {
    backendFetch.mockResolvedValue(reply({}, 400));
    expect((await fetchGraphEntity('tok', '7', 'no-soy-un-id')).state).toBe('not-found');
  });

  it('separates "could not read" from "not there"', async () => {
    backendFetch.mockResolvedValue(reply({}, 502));
    expect((await fetchGraphEntity('tok', '7', 'e1')).state).toBe('unavailable');
  });

  // 🔴 A persona opens like any other entity. Safe for the same reason as
  // the list above: the person rule is enforced at EXTRACTION, so this name
  // came from a `documento` and cleared the minimum-support threshold.
  it('opens a persona entity like any other', async () => {
    backendFetch.mockResolvedValue(
      reply({ ...detail, entity: { id: 'p', type: 'persona', label: 'Juana Pérez', support: 9 } }),
    );
    const res = await fetchGraphEntity('tok', '7', 'p');
    expect(res.state).toBe('ok');
    if (res.state === 'ok') expect(res.detail.entity.type).toBe('persona');
  });

  it('keeps a persona among the neighbours of another entity', async () => {
    backendFetch.mockResolvedValue(
      reply({
        ...detail,
        neighbours: [
          ...detail.neighbours,
          { entity: { id: 'p', type: 'persona', label: 'Juana Pérez', support: 30 }, relationType: 'participa_en', support: 30 },
        ],
      }),
    );
    const res = await fetchGraphEntity('tok', '7', 'e1');
    expect(res.state).toBe('ok');
    // Ranked by edge support, so the person leads -- not pinned, not demoted.
    if (res.state === 'ok') expect(res.detail.neighbours.map((n) => n.entity.id)).toEqual(['p', 'e2']);
  });

  // ⚠ The seam still fails closed at this boundary too.
  it('still treats an entity of an undecided type as absent', async () => {
    backendFetch.mockResolvedValue(
      reply({ ...detail, entity: { id: 'x', type: 'concepto', label: 'Categoría futura', support: 9 } }),
    );
    expect((await fetchGraphEntity('tok', '7', 'x')).state).toBe('not-found');
  });
});

describe('graphExpansionCorpus — invariants 2 and 3', () => {
  // 🔴 INVARIANT 2. The name is PICKED out of what the backend authorised. This
  // function cannot compose one, and there is deliberately no template
  // anywhere in this app that could.
  it('picks the published corpus out of the authorised list', () => {
    expect(graphExpansionCorpus(CORPORA, PUBLISHED)).toBe(PUBLISHED);
  });

  // 🔴 INVARIANT 3, the failure direction. Without a published corpus the leg
  // is skipped, never aimed at a draft corpus — which would be narrowed to this
  // conversation's own documents and quietly return nothing.
  it('skips the retrieve when no published corpus was identified', () => {
    expect(graphExpansionCorpus(CORPORA, null)).toBeNull();
    expect(graphExpansionCorpus(CORPORA, undefined)).toBeNull();
  });

  it('refuses a published corpus the backend did not authorise', () => {
    expect(graphExpansionCorpus([DRAFT], PUBLISHED)).toBeNull();
  });
});

describe('fetchGraphRetrieval', () => {
  it('posts the query and the organization, and parses the answer', async () => {
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const result = await fetchGraphRetrieval('tok', { organizationId: '7', query: '¿qué temas?' });
    expect(urls()[0]).toBe('/api/graph/retrieve');
    const sent = JSON.parse(String(backendFetch.mock.calls[0]![2].body));
    expect(sent).toMatchObject({ organization: '7', query: '¿qué temas?' });
    expect(result?.terms).toEqual(['Tijuana', 'albergue']);
  });

  it('returns null on a failed read rather than throwing into the turn', async () => {
    backendFetch.mockResolvedValue(reply({}, 500));
    expect(await fetchGraphRetrieval('tok', { organizationId: '7', query: 'x' })).toBeNull();
    backendFetch.mockRejectedValue(new Error('no such endpoint yet'));
    expect(await fetchGraphRetrieval('tok', { organizationId: '7', query: 'x' })).toBeNull();
  });
});

describe('makeGraphProvider', () => {
  it('is null without an ecosistema, so the turn omits the provider entirely', () => {
    expect(makeGraphProvider(providerOptions({ organizationId: null }))).toBeNull();
  });

  it('asks the backend with the CONDENSED query the engine handed it', async () => {
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const provider = makeGraphProvider(providerOptions())!;
    await provider('qué temas se repiten entre los testimonios');
    const sent = JSON.parse(String(backendFetch.mock.calls[0]![2].body));
    expect(sent.query).toBe('qué temas se repiten entre los testimonios');
  });

  // 🔴 INVARIANT 1. The expansion goes through the engine's own AIClient, which
  // already carries this turn's `asOf` and routes every call through
  // `buildRetrieveBody`. A hand-rolled fetch here would be a second retrieve
  // path with a second chance to forget `asOf` — and an `asOf`-less retrieve
  // still returns the chunks of UNPUBLISHED documents.
  it('runs the expansion through the injected AIClient, never its own fetch', async () => {
    const aiClient = fakeAIClient([
      { documentId: 'd1', chunkId: 'c1', score: 0.4, text: 'algo', metadata: { docId: 'd1' } },
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    backendFetch.mockResolvedValue(reply(retrievalBody()));

    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    const result = await provider('migración');

    expect(aiClient.retrieve).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result?.chunks?.length).toBe(1);
    fetchSpy.mockRestore();
  });

  // 🔴 INVARIANT 3. The graph leg reads the ecosistema's shared PUBLISHED
  // corpus and names it. Anything else is narrowed to this conversation's own
  // documents, and the graph hits would disappear with no error at all.
  it('retrieves from the published corpus, and from nothing else', async () => {
    const aiClient = fakeAIClient();
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    await provider('migración');

    expect(aiClient.retrieve).toHaveBeenCalledTimes(1);
    expect(aiClient.retrieve.mock.calls[0]![0]).toMatchObject({
      corpus: PUBLISHED,
      orgId: 'edc',
      scopeId: 'session-1',
      topK: GRAPH_EXPANSION_TOPK,
    });
  });

  it('skips the retrieve, but still contributes the block, without a published corpus', async () => {
    const aiClient = fakeAIClient();
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const provider = makeGraphProvider(providerOptions({ aiClient, publishedCorpus: null }))!;
    const result = await provider('migración');

    expect(aiClient.retrieve).not.toHaveBeenCalled();
    // The deterministic block comes from the backend, not from ai-service, so
    // the global-question win survives even when the expansion cannot run.
    expect(result?.context).toContain('Migración');
  });

  // ADR §8.1: ONE extra retrieve per turn. Not one per matched entity.
  it('never runs more than one expansion retrieve', async () => {
    const aiClient = fakeAIClient();
    backendFetch.mockResolvedValue(
      reply(retrievalBody({ terms: ['uno', 'dos', 'tres', 'cuatro', 'cinco'] })),
    );
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    await provider('migración');
    expect(aiClient.retrieve).toHaveBeenCalledTimes(1);
  });

  it('tags every graph chunk with metadata.path and its corpus', async () => {
    const aiClient = fakeAIClient([
      { documentId: 'd1', chunkId: 'c1', score: 0.4, text: 'algo', metadata: { title: 'Acta' } },
    ]);
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    const result = await provider('migración');

    expect(result?.chunks?.[0]).toMatchObject({
      chunkId: 'c1',
      corpus: PUBLISHED,
      // ⚠ The existing metadata survives; `path` is the only key added.
      metadata: { title: 'Acta', path: GRAPH_PATH_TAG },
    });
  });

  // ⚠ An expansion that adds no term is the SAME query over the SAME corpus the
  // vector leg already ran. The extra `POST /v1/retrieve` would buy identical
  // results, and ADR §8.4 already puts the bill for GraphRAG on local questions.
  it('does not pay for a retrieve when the terms add nothing new', async () => {
    const aiClient = fakeAIClient();
    backendFetch.mockResolvedValue(reply(retrievalBody({ terms: [] })));
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    const result = await provider('migración');
    expect(aiClient.retrieve).not.toHaveBeenCalled();
    expect(result?.context).toBeTruthy();
  });

  it('does not pay for a retrieve when every term is already in the query', async () => {
    const aiClient = fakeAIClient();
    backendFetch.mockResolvedValue(reply(retrievalBody({ terms: ['Tijuana'] })));
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    // Accent- and case-insensitive: "tijuana" in the query covers "Tijuana".
    await provider('qué pasa en tijuana');
    expect(aiClient.retrieve).not.toHaveBeenCalled();
  });

  // 🔴 NO MODEL CALL. The block is where the global-question win comes from
  // (ADR §8.1, G2), and it is built by string concatenation over an aggregate
  // the graph already holds — not by asking a model to guess it back.
  it('builds the block without generating anything', async () => {
    const aiClient = fakeAIClient();
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    const result = await provider('migración');

    expect(aiClient.generateSync).not.toHaveBeenCalled();
    expect(result?.context).toContain('Migración');
    expect(result?.context).toContain('aparece en 12 documentos');
    // ⚠ No document titles ride into the prompt — that would be a per-turn
    // re-identification surface for nothing the aggregate does not already give.
    expect(result?.context).not.toContain('Testimonio 4');
  });

  it('contributes nothing when the graph matched nothing', async () => {
    backendFetch.mockResolvedValue(reply(retrievalBody({ entities: [], edges: [] })));
    const provider = makeGraphProvider(providerOptions())!;
    expect(await provider('migración')).toBeNull();
  });

  it('contributes nothing when the backend is not there yet', async () => {
    backendFetch.mockRejectedValue(new Error('404'));
    const provider = makeGraphProvider(providerOptions())!;
    expect(await provider('migración')).toBeNull();
  });

  it('contributes nothing for a blank query', async () => {
    const provider = makeGraphProvider(providerOptions())!;
    expect(await provider('   ')).toBeNull();
    expect(backendFetch).not.toHaveBeenCalled();
  });

  // ⚠ The timeout is OURS. The engine deliberately does not impose one, and a
  // graph backend that hangs must not hold a chat turn open behind it.
  it('gives up on a hanging backend within its own deadline', async () => {
    backendFetch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(reply(retrievalBody())), 200)),
    );
    const provider = makeGraphProvider(providerOptions({ timeoutMs: 10 }))!;
    expect(await provider('migración')).toBeNull();
  });

  it('still contributes the block when the expansion retrieve throws', async () => {
    const aiClient = fakeAIClient();
    aiClient.retrieve.mockRejectedValue(new Error('ai-service down'));
    backendFetch.mockResolvedValue(reply(retrievalBody()));
    const provider = makeGraphProvider(providerOptions({ aiClient }))!;
    const result = await provider('migración');
    expect(result?.context).toContain('Migración');
    expect(result?.chunks ?? []).toEqual([]);
  });
});

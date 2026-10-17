import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_CONFIG, prepareTurn } from '@edc/chat-engine/core';
import type {
  AIClient,
  DomainAdapter,
  RetrieveMatch,
  RetrieveRequest,
  SyncGenerationRequest,
} from '@edc/chat-engine/core';
import { chatRetrievalPolicy } from './rerank';
import {
  EXPANSION_SYSTEM_PROMPT,
  parseExpansionFlag,
  parseExpansions,
  shouldExpand,
  withQueryExpansion,
} from './expand';

/**
 * Query expansion, proved on a fake AIClient. Hermetic: no `$env`, no network.
 *
 * 🔴 The positive assertions matter as much as the negative ones: a wrapper
 * that never expanded would pass every "falls back to the original" test. So
 * the rewrites are asserted to REACH retrieve, and their hits to REACH the
 * result.
 */

function m(chunkId: string, score: number, extra: Partial<RetrieveMatch> = {}): RetrieveMatch {
  return { documentId: `d-${chunkId}`, chunkId, score, text: `texto ${chunkId}`, ...extra };
}

const OPTS = { surface: 'chat', orgId: 'edc', scopeId: 's1', userId: 'u1' };

function fakeClient(args: {
  generateText?: string;
  generateThrows?: boolean;
  byQuery: Record<string, RetrieveMatch[]>;
}) {
  const retrieves: RetrieveRequest[] = [];
  const generates: SyncGenerationRequest[] = [];
  const client: AIClient = {
    async generateSync(req) {
      generates.push(req);
      if (args.generateThrows) throw new Error('budget');
      return {
        text: args.generateText ?? '',
        modelUsed: 'm',
        provider: 'p',
        costUsd: 0.0001,
        traceId: 't',
      };
    },
    async retrieve(req) {
      retrieves.push(req);
      return { matches: args.byQuery[req.query] ?? [] };
    },
    async ingest() {
      return { ingested: 0, documentIds: [] };
    },
  };
  return { client, retrieves, generates };
}

const Q = '¿qué dicen sobre el acceso a intérpretes en hospitales?';
const REQ: RetrieveRequest = {
  orgId: 'edc',
  scopeId: 's1',
  corpus: 'pub:1',
  query: Q,
  topK: 3,
  filter: { lengua: 'zapoteco' },
};

describe('parseExpansions', () => {
  it('keeps one variant per line, stripped of numbering, labels and quotes', () => {
    const out = parseExpansions(
      '1. Intérpretes de lenguas indígenas en el sistema de salud\n' +
        '- "Traducción para pacientes en clínicas"\n' +
        'Respuesta hipotética: Los testimonios cuentan que no hay intérpretes en el hospital.',
      Q,
    );
    expect(out).toEqual([
      'Intérpretes de lenguas indígenas en el sistema de salud',
      'Traducción para pacientes en clínicas',
      'Los testimonios cuentan que no hay intérpretes en el hospital.',
    ]);
  });

  it('drops blanks, junk, repeats and the original question itself', () => {
    const out = parseExpansions(`\n\nok\n${Q}\nsalud indígena\nSalud indígena\n`, Q);
    expect(out).toEqual(['salud indígena']);
  });

  it('caps the number of variants at three', () => {
    expect(parseExpansions('uno dos\ntres cuatro\ncinco seis\nsiete ocho', Q)).toHaveLength(3);
  });
});

describe('shouldExpand', () => {
  it('skips greetings and one-word queries', () => {
    expect(shouldExpand('hola')).toBe(false);
    expect(shouldExpand('  gracias  ')).toBe(false);
  });
  it('expands an ordinary question', () => {
    expect(shouldExpand(Q)).toBe(true);
    expect(shouldExpand('derechos lingüísticos')).toBe(true);
  });
  it('skips a pasted wall of text — it is already specific', () => {
    expect(shouldExpand('palabra '.repeat(80))).toBe(false);
  });
});

describe('parseExpansionFlag', () => {
  it('defaults to on', () => {
    expect(parseExpansionFlag(undefined)).toBe(true);
    expect(parseExpansionFlag('')).toBe(true);
    expect(parseExpansionFlag('on')).toBe(true);
  });
  it('turns off on the usual spellings', () => {
    for (const v of ['off', '0', 'false', 'no', ' OFF ']) expect(parseExpansionFlag(v)).toBe(false);
  });
});

describe('withQueryExpansion', () => {
  it('🔴 searches every rewording with the same corpus, topK and lengua filter', async () => {
    const { client, retrieves, generates } = fakeClient({
      generateText: 'intérpretes en salud\ntraducción en clínicas',
      byQuery: {},
    });
    await withQueryExpansion(client, OPTS).retrieve(REQ);
    expect(retrieves.map((r) => r.query)).toEqual([
      Q,
      'intérpretes en salud',
      'traducción en clínicas',
    ]);
    for (const r of retrieves) {
      expect(r.corpus).toBe('pub:1');
      expect(r.topK).toBe(3);
      expect(r.filter).toEqual({ lengua: 'zapoteco' });
    }
    // One cheap, Spanish-prompted call.
    expect(generates).toHaveLength(1);
    expect(generates[0]!.effort).toBe('quick');
    expect(generates[0]!.messages[0]).toEqual({ role: 'system', content: EXPANSION_SYSTEM_PROMPT });
    expect(generates[0]!.messages[1]!.content).toContain(Q);
  });

  it('🔴 a chunk only a rewording found reaches the result, fused by RRF', async () => {
    const { client } = fakeClient({
      generateText: 'intérpretes en salud',
      byQuery: {
        [Q]: [m('a', 0.8), m('b', 0.7), m('c', 0.6)],
        'intérpretes en salud': [m('x', 0.9), m('b', 0.85)],
      },
    });
    const { matches } = await withQueryExpansion(client, OPTS).retrieve(REQ);
    const ids = matches.map((x) => x.chunkId);
    // `b` was found by both legs, so it leads; `x` displaces the original's `c`.
    expect(ids[0]).toBe('b');
    expect(ids).toContain('x');
    expect(ids).toHaveLength(3); // capped at the request's topK
  });

  it('keeps the ORIGINAL query\'s score on a chunk both legs found', async () => {
    const { client } = fakeClient({
      generateText: 'intérpretes en salud',
      byQuery: { [Q]: [m('b', 0.5)], 'intérpretes en salud': [m('b', 0.95)] },
    });
    const { matches } = await withQueryExpansion(client, OPTS).retrieve(REQ);
    expect(matches).toEqual([m('b', 0.5)]);
  });

  it('🔴 ONE expansion call per turn, however many corpora are retrieved', async () => {
    const { client, generates } = fakeClient({ generateText: 'intérpretes en salud', byQuery: {} });
    const wrapped = withQueryExpansion(client, OPTS);
    await Promise.all([
      wrapped.retrieve(REQ),
      wrapped.retrieve({ ...REQ, corpus: 'draft:7' }),
      wrapped.retrieve({ ...REQ, corpus: 'chat:thread:1' }),
    ]);
    expect(generates).toHaveLength(1);
  });

  it('a failing expansion call degrades to the plain retrieve, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, retrieves } = fakeClient({
      generateThrows: true,
      byQuery: { [Q]: [m('a', 0.8)] },
    });
    const { matches } = await withQueryExpansion(client, OPTS).retrieve(REQ);
    expect(matches).toEqual([m('a', 0.8)]);
    expect(retrieves).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[expand]'));
    warn.mockRestore();
  });

  it('a short query is searched as-is, with no model call', async () => {
    const { client, retrieves, generates } = fakeClient({ byQuery: { hola: [m('a', 0.3)] } });
    const { matches } = await withQueryExpansion(client, OPTS).retrieve({ ...REQ, query: 'hola' });
    expect(matches).toEqual([m('a', 0.3)]);
    expect(generates).toHaveLength(0);
    expect(retrieves).toHaveLength(1);
  });

  it('a rewording whose retrieve fails is dropped; the turn keeps the rest', async () => {
    const { client } = fakeClient({
      generateText: 'intérpretes en salud\ntraducción en clínicas',
      byQuery: { [Q]: [m('a', 0.8)], 'traducción en clínicas': [m('y', 0.7)] },
    });
    const inner = client.retrieve.bind(client);
    client.retrieve = async (req) => {
      if (req.query === 'intérpretes en salud') throw new Error('boom');
      return inner(req);
    };
    const { matches } = await withQueryExpansion(client, OPTS).retrieve(REQ);
    expect(matches.map((x) => x.chunkId).sort()).toEqual(['a', 'y']);
  });

  it('reports what it did, for the eval harness', async () => {
    const onExpansion = vi.fn();
    const { client } = fakeClient({ generateText: 'intérpretes en salud', byQuery: {} });
    await withQueryExpansion(client, { ...OPTS, onExpansion }).retrieve(REQ);
    expect(onExpansion).toHaveBeenCalledWith(
      expect.objectContaining({ query: Q, variants: ['intérpretes en salud'], costUsd: 0.0001 }),
    );
  });

  it('passes generateSync through untouched — condense and the answer are not expanded', async () => {
    const { client, generates } = fakeClient({ generateText: 'hola', byQuery: {} });
    const wrapped = withQueryExpansion(client, OPTS);
    await wrapped.generateSync({ surface: 'chat', orgId: 'edc', userId: 'u', messages: [] });
    expect(generates).toHaveLength(1);
  });
});

describe('through the real engine (`prepareTurn`)', () => {
  const adapter: DomainAdapter = {
    async scopeHierarchy() {
      return { summaryText: 'Ecosistema: prueba.', corpora: [{ corpus: 'pub:1' }, { corpus: 'draft:7' }] };
    },
    async searchEntities() {
      return [];
    },
    async resolveEntity() {
      return '';
    },
    async syncEntity() {},
    async backfill() {},
    async summary() {
      return '';
    },
  };

  it('🔴 a chunk only the rewording finds arrives in the turn, with ONE model call', async () => {
    const { client, generates, retrieves } = fakeClient({
      generateText: 'intérpretes en salud',
      byQuery: {
        [Q]: [m('a', 0.8)],
        'intérpretes en salud': [m('x', 0.9, { metadata: { title: 'Testimonio X' } })],
      },
    });
    const prepared = await prepareTurn({
      config: { ...DEFAULT_ENGINE_CONFIG, surface: 'chat' },
      aiClient: withQueryExpansion(client, OPTS),
      adapter,
      orgId: 'edc',
      userId: 'u1',
      threadId: 't1',
      scope: { refs: [{ kind: 'org' }] },
      history: [],
      userMessage: Q,
      retrievalFilter: { lengua: 'zapoteco' },
    });
    expect(prepared.matches.map((x) => x.chunkId)).toContain('x');
    expect(prepared.messages.at(-1)!.content).toContain('texto x');
    // First turn: condense makes no call, so the expansion is the only one.
    expect(generates).toHaveLength(1);
    // 3 corpora (pub, draft, the engine's thread leg) × 2 queries.
    expect(retrieves).toHaveLength(6);
    expect(retrieves.every((r) => r.filter?.lengua === 'zapoteco')).toBe(true);
  });

  it('🔴 with the rerank policy, ONLY the original query is reranked — once per corpus', async () => {
    const { client, retrieves } = fakeClient({
      generateText: 'intérpretes en salud\ntraducción en clínicas',
      byQuery: { [Q]: [m('a', 0.9, { denseScore: 0.6, rerankScore: 0.9 })] },
    });
    const prepared = await prepareTurn({
      config: { ...DEFAULT_ENGINE_CONFIG, surface: 'chat' },
      aiClient: withQueryExpansion(client, OPTS),
      adapter,
      orgId: 'edc',
      userId: 'u1',
      threadId: 't1',
      scope: { refs: [{ kind: 'org' }] },
      history: [],
      userMessage: Q,
      retrievalPolicy: chatRetrievalPolicy(true)!,
    });
    const reranked = retrieves.filter((r) => r.rerank === true);
    // 3 corpora × 1 original query; the 2 rewordings per corpus go out plain.
    expect(reranked).toHaveLength(3);
    expect(reranked.every((r) => r.query === Q)).toBe(true);
    expect(retrieves.filter((r) => r.query !== Q).every((r) => r.rerank === undefined)).toBe(true);
    // The cosine rides through, so the engine's gate reads it, not the rerank score.
    expect(prepared.maxDenseScore).toBe(0.6);
  });
});

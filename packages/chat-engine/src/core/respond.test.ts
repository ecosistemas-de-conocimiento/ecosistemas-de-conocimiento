import { describe, it, expect, vi } from 'vitest';
import { respond, prepareTurn, MAX_INLINE_REFS } from './respond.js';
import { buildChatTurn } from './turn.js';
import { condenseQuery } from './condense.js';
import { retrieveContext } from './retrieve.js';
import { syncEntity, backfillScope, CorpusSyncError } from './corpus-sync.js';
import { generateThreadTitle } from './title.js';
import { DEFAULT_ENGINE_CONFIG } from './config.js';
import { EMPTY_ANSWER_CODE, EmptyAnswerError } from './generation.js';
import type {
  AIClient,
  RetrieveRequest,
  RetrieveResult,
  SyncGenerationRequest,
  SyncGenerationResult,
} from './types.js';
import type { DomainAdapter, ResolvedScope } from './adapter.js';

// ── fakes ────────────────────────────────────────────────────────────────────

/**
 * `util.inspect` renders a value the way `console.warn` / `console.error` do in
 * Node (Error message, stack, `[cause]`), which `JSON.stringify` does not.
 * ⚠ Loaded through a non-literal specifier ON PURPOSE: this package has no
 * `@types/node`, and `svelte-check` (which reads every `src/**\/*.ts`) fails
 * on a static `import 'node:util'`. Adding the types would change the
 * lockfile for one test helper.
 */
const NODE_UTIL = 'node:util';
const { inspect } = (await import(/* @vite-ignore */ NODE_UTIL)) as {
  inspect: (value: unknown, options?: { depth?: number; showHidden?: boolean }) => string;
};

/**
 * Capture console.warn and read back the STRUCTURED payload (the 2nd arg) —
 * tests assert the stable `event` code, never the human-readable line.
 *
 * `events()` also pins the CALL SHAPE: exactly (line: string, payload: plain
 * object). A third argument — e.g. the raw error — fails here, not silently.
 *
 * `raw()` renders every argument the way a console would (`util.inspect`,
 * deep, hidden props), for "never logs X" checks. ⚠ NOT `JSON.stringify`: it
 * turns an `Error` into `{}`, so a leaked error object read as clean.
 */
function captureWarnings() {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    events: () =>
      spy.mock.calls.map((c) => {
        expect(c).toHaveLength(2);
        expect(typeof c[0]).toBe('string');
        expect(Object.getPrototypeOf(c[1])).toBe(Object.prototype);
        return c[1];
      }),
    raw: () =>
      spy.mock.calls
        .map((c) => c.map((a) => inspect(a, { depth: 10, showHidden: true })).join(' '))
        .join('\n'),
    restore: () => spy.mockRestore(),
  };
}

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
      "[CONTEXT for your reply — it is RIGHT BELOW and it is your primary source.

      Rules:
      1. What is below, you have. Never say you lack information that appears below, and never ask the user for something that already appears below.
      2. What is NOT below, you do not have. Say so plainly and name the missing detail. Never invent, assume, estimate or extrapolate it, and do not dress a guess as "about", "around" or "at least" — numbers and counts above all.
      3. Give a number only if that number is written below, or you can derive it by arithmetic over numbers that are written below. Otherwise rule 2 applies — including when you could work it out by counting a list.
      4. A list below may be partial. If you report how many items it shows, say plainly that it is the number listed here, not the total.
      5. Saying that a detail is not here is a correct and complete answer. A plausible number is not.
      6. Write your reply in the same language as the user message.]

      Contexto del proyecto/organización:
      RESUMEN

      ---

      Contexto recuperado de la base de conocimiento:
      [1] CHUNK-A

      ---

      Entidades citadas por el usuario (@):
      REF-TEXT

      ========

      User message (reply in this same language):
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

// ── the preamble's two obligations ───────────────────────────────────────────
//
// Product rule: the system must never invent a number. It either has the real
// value or it says it does not have it. The preamble is where that is enforced,
// so these guard BOTH halves — an edit that drops either one must go red.
//
// ⚠ These are STRING pins. They prove the instruction is present; they do NOT
// prove a model obeys it. Live behaviour is measured by `harness/` (see its
// README), never by this file.

describe('userContextPreamble — honest-context contract', () => {
  const preamble = DEFAULT_ENGINE_CONFIG.userContextPreamble;

  it('keeps each slot EXACTLY once, and keeps the rules above the context', () => {
    // `applyPreamble` visits each slot once. A duplicated `{context}` would
    // ship a literal `{context}` to the model; a rule block moved below the
    // context would lose its priming position. Both must fail loudly.
    expect(preamble.match(/\{context\}/g)).toHaveLength(1);
    expect(preamble.match(/\{message\}/g)).toHaveLength(1);
    expect(preamble).toContain('========');
    expect(preamble.indexOf('Rules:')).toBeLessThan(preamble.indexOf('{context}'));
    expect(preamble.indexOf('{context}')).toBeLessThan(preamble.indexOf('========'));
    expect(preamble.indexOf('========')).toBeLessThan(preamble.indexOf('{message}'));
  });

  it('(a) forbids denying context that IS present — and stays SCOPED', () => {
    // The original failure: the assistant said "no tengo acceso a tu proyecto"
    // while the project sat directly below.
    expect(preamble).toMatch(/What is below, you have/i);
    // ⚠ The scoping is the whole fix. An unscoped "never say you have no
    // information" is the 0.3.1 defect verbatim: it reads as a blanket ban on
    // admitting ignorance, which is what made the model invent counts. If this
    // assertion is ever loosened, re-read the config.ts doc first.
    expect(preamble).toMatch(/Never say you lack information that appears below/i);
    expect(preamble).not.toMatch(/Never say you have no information[,.]/i);
  });

  it('(b) requires naming an ABSENT fact instead of inventing or hedging one', () => {
    expect(preamble).toMatch(/Never invent, assume, estimate or extrapolate/i);
    expect(preamble).toMatch(/name the missing detail/i);
    // Hedging is fabrication with a softener on it.
    expect(preamble).toMatch(/"about", "around" or "at least"/i);
  });

  it('(b) gates numbers on being written or derivable — not on being countable', () => {
    // The concrete defect: the summary lists names but no total, so a model
    // told never to admit ignorance counts the visible names and answers with
    // confidence. The gate is mechanical on purpose — "is this number written
    // below?" is checkable, "am I counting to produce a total?" is a judgement
    // call the model can talk itself past.
    expect(preamble).toMatch(/Give a number only if that number is written below/i);
    expect(preamble).toMatch(/counting a list/i);
    // …but legitimate arithmetic over STATED numbers must stay allowed, or the
    // assistant stonewalls on sums it can actually justify.
    expect(preamble).toMatch(/derive it by arithmetic over numbers that are written below/i);
  });

  it('(b) defines the right answer for a partial list, rather than banning it', () => {
    // Reporting "3 are listed here, which may not be the total" is honest and
    // useful. Only a BARE count presented as the total is the defect.
    expect(preamble).toMatch(/A list below may be partial/i);
    expect(preamble).toMatch(/the number listed here, not the total/i);
  });

  it('grants explicit permission to say a detail is missing', () => {
    // Load-bearing counterweight to (a): without it, (a) reads as an absolute
    // ban on admitting ignorance about anything.
    expect(preamble).toMatch(/is a correct and complete answer/i);
  });

  it('(c) states the reply language TWICE, including next to the message', () => {
    // The directive is English MACHINERY. Without an explicit rule the model
    // can answer a Spanish user in English — a worse regression than the bug
    // being fixed. The rule in the header sits ~1k tokens from the generation
    // point, so it is repeated on the label immediately before `{message}`,
    // where it actually carries weight.
    expect(preamble).toMatch(/same language as the user message/i);
    expect(preamble).toMatch(/User message \(reply in this same language\):/);
    const tail = preamble.slice(preamble.indexOf('========'));
    expect(tail).toMatch(/reply in this same language/i);
  });

  it('is English machinery, while the block headers stay localized content', () => {
    // The split is deliberate and must not be "unified" by a later tidy-up:
    //   preamble     = the engine instructing the model   → MACHINERY, English
    //   blockHeaders = labels on product prose the model  → CONTENT, localized
    //                  can echo into its own reply
    // Asserted by leading Spanish word rather than by deep-equality, so a
    // legitimate rewording passes but an accidental translation fails.
    expect(preamble).not.toMatch(/[áéíóúñ¿¡]/i);
    expect(DEFAULT_ENGINE_CONFIG.blockHeaders.summary).toMatch(/^Contexto/);
    expect(DEFAULT_ENGINE_CONFIG.blockHeaders.retrieved).toMatch(/^Contexto/);
    expect(DEFAULT_ENGINE_CONFIG.blockHeaders.inlineRefs).toMatch(/^Entidades/);
    expect(DEFAULT_ENGINE_CONFIG.teamInstructionsHeader).toMatch(/^Instrucciones/);
  });
});

describe('systemPrompt — the other half of the anti-fabrication pressure', () => {
  const sp = DEFAULT_ENGINE_CONFIG.systemPrompt;

  it('keeps its own do-not-invent and admit-the-gap clauses', () => {
    // These predate the preamble fix and carry half the pressure in the
    // assembled turn. Nothing guarded them, so they could be deleted silently.
    expect(sp).toMatch(/no inventes detalles/i);
    expect(sp).toMatch(/Si el contexto no alcanza para responder algo, dilo/i);
  });

  it('does not pin an output language, so it cannot fight the preamble', () => {
    // It used to say "Responde en español" while the preamble says "reply in
    // the user's language" — a direct conflict for any non-Spanish user, in a
    // package whose own doc claims language neutrality. `condenseSystemPrompt`
    // and `titlePrompt` were already language-adaptive; this now matches.
    expect(sp).toMatch(/mismo idioma que el usuario/i);
    expect(sp).not.toMatch(/Responde en español/i);
  });
});

describe('applyPreamble — slot substitution is not string-replace', () => {
  it('does not interpret `$&` and friends in user text', () => {
    const { messages } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [],
      summaryText: 'S',
      retrievedMatches: [],
      userMessage: 'grep -o "$&" y $` y $\' y $$1',
    });
    expect(messages.at(-1)!.content).toContain('grep -o "$&" y $` y $\' y $$1');
  });

  it('a chunk containing the literal {message} cannot swallow the question', () => {
    const { messages } = buildChatTurn({
      config: DEFAULT_ENGINE_CONFIG,
      history: [],
      summaryText: 'plantilla con {message} dentro',
      retrievedMatches: [],
      userMessage: 'LA PREGUNTA REAL',
    });
    const content = messages.at(-1)!.content;
    expect(content).toContain('LA PREGUNTA REAL');
    expect(content).toContain('plantilla con {message} dentro');
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

  /**
   * 🔴 The fail-safe stays; the SILENCE goes. A bare `catch {}` made a
   * condense outage (auth, budget, provider down) indistinguishable from a
   * condense that chose to keep the question — and retrieval then quietly ran
   * on the raw, anaphoric question.
   * Asserted on the structured `event` field, never on the log's prose.
   */
  it('falls back AND warns condense.failed with error name + status, never the message', async () => {
    const warnings = captureWarnings();
    try {
      class UpstreamError extends Error {
        status = 402;
        constructor() { super('Bearer sk-secret over budget'); this.name = 'UpstreamError'; }
      }
      const ai = fakeAIClient({ generateSync: async () => { throw new UpstreamError(); } });
      const out = await condenseQuery(ai, {
        condenseSystemPrompt: 'x', surface: 'chat', orgId: 'o', userId: 'u',
        history: [{ role: 'user', content: 'algo' }],
        question: 'pregunta original',
      });
      expect(out).toBe('pregunta original'); // the turn still runs…
      expect(warnings.events()).toEqual([ // …and the failure is visible
        { event: 'condense.failed', errorName: 'UpstreamError', status: 402 },
      ]);
      expect(warnings.raw()).not.toContain('sk-secret');
      expect(warnings.raw()).not.toContain('pregunta original');
    } finally {
      warnings.restore();
    }
  });

  it('warns condense.unusable when the rewrite is junk (under 3 chars)', async () => {
    const warnings = captureWarnings();
    try {
      const ai = fakeAIClient({
        generateSync: async () => ({
          text: '"x"', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 't',
        }),
      });
      const out = await condenseQuery(ai, {
        condenseSystemPrompt: 'x', surface: 'chat', orgId: 'o', userId: 'u',
        history: [{ role: 'user', content: 'algo' }],
        question: 'pregunta original',
      });
      expect(out).toBe('pregunta original');
      expect(warnings.events()).toEqual([{ event: 'condense.unusable' }]);
      expect(warnings.raw()).not.toContain('pregunta original');
    } finally {
      warnings.restore();
    }
  });

  it('warns nothing on a successful rewrite (positive control for the two above)', async () => {
    const warnings = captureWarnings();
    try {
      const ai = fakeAIClient({
        generateSync: async () => ({
          text: 'riesgos de Plataforma', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 't',
        }),
      });
      const out = await condenseQuery(ai, {
        condenseSystemPrompt: 'x', surface: 'chat', orgId: 'o', userId: 'u',
        history: [{ role: 'user', content: 'algo' }],
        question: 'pregunta original',
      });
      expect(out).toBe('riesgos de Plataforma');
      expect(warnings.events()).toEqual([]);
    } finally {
      warnings.restore();
    }
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

  it('drops a failing corpus (best-effort) and warns retrieve.failed', async () => {
    const warnings = captureWarnings();
    const ai = fakeAIClient({
      retrieve: async (req) => {
        if (req.corpus === 'kb-1') throw new Error('down');
        return { matches: [{ documentId: 'd', chunkId: 'ok', score: 0.5, text: 'b' }] };
      },
    });
    try {
      const out = await retrieveContext({
        aiClient: ai, orgId: 'o', fallbackScopeId: 'chat',
        corpora: [{ corpus: 'kb-1' }], threadId: 1, query: 'q',
      });
      expect(out.map((m) => m.chunkId)).toEqual(['ok']);
      expect(warnings.events()).toEqual([{ event: 'retrieve.failed', errorName: 'Error' }]);
    } finally {
      warnings.restore();
    }
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
    const warnings = captureWarnings();
    try {
      const adapter = fakeAdapter({
        scopeHierarchy: async () => { throw new Error('db down'); },
      });
      const res = await respond({ ...baseArgs(), adapter });
      expect(res.generation.text).toBe('respuesta del asistente');
      expect(res.summaryText).toBe('');
    } finally {
      warnings.restore();
    }
  });

  it('an empty or whitespace-only answer throws EmptyAnswerError, never a successful empty message', async () => {
    for (const text of ['', '  \n\t ']) {
      const ai = fakeAIClient({
        generateSync: async () => ({ text, modelUsed: 'unknown', provider: 'p', costUsd: 0, traceId: 't', finishReason: 'stop' }),
      });
      const err = await respond({ ...baseArgs(), aiClient: ai }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmptyAnswerError);
      expect((err as EmptyAnswerError).code).toBe(EMPTY_ANSWER_CODE);
      expect((err as EmptyAnswerError).finishReason).toBe('stop');
    }
  });

  it('prepareTurn alone does not call generate (router seam)', async () => {
    const ai = fakeAIClient({ generateSync: vi.fn(async () => ({ text: '', modelUsed: '', provider: '', costUsd: 0, traceId: '' })) });
    const prepared = await prepareTurn({ ...baseArgs(), aiClient: ai });
    // condense is skipped (no history) so generate is never called.
    expect(ai.generateSync).not.toHaveBeenCalled();
    expect(prepared.messages.at(-1)!.role).toBe('user');
  });
});

// ── survived failures are VISIBLE (warn.ts), and never leak text ─────────────
//
// Each spot keeps its fallback (the turn still runs) and emits exactly one
// structured warning. Asserted on the `event` code, never on log wording.
// The secret rides the error MESSAGE: it must never reach the log.

class UpstreamError extends Error {
  status = 503;
  constructor() { super('Bearer sk-secret upstream body'); this.name = 'UpstreamError'; }
}

describe('respond() — survived failures warn', () => {
  it('a throwing scopeHierarchy warns scope.failed', async () => {
    const warnings = captureWarnings();
    try {
      const adapter = fakeAdapter({ scopeHierarchy: async () => { throw new UpstreamError(); } });
      const res = await respond({ ...baseArgs(), adapter });
      expect(res.summaryText).toBe('');
      expect(warnings.events()).toEqual([
        { event: 'scope.failed', errorName: 'UpstreamError', status: 503 },
      ]);
      expect(warnings.raw()).not.toContain('sk-secret');
    } finally {
      warnings.restore();
    }
  });

  it('a throwing resolveEntity warns ref.failed once per failed ref; the others still resolve', async () => {
    const warnings = captureWarnings();
    try {
      const adapter = fakeAdapter({
        resolveEntity: async (ref) => {
          if (ref.id === 1) throw new UpstreamError();
          return 'Proyecto dos: texto resuelto';
        },
      });
      const prepared = await prepareTurn({
        ...baseArgs(),
        adapter,
        inlineRefs: [{ kind: 'project', id: 1 }, { kind: 'project', id: 2 }],
      });
      expect(prepared.messages.at(-1)!.content).toContain('Proyecto dos: texto resuelto');
      expect(warnings.events()).toEqual([
        { event: 'ref.failed', errorName: 'UpstreamError', status: 503 },
      ]);
      expect(warnings.raw()).not.toContain('sk-secret');
      expect(warnings.raw()).not.toContain('texto resuelto');
    } finally {
      warnings.restore();
    }
  });

  it('inline refs past the cap of 8 are dropped, warned ref.capped with the count, and returned as droppedRefs', async () => {
    const warnings = captureWarnings();
    try {
      const resolved: Array<number | string | undefined> = [];
      const adapter = fakeAdapter({
        resolveEntity: async (ref) => {
          resolved.push(ref.id);
          return `ref ${String(ref.id)}`;
        },
      });
      const refs = Array.from({ length: 11 }, (_, i) => ({ kind: 'project' as const, id: i + 1 }));
      const prepared = await prepareTurn({ ...baseArgs(), adapter, inlineRefs: refs });
      expect(MAX_INLINE_REFS).toBe(8);
      expect(resolved).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // the cap itself is unchanged
      expect(prepared.droppedRefs).toBe(3);
      expect(warnings.events()).toEqual([{ event: 'ref.capped', dropped: 3 }]);
      expect(warnings.raw()).not.toContain('ref 9');
    } finally {
      warnings.restore();
    }
  });

  it('droppedRefs is 0 and nothing warns at or under the cap', async () => {
    const warnings = captureWarnings();
    try {
      const refs = Array.from({ length: 8 }, (_, i) => ({ kind: 'project' as const, id: i + 1 }));
      const prepared = await prepareTurn({ ...baseArgs(), inlineRefs: refs });
      expect(prepared.droppedRefs).toBe(0);
      expect((await prepareTurn(baseArgs())).droppedRefs).toBe(0);
      expect(warnings.events()).toEqual([]);
    } finally {
      warnings.restore();
    }
  });

  it('respond() carries droppedRefs too', async () => {
    const warnings = captureWarnings();
    try {
      const refs = Array.from({ length: 9 }, (_, i) => ({ kind: 'project' as const, id: i + 1 }));
      const res = await respond({ ...baseArgs(), inlineRefs: refs });
      expect(res.droppedRefs).toBe(1);
    } finally {
      warnings.restore();
    }
  });

  it('a throwing retrieve warns retrieve.failed per failed corpus and never logs the query', async () => {
    const warnings = captureWarnings();
    try {
      const ai = fakeAIClient({
        retrieve: async (req) => {
          if (req.corpus === 'kb-down') throw new UpstreamError();
          return { matches: [{ documentId: 'd', chunkId: 'ok', score: 0.5, text: 'pasaje' }] };
        },
      });
      const out = await retrieveContext({
        aiClient: ai, orgId: 'o', fallbackScopeId: 's', threadId: 1,
        corpora: [{ corpus: 'kb-down', scopeId: 's' }],
        query: 'consulta privada del usuario',
      });
      expect(out.map((m) => m.chunkId)).toEqual(['ok']); // the healthy corpus still answers
      expect(warnings.events()).toEqual([
        { event: 'retrieve.failed', errorName: 'UpstreamError', status: 503 },
      ]);
      expect(warnings.raw()).not.toContain('consulta privada');
      expect(warnings.raw()).not.toContain('sk-secret');
    } finally {
      warnings.restore();
    }
  });

  it('a throwing title generate warns title.failed and falls back to a derived title', async () => {
    const warnings = captureWarnings();
    try {
      const ai = fakeAIClient({ generateSync: async () => { throw new UpstreamError(); } });
      const title = await generateThreadTitle(ai, {
        titlePrompt: 'x', surface: 'chat', orgId: 'o', userId: 'u',
        userText: 'presupuesto participativo de la colonia centro',
        assistantText: 'respuesta',
      });
      // Six words or fewer: the derived title is the whole message, unchanged.
      expect(title).toBe('presupuesto participativo de la colonia centro');
      expect(warnings.events()).toEqual([
        { event: 'title.failed', errorName: 'UpstreamError', status: 503 },
      ]);
      expect(warnings.raw()).not.toContain('presupuesto');
      expect(warnings.raw()).not.toContain('sk-secret');
    } finally {
      warnings.restore();
    }
  });

  it.each([
    ['text in the name', 'Bearer sk-secret leaked'],
    ['punctuation', 'Error: sk-secret'],
    ['over 64 chars', 'A'.repeat(65)],
    ['empty', ''],
  ])('replaces an unsafe Error.name (%s) instead of logging it', async (_label, badName) => {
    const warnings = captureWarnings();
    try {
      const err = new Error('boom');
      err.name = badName;
      const adapter = fakeAdapter({ scopeHierarchy: async () => { throw err; } });
      await respond({ ...baseArgs(), adapter });
      expect(warnings.events()).toEqual([{ event: 'scope.failed', errorName: 'UnsafeErrorName' }]);
      expect(warnings.raw()).not.toContain('sk-secret');
      if (badName) expect(warnings.raw()).not.toContain(badName);
    } finally {
      warnings.restore();
    }
  });

  it('keeps a safe Error.name of 64 chars (positive control for the filter)', async () => {
    const warnings = captureWarnings();
    try {
      const err = new Error('boom');
      err.name = `Upstream_${'A'.repeat(55)}`;
      const adapter = fakeAdapter({ scopeHierarchy: async () => { throw err; } });
      await respond({ ...baseArgs(), adapter });
      expect(warnings.events()).toEqual([{ event: 'scope.failed', errorName: err.name }]);
    } finally {
      warnings.restore();
    }
  });

  it('a clean turn with refs, corpora and history warns nothing (positive control)', async () => {
    const warnings = captureWarnings();
    try {
      const adapter = fakeAdapter({
        scopeHierarchy: async () => ({ summaryText: 'S', corpora: [{ corpus: 'kb', scopeId: 's' }] }),
        resolveEntity: async () => 'ref text',
      });
      const ai = fakeAIClient({
        generateSync: async () => ({ text: 'consulta condensada', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 't' }),
      });
      await respond({
        ...baseArgs(), adapter, aiClient: ai,
        history: [{ role: 'user', content: 'hola' }],
        inlineRefs: [{ kind: 'project', id: 1 }],
      });
      await generateThreadTitle(ai, {
        titlePrompt: 'x', surface: 'chat', orgId: 'o', userId: 'u', userText: 'hola', assistantText: 'hola',
      });
      expect(warnings.events()).toEqual([]);
    } finally {
      warnings.restore();
    }
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

  // 🔴 Sync REJECTS on failure (0.5.0, backlog 275). Before, every error was
  // caught inside, so a consumer's `.catch` could never fire and a dead ingest
  // path looked identical to "nothing to sync". The write path stays safe only
  // if the CALLER chooses fire-and-forget with its own `.catch`.
  const batch = (corpus: string, id: string) => ({
    orgId: 'o', scopeId: 's', corpus,
    documents: [{ id, title: 't', text: 'contenido privado', metadata: {} }],
  });

  it('syncEntity rejects when ingest fails, after attempting every batch', async () => {
    const warnings = captureWarnings();
    try {
      const attempted: string[] = [];
      const ai = fakeAIClient({
        ingest: async (req) => {
          attempted.push(req.corpus);
          if (req.corpus === 'down') throw new UpstreamError();
          return { ingested: req.documents.length, documentIds: [] };
        },
      });
      const source = {
        docsForEntity: async () => [batch('down', 'a'), batch('up', 'b')],
        entitiesInScope: async () => [],
      };
      const err = await syncEntity(ai, source, { kind: 'team', id: 1 }).then(
        () => { throw new Error('expected syncEntity to reject'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CorpusSyncError);
      expect(err).toMatchObject({
        synced: 1, // the healthy batch still went in
        failures: [{ event: 'sync.ingest.failed', errorName: 'UpstreamError', status: 503 }],
      });
      // cause is SANITIZED: name + status, never the upstream error object.
      expect((err as Error).cause).toEqual({
        event: 'sync.ingest.failed', errorName: 'UpstreamError', status: 503,
      });
      // What `console.error(err)` would print in a consumer:
      expect(inspect(err, { depth: 10, showHidden: true })).not.toContain('sk-secret');
      expect(attempted).toEqual(['down', 'up']);
      expect(String((err as Error).message)).not.toContain('sk-secret');
      expect(warnings.events()).toEqual([
        { event: 'sync.ingest.failed', errorName: 'UpstreamError', status: 503 },
      ]);
      expect(warnings.raw()).not.toContain('contenido privado');
    } finally {
      warnings.restore();
    }
  });

  it('syncEntity rejects when the entity source fails', async () => {
    const warnings = captureWarnings();
    try {
      const source = {
        docsForEntity: async () => { throw new UpstreamError(); },
        entitiesInScope: async () => [],
      };
      await expect(syncEntity(fakeAIClient(), source, { kind: 'team', id: 1 })).rejects.toMatchObject({
        name: 'CorpusSyncError',
        synced: 0,
        failures: [{ event: 'sync.docs.failed', errorName: 'UpstreamError', status: 503 }],
      });
      expect(warnings.events()).toEqual([
        { event: 'sync.docs.failed', errorName: 'UpstreamError', status: 503 },
      ]);
    } finally {
      warnings.restore();
    }
  });

  it('backfillScope rejects when entitiesInScope fails', async () => {
    const warnings = captureWarnings();
    try {
      const source = {
        docsForEntity: async () => [],
        entitiesInScope: async () => { throw new UpstreamError(); },
      };
      await expect(backfillScope(fakeAIClient(), source, 's')).rejects.toMatchObject({
        name: 'CorpusSyncError',
        failures: [{ event: 'backfill.entities.failed', errorName: 'UpstreamError', status: 503 }],
      });
    } finally {
      warnings.restore();
    }
  });

  it('backfillScope keeps going past a failing entity, then rejects with the totals', async () => {
    const warnings = captureWarnings();
    try {
      const ingested: string[] = [];
      const ai = fakeAIClient({
        ingest: async (req) => {
          if (req.documents[0]!.id === 't:2') throw new UpstreamError();
          ingested.push(req.documents[0]!.id!);
          return { ingested: 1, documentIds: [] };
        },
      });
      const source = {
        docsForEntity: async (ref: { id?: string | number }) => [batch('c', `t:${ref.id}`)],
        entitiesInScope: async () => [1, 2, 3].map((id) => ({ kind: 'team' as const, id })),
      };
      await expect(backfillScope(ai, source, 's')).rejects.toMatchObject({
        name: 'CorpusSyncError',
        synced: 2,
        failures: [{ event: 'sync.ingest.failed', errorName: 'UpstreamError', status: 503 }],
      });
      expect(ingested).toEqual(['t:1', 't:3']);
    } finally {
      warnings.restore();
    }
  });

  it('a clean sync and backfill resolve and warn nothing (positive control)', async () => {
    const warnings = captureWarnings();
    try {
      const source = {
        docsForEntity: async (ref: { id?: string | number }) => [batch('c', `t:${ref.id}`)],
        entitiesInScope: async () => [{ kind: 'team' as const, id: 1 }],
      };
      await expect(syncEntity(fakeAIClient(), source, { kind: 'team', id: 1 })).resolves.toEqual({ synced: 1 });
      await expect(backfillScope(fakeAIClient(), source, 's')).resolves.toEqual({ entities: 1, docs: 1 });
      expect(warnings.events()).toEqual([]);
    } finally {
      warnings.restore();
    }
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

describe('fuseMatches — vectorRanked (a hybrid list keeps its server order)', () => {
  // Hybrid scores are per-corpus RRF values: 'b' scores higher than 'a' but
  // the server ranked 'a' first. Re-sorting by score would invert that.
  const hybrid = [chunk('a', 0.016), chunk('b', 0.033), chunk('c', 0.01)];

  it('with an empty graph list, returns the given order, only capped', () => {
    expect(fuseMatches(hybrid, [], { vectorRanked: true }).map((m) => m.chunkId))
      .toEqual(['a', 'b', 'c']);
    expect(fuseMatches(hybrid, [], { vectorRanked: true, mergedCap: 2 }).length).toBe(2);
  });

  it('with graph entries, ranks the vector leg by position, not score', () => {
    const fused = fuseMatches(hybrid, [chunk('g', 0.9)], { vectorRanked: true });
    // 'a' (position 1) and 'g' (graph rank 1) tie on RRF; the vector leg wins
    // the tie-break. 'b' stays ahead of 'c' by position.
    expect(fused.map((m) => m.chunkId)).toEqual(['a', 'g', 'b', 'c']);
  });
});

describe('prepareTurn — graphProvider on a hybrid policy', () => {
  const policy = { mode: 'hybrid' as const, perCorpusTopK: 5, limit: 12 };
  const serverOrder = [
    { documentId: 'd1', chunkId: 'h1', score: 0.016, text: 'H1', corpus: 'kb', denseScore: 0.4 },
    { documentId: 'd2', chunkId: 'h2', score: 0.033, text: 'H2', corpus: 'kb', denseScore: 0.7 },
  ];
  const ai = () =>
    fakeAIClient({
      retrieveMulti: async () => ({ matches: serverOrder, corpora: [] }),
    });

  it('without graph chunks, keeps the server order untouched', async () => {
    const prepared = await prepareTurn({
      ...baseArgs(),
      aiClient: ai(),
      retrievalPolicy: policy,
      graphProvider: async () => ({ context: 'BLOQUE' }),
    });
    expect(prepared.matches.map((m) => m.chunkId)).toEqual(['h1', 'h2']);
    expect(prepared.graphContext).toBe('BLOQUE');
  });

  it('fuses graph chunks by server order and keeps maxDenseScore on the retrieved leg', async () => {
    const prepared = await prepareTurn({
      ...baseArgs(),
      aiClient: ai(),
      retrievalPolicy: policy,
      graphProvider: async () => ({
        chunks: [{ documentId: 'd9', chunkId: 'g1', score: 0.99, text: 'G', corpus: 'kb' }],
      }),
    });
    expect(prepared.matches.map((m) => m.chunkId)).toEqual(['h1', 'g1', 'h2']);
    // The graph chunk's bare 0.99 must not be read as a cosine.
    expect(prepared.maxDenseScore).toBe(0.7);
  });

  it('a rejecting provider warns graph.failed and degrades to the plain turn', async () => {
    const warnings = captureWarnings();
    try {
      const prepared = await prepareTurn({
        ...baseArgs(),
        aiClient: ai(),
        retrievalPolicy: policy,
        graphProvider: async () => { throw new Error('graph down'); },
      });
      expect(prepared.matches.map((m) => m.chunkId)).toEqual(['h1', 'h2']);
      expect(warnings.events()).toEqual([{ event: 'graph.failed', errorName: 'Error' }]);
    } finally {
      warnings.restore();
    }
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

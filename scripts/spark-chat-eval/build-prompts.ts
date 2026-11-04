/**
 * Assemble the EXACT chat prompts dev would send for each turn in `turns.ts`.
 *
 * Reuses the production pieces, not copies:
 *   · `prepareTurn` from @edc/chat-engine (condense → summary → retrieve → user turn)
 *   · apps/web's system prompts (`prompt.ts`, cite variant E = dev default),
 *     turn-mode rule (`turnMode.ts`), chunk fence (`chunkFence.ts`),
 *     orientation block (`orientation.ts`), rerank policy (`rerank.ts`)
 *   · the backend eval's AIClient (`apps/backend/src/eval/engine.ts`), which
 *     reproduces the web client's retrieve/generate wire against dev ai-service.
 *
 * Deliberate gaps vs. a live dev turn (stated in the results file):
 *   · no GraphRAG block, no query expansion, no title-match pin, no attached
 *     documents; the summary names only the ecosistema.
 *
 * Condense runs for real on the hosted `quick` tier through dev ai-service
 * (the app's own path); its messages and output are recorded so run.py can
 * replay the same condense prompt on the Spark.
 *
 * Usage (from the repo root; dev ai-service tunnelled to localhost):
 *   EVAL_AI_URL=http://localhost:45591 EVAL_AI_KEY_FILE=<file> \
 *   EVAL_MESSAGES=<messages.json> EVAL_ORGS=<orgs.json> EVAL_OUT=<prompts.json> \
 *   apps/web/node_modules/.bin/tsx scripts/spark-chat-eval/build-prompts.ts
 *
 * messages.json / orgs.json: json_agg dumps of dev `messages` (id, role, content)
 * and `organizations` (id, name, description) from edc_backend.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { DEFAULT_ENGINE_CONFIG, prepareTurn, type EngineConfig } from '../../packages/chat-engine/dist/core/index.js';
import { makeEvalAIClient, makeEvalAdapter } from '../../apps/backend/src/eval/engine.ts';
import {
  chatSystemPrompt,
  interviewSystemPrompt,
  INTERVIEW_CONTEXT_PREAMBLE,
  parseCiteVariant,
} from '../../apps/web/src/lib/server/engine/prompt.ts';
import { chatTurnMode } from '../../apps/web/src/lib/server/engine/turnMode.ts';
import { withFencedChunks, withFencedRefs } from '../../apps/web/src/lib/server/engine/chunkFence.ts';
import {
  fetchOrientationTurns,
  orientationBlock,
  parseOrientScope,
  withOrientation,
} from '../../apps/web/src/lib/server/engine/orientation.ts';
import { chatRetrievalPolicy, parseRerankFlag } from '../../apps/web/src/lib/server/engine/rerank.ts';
import { metadataFilterInAvailable } from '../../apps/web/src/lib/server/engine/hybrid.ts';
import { TURNS } from './turns.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const aiUrl = need('EVAL_AI_URL');
const aiKey = readFileSync(need('EVAL_AI_KEY_FILE'), 'utf8').trim();
const messages = JSON.parse(readFileSync(need('EVAL_MESSAGES'), 'utf8')) as Array<{ id: number; role: string; content: string }>;
const orgs = JSON.parse(readFileSync(need('EVAL_ORGS'), 'utf8')) as Array<{ id: number; name: string; description: string | null }>;
const byId = new Map(messages.map((m) => [m.id, m]));
const ORG_KEY = 'demo'; // dev web's ORG_KEY (measured 2026-10-26, printenv)
const PASSAGE_TEXT_CAP = 1200;

// Dev web runs every flag at its default (CHAT_* / QUERY_EXPANSION unset, measured 2026-10-26).
const citeVariant = parseCiteVariant(undefined);
const answerConfig: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, surface: 'chat', systemPrompt: chatSystemPrompt(citeVariant) };
const interviewConfig: EngineConfig = {
  ...answerConfig,
  systemPrompt: interviewSystemPrompt(),
  userContextPreamble: INTERVIEW_CONTEXT_PREAMBLE,
};
const kindFilter = await metadataFilterInAvailable(aiUrl, aiKey);
const policy = chatRetrievalPolicy(parseRerankFlag(undefined), 'dense');
const orientScope = parseOrientScope(undefined);

/** `buildChatUnitRequest`'s partition (apps/web wire.ts; same as eval/engine.ts). */
function partition(msgs: Array<{ role: string; content: string }>) {
  let i = 0;
  const sys: string[] = [];
  for (; i < msgs.length && msgs[i]!.role === 'system'; i += 1) sys.push(msgs[i]!.content);
  const rest = msgs.slice(i);
  const only = rest.length === 1 ? rest[0] : undefined;
  const userPrompt =
    only && only.role === 'user'
      ? only.content
      : `${rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n')}\n\n` + 'Responde como el asistente para el último turno del usuario.';
  return { systemPrompt: sys.join('\n\n').trim(), userPrompt };
}

const out: unknown[] = [];
const asOf = new Date().toISOString();
for (const t of TURNS) {
  const org = orgs.find((o) => o.id === t.org)!;
  const corpus = `eco-${t.org}`;
  const userMessage = typeof t.message === 'number' ? byId.get(t.message)!.content : t.message;
  const history = t.history.map((id) => {
    const m = byId.get(id)!;
    return { role: m.role as 'user' | 'assistant', content: m.content };
  });
  const sessionId = `spark-eval-${t.id}`;
  const base = makeEvalAIClient({
    env: { aiServiceUrl: aiUrl, aiServiceApiKey: aiKey } as never,
    organizationId: t.org,
    asOf,
    allowedCorpora: [corpus],
    unitKeyFor: () => `${sessionId}-${Date.now()}`,
  });
  const fenced = withFencedChunks(base, { kindFilter }).client;
  let condense: { messages: unknown; hostedText: string; ms: number } | null = null;
  const client = {
    ...fenced,
    async generateSync(req: Parameters<typeof fenced.generateSync>[0]) {
      const started = Date.now();
      const r = await fenced.generateSync(req);
      condense = { messages: req.messages, hostedText: r.text, ms: Date.now() - started };
      return r;
    },
  };
  const adapter = withOrientation(
    withFencedRefs(makeEvalAdapter({ organizationName: org.name, organizationDescription: org.description, corpora: [corpus] })),
    fetchOrientationTurns({
      client: base,
      scope: orientScope,
      corpus,
      orgId: ORG_KEY,
      sessionId,
      userId: null,
      query: userMessage,
    }).then(orientationBlock),
  );
  const mode = chatTurnMode({ userMessage, history });
  const prepared = await prepareTurn({
    config: mode === 'answer' ? answerConfig : interviewConfig,
    aiClient: client,
    adapter,
    orgId: ORG_KEY,
    userId: 'spark-eval',
    scopeId: sessionId,
    threadId: sessionId,
    scope: { refs: [{ kind: 'org' }] },
    history,
    userMessage,
    ...(policy ? { retrievalPolicy: policy } : {}),
    includePassageText: PASSAGE_TEXT_CAP,
  } as never);
  const wire = partition(prepared.messages);
  const chunks = (prepared.provenance?.chunks ?? []).length;
  out.push({ id: t.id, kind: t.kind, org: t.org, mode, userMessage, retrievalQuery: prepared.retrievalQuery, chunks, condense, ...wire });
  console.log(`${t.id} mode=${mode} chunks=${chunks} chars=${wire.systemPrompt.length + wire.userPrompt.length} q=${prepared.retrievalQuery.slice(0, 70)}`);
}
writeFileSync(need('EVAL_OUT'), JSON.stringify({ asOf, citeVariant, kindFilter, turns: out }, null, 2));

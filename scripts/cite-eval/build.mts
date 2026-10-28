/**
 * Before/after prompts for the citation-accuracy re-baseline (2026-10-28).
 * Retrieval: dev ai-service (embeddings + rerank on the Spark). Condense: the
 * hosted rewrite recorded on 2026-10-26 is REPLAYED, never called (no paid call).
 *
 * Usage (repo root; dev ai-service tunnelled, see plan/spark-chat-eval-2026-10-26.md):
 *   git show 30fc152:apps/web/src/lib/server/engine/prompt.ts > /tmp/x/prompt-main.ts
 *   EVAL_AI_URL=http://localhost:45591 EVAL_OLD_DIR=<10-26 run dir> EVAL_MAIN_PROMPT=/tmp/x/prompt-main.ts \
 *   EVAL_OUT=prompts.json apps/backend/node_modules/.bin/tsx scripts/cite-eval/build.mts
 *   SPARK_URL=<Spark proxy URL, required> SPARK_TOKEN_FILE=<file> python3 -I scripts/cite-eval/cite_eval.py prompts.json results.jsonl 3
 *   python3 -I scripts/cite-eval/agg.py results.jsonl
 * before = main 30fc152 (chunk per [N], no titles); after = fix/chat-answers
 * (regroupTurn: one [N] per document, "Título:" line, new CHUNK_DATA_RULE).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_ENGINE_CONFIG, prepareTurn, type EngineConfig } from '../../packages/chat-engine/dist/core/index.js';
import { makeEvalAIClient, makeEvalAdapter } from '../../apps/backend/src/eval/engine.ts';
import { chatSystemPrompt } from '../../apps/web/src/lib/server/engine/prompt.ts';
import { regroupTurn } from '../../apps/web/src/lib/server/engine/sources.ts';
import { chatTurnMode } from '../../apps/web/src/lib/server/engine/turnMode.ts';
import { withFencedChunks, withFencedRefs } from '../../apps/web/src/lib/server/engine/chunkFence.ts';
import { fetchOrientationTurns, orientationBlock, withOrientation } from '../../apps/web/src/lib/server/engine/orientation.ts';
import { chatRetrievalPolicy, parseRerankFlag } from '../../apps/web/src/lib/server/engine/rerank.ts';
import { metadataFilterInAvailable } from '../../apps/web/src/lib/server/engine/hybrid.ts';
import { TURNS } from './turns.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
/** The 2026-10-26 run's dir: ai_key, messages.json, orgs.json, prompts.json (recorded condense). */
const OLD = need('EVAL_OLD_DIR');
/** main's `prompt.ts` (git show 30fc152:…), the "before" system prompt. */
const { chatSystemPrompt: mainSystemPrompt } = (await import(need('EVAL_MAIN_PROMPT'))) as { chatSystemPrompt: (v: string) => string };
const aiUrl = need('EVAL_AI_URL');
const aiKey = readFileSync(`${OLD}/ai_key`, 'utf8').trim();
const messages = JSON.parse(readFileSync(`${OLD}/messages.json`, 'utf8')) as Array<{ id: number; role: string; content: string }>;
const orgs = JSON.parse(readFileSync(`${OLD}/orgs.json`, 'utf8')) as Array<{ id: number; name: string; description: string | null }>;
const recorded = new Map((JSON.parse(readFileSync(`${OLD}/prompts.json`, 'utf8')).turns as Array<{ id: string; condense: { hostedText: string } | null }>).map((t) => [t.id, t.condense?.hostedText ?? null]));
const byId = new Map(messages.map((m) => [m.id, m]));
const ORG_KEY = 'demo';
const config: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, surface: 'chat', systemPrompt: chatSystemPrompt('E') };
const kindFilter = await metadataFilterInAvailable(aiUrl, aiKey);
const policy = chatRetrievalPolicy(parseRerankFlag(undefined), 'dense');

function partition(msgs: Array<{ role: string; content: string }>) {
  let i = 0;
  const sys: string[] = [];
  for (; i < msgs.length && msgs[i]!.role === 'system'; i += 1) sys.push(msgs[i]!.content);
  const rest = msgs.slice(i);
  const only = rest.length === 1 ? rest[0] : undefined;
  const userPrompt = only && only.role === 'user' ? only.content
    : `${rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n')}\n\n` + 'Responde como el asistente para el último turno del usuario.';
  return { systemPrompt: sys.join('\n\n').trim(), userPrompt };
}
const unfence = (t: string) => t.replace(/^<fuente>\n/, '').replace(/\n<\/fuente>$/, '');

const out: unknown[] = [];
const asOf = new Date().toISOString();
for (const t of TURNS) {
  if (t.kind === 'story') continue; // citation accuracy: answering turns only
  const org = orgs.find((o) => o.id === t.org)!;
  const corpus = `eco-${t.org}`;
  const userMessage = typeof t.message === 'number' ? byId.get(t.message)!.content : t.message;
  const history = t.history.map((id) => ({ role: byId.get(id)!.role as 'user' | 'assistant', content: byId.get(id)!.content }));
  const sessionId = `spark-eval-${t.id}`;
  const base = makeEvalAIClient({ env: { aiServiceUrl: aiUrl, aiServiceApiKey: aiKey } as never, organizationId: t.org, asOf, allowedCorpora: [corpus], unitKeyFor: () => `${sessionId}-${Date.now()}` });
  const fenced = withFencedChunks(base, { kindFilter }).client;
  const client = {
    ...fenced,
    async generateSync() {
      const text = recorded.get(t.id);
      if (!text) throw new Error(`no recorded condense for ${t.id}: refusing a paid call`);
      return { text, costUsd: 0, modelUsed: 'replay', provider: 'replay', traceId: 'replay' };
    },
  };
  const adapter = withOrientation(
    withFencedRefs(makeEvalAdapter({ organizationName: org.name, organizationDescription: org.description, corpora: [corpus] })),
    fetchOrientationTurns({ client: base, scope: 'ecosistema', corpus, orgId: ORG_KEY, sessionId, userId: null, query: userMessage }).then(orientationBlock),
  );
  const mode = chatTurnMode({ userMessage, history });
  const prepared = await prepareTurn({ config, aiClient: client, adapter, orgId: ORG_KEY, userId: 'spark-eval', scopeId: sessionId, threadId: sessionId, scope: { refs: [{ kind: 'org' }] }, history, userMessage, ...(policy ? { retrievalPolicy: policy } : {}), includePassageText: 1200 } as never);
  const beforeMsgs = prepared.messages.map((m, i) => (i === 0 ? { ...m, content: mainSystemPrompt('E') } : m));
  const before = partition(beforeMsgs);
  const beforePassages = prepared.matches.map((m) => unfence(m.text));
  const beforeDocs = prepared.matches.map((m) => String(m.metadata?.docId ?? m.documentId));
  const re = regroupTurn(prepared, { config, passageCap: 1200 });
  const after = partition(re.messages);
  const groups: number[][] = [];
  const seen = new Map<string, number>();
  prepared.matches.forEach((m, i) => { const k = String(m.metadata?.docId ?? m.documentId); if (!seen.has(k)) { seen.set(k, groups.length); groups.push([]); } groups[seen.get(k)!]!.push(i); });
  const afterPassages = groups.map((g) => [...new Set(g.map((i) => beforePassages[i]!))].join('\n\n…\n\n'));
  const afterDocs = groups.map((g) => beforeDocs[g[0]!]!);
  out.push({ id: t.id, kind: t.kind, org: t.org, mode, userMessage, before: { ...before, passages: beforePassages, docs: beforeDocs }, after: { ...after, passages: afterPassages, docs: afterDocs } });
  console.log(`${t.id} mode=${mode} chunks=${prepared.matches.length} docs=${groups.length}`);
}
writeFileSync(need('EVAL_OUT'), JSON.stringify({ asOf, kindFilter, turns: out }, null, 2));

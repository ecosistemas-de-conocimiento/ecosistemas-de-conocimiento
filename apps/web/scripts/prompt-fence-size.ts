/**
 * Prompt-size cost of the chunk fence (audit 2026-10-17 §3 item 3).
 *
 * Builds one chat turn with the real engine `prepareTurn` on a hermetic
 * fixture — no network, no model — twice: without the fence and the data rule,
 * then with them. Prints characters and tokens for system + user messages.
 *
 *   cd apps/web
 *   node ../../node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs scripts/prompt-fence-size.ts [chunkChars] [--no-ref]
 *
 * Fixture: 8 retrieved chunks (the chat policy's merged limit) of `chunkChars`
 * characters (default 1350, about a median eval prompt of 11,283 chars / 8,
 * quoted from apps/backend/src/eval/results.json), UUID chunk ids, and (unless `--no-ref`) one @-mentioned document of
 * 3,500 chars.
 *
 * Tokens: `cl100k_base` via js-tiktoken, a PROXY — the chat model's own
 * tokenizer is not available locally. js-tiktoken is only a transitive
 * dependency here, so it is loaded from pnpm's hoisted folder; without it the
 * script prints characters only.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { DEFAULT_ENGINE_CONFIG, prepareTurn } from '@edc/chat-engine/core';
import type { AIClient, DomainAdapter, RetrieveMatch } from '@edc/chat-engine/core';
import { withFencedChunks, withFencedRefs } from '../src/lib/server/engine/chunkFence';
import { CHAT_SYSTEM_PROMPT, CHUNK_DATA_RULE } from '../src/lib/server/engine/prompt';

type Encode = (s: string) => number;
function loadTokenizer(): Encode | null {
  const hoisted = path.resolve(import.meta.dirname, '../../../node_modules/.pnpm/node_modules/');
  for (const base of [import.meta.filename, path.join(hoisted, 'x.js')]) {
    try {
      const { getEncoding } = createRequire(base)('js-tiktoken');
      const enc = getEncoding('cl100k_base');
      return (s) => enc.encode(s).length;
    } catch {
      /* try the next */
    }
  }
  return null;
}

const args = process.argv.slice(2);
const withRef = !args.includes('--no-ref');
const chunkChars = Number(args.find((a) => /^\d+$/.test(a)) ?? 1350);
const PARA =
  'En la comunidad, las personas mayores contaron que el acceso a intérpretes en el ' +
  'hospital regional era escaso y que las familias debían traducir. ';
const fill = (n: number) => PARA.repeat(Math.ceil(n / PARA.length)).slice(0, n);
// Random-looking UUID v4 ids from a seeded generator, so runs are comparable.
// (A patterned id like `…1a2b3c4d5e01` tokenizes ~40% longer than a random one.)
let seed = 42;
const hex = (n: number) =>
  Array.from({ length: n }, () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) >> 16) % 16)
    .map((d) => d.toString(16))
    .join('');
const id = (_i: number) => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const matches: RetrieveMatch[] = Array.from({ length: 8 }, (_, i) => ({
  documentId: `d${i}`,
  chunkId: id(i),
  score: 0.8,
  text: fill(chunkChars),
  metadata: { kind: 'documento' },
}));
const client: AIClient = {
  async generateSync() {
    return { text: '', modelUsed: '', provider: '', costUsd: 0, traceId: '' };
  },
  async retrieve(r) {
    return { matches: r.corpus === 'pub:1' ? matches : [] };
  },
  async ingest() {
    return { ingested: 0, documentIds: [] };
  },
};
const adapter = {
  async scopeHierarchy() {
    return { summaryText: 'Ecosistema: prueba.', corpora: [{ corpus: 'pub:1' }] };
  },
  async resolveEntity() {
    return `Documento adjunto: informe.pdf\n${fill(3500)}`;
  },
} as unknown as DomainAdapter;

const OLD_SYSTEM = CHAT_SYSTEM_PROMPT.replace(CHUNK_DATA_RULE + '\n\n', '');

async function measure(aiClient: AIClient, a: DomainAdapter, systemPrompt: string, encode: Encode | null) {
  const p = await prepareTurn({
    config: { ...DEFAULT_ENGINE_CONFIG, systemPrompt },
    aiClient,
    adapter: a,
    orgId: 'o',
    userId: 'u',
    scopeId: 's',
    threadId: 's',
    scope: { refs: [{ kind: 'org' }] },
    history: [],
    userMessage: '¿Qué dicen sobre intérpretes?',
    inlineRefs: withRef ? [{ kind: 'document', id: '11' }] : [],
  });
  const all = p.messages.map((m) => m.content).join('\n');
  return { chars: all.length, tokens: encode ? encode(all) : null };
}

const encode = loadTokenizer();
const before = await measure(client, adapter, OLD_SYSTEM, encode);
const after = await measure(
  withFencedChunks(client).client,
  withFencedRefs(adapter),
  CHAT_SYSTEM_PROMPT,
  encode,
);
const pct = (a: number, b: number) => `${(((a - b) / b) * 100).toFixed(1)}%`;
console.log(JSON.stringify({ chunkChars, withRef, tokenizer: encode ? 'cl100k_base (proxy)' : 'unavailable', before, after }));
console.log(
  `delta: +${after.chars - before.chars} chars (${pct(after.chars, before.chars)})` +
    (before.tokens != null && after.tokens != null
      ? `, +${after.tokens - before.tokens} tokens (${pct(after.tokens, before.tokens)})`
      : ''),
);

// TEST-ONLY fake model provider. NEVER SHIPPED.
//
// A tiny HTTP server that speaks the three OpenRouter API shapes ai-service
// calls: chat completions (plain and SSE streaming) and embeddings. Point
// ai-service at it with `CHAT_COMPLETIONS_URL` and `EMBEDDINGS_URL`, and the
// service runs its REAL code path end to end — budget, cache, PII egress
// scrub, traces — against a provider that costs nothing and needs no key.
//
// It replaces the in-service `MOCK_LLM` / `MOCK_LLM_STREAM` / `MOCK_EMBEDDINGS`
// switches, removed: fake output must never be producible by the
// shipped service itself. This file lives OUTSIDE `src/`, so `tsc` never emits
// it into `dist/`, and `.dockerignore` keeps `test-support/` out of the image's
// build context. See README.md here.
//
// Everything it returns is MARKED as test data:
//   - every completion body starts with `[FAKE-PROVIDER TEST DATA]`, except a
//     reply the request scripted with `[[FAKE_REPLY:<base64>]]`;
//   - every response carries the header `x-fake-provider: test-data`;
//   - every JSON body carries `provider: "fake-provider"` and an `id` starting
//     `fake-provider-`.
//
// Zero dependencies (node:http only) so a consumer can run it with plain
// `node` from an ai-service checkout. Typings: `server.d.mts`.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_PROVIDER_MARKER = '[FAKE-PROVIDER TEST DATA]';
export const FAKE_PROVIDER_HEADER = 'x-fake-provider';
export const FAKE_PROVIDER_API_KEY = 'fake-provider-test-key';

const DEFAULTS = {
  bodyTokens: 200,
  streamTokensPerSec: 0,
  streamFirstDelayMs: 0,
  embeddingDim: 1024,
  embeddingDelayMs: 0,
  costUsd: 0,
};

/** Characters per token: the chars/4 heuristic the rest of ai-service uses. */
const CHARS_PER_TOKEN = 4;

const WORDS = [
  'fake', 'provider', 'test', 'data', 'this', 'text', 'was', 'not', 'written',
  'by', 'any', 'model', 'it', 'exists', 'so', 'tests', 'can', 'exercise',
  'the', 'real', 'service', 'path',
];

/**
 * Per-request length directive: `[[FAKE_OUTPUT_TOKENS:<n>]]` anywhere in a
 * message. Two tests in one run can then ask for different lengths from one
 * fake provider. The LAST well-formed directive wins; n is clamped to
 * [1, 20000].
 */
const DIRECTIVE = /\[\[FAKE_OUTPUT_TOKENS:(\d+)\]\]/g;

function directiveTokens(messages) {
  let found;
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = typeof m?.content === 'string' ? m.content : '';
    for (const match of content.matchAll(DIRECTIVE)) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0) found = Math.min(20000, Math.floor(n));
    }
  }
  return found;
}

/**
 * Per-request scripted reply: `[[FAKE_REPLY:<base64 of UTF-8 text>]]` anywhere
 * in a message makes the completion body EXACTLY that decoded text, with no
 * marker, so a consumer e2e can test a path that parses model JSON (for
 * example a PII detector answering `{"spans":[]}`). Base64, not raw JSON, so
 * `]]` in the reply cannot end the directive and the service-side PII egress
 * scrub cannot rewrite it. Standard or URL-safe alphabet. The LAST directive
 * wins. `max_tokens` still cuts it (chars/4), and the response header and `id`
 * still mark it as test data. It lives only in this test-only server: the real
 * provider sees the directive as plain prompt text.
 */
const REPLY_DIRECTIVE = /\[\[FAKE_REPLY:([A-Za-z0-9+/_-]*={0,2})\]\]/g;

function directiveReply(messages) {
  let found;
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = typeof m?.content === 'string' ? m.content : '';
    for (const match of content.matchAll(REPLY_DIRECTIVE)) {
      found = Buffer.from(match[1], 'base64').toString('utf8');
    }
  }
  return found;
}

/** The marked body, `tokens` tokens long by the chars/4 heuristic. */
export function fakeBodyText(tokens) {
  const target = Math.max(1, tokens) * CHARS_PER_TOKEN;
  let text = FAKE_PROVIDER_MARKER;
  let i = 0;
  while (text.length < target) {
    text += ' ' + WORDS[i % WORDS.length];
    i++;
  }
  return text.slice(0, target);
}

function promptTokensOf(messages) {
  let chars = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    chars += String(m?.role ?? '').length + String(m?.content ?? '').length + 4;
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** FNV-1a, 32-bit. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercased, accent-free words: `¿Alcaldía, OK?` → `['alcaldia', 'ok']`. */
export function fakeTokens(text) {
  return (
    String(text)
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Deterministic, unit-length, hashed bag-of-words vector for one input.
 *
 * Each word adds 1, and each adjacent word pair adds 0.5, to the slot its
 * FNV-1a hash picks; a second hash bit picks the sign, so collisions cancel out
 * on average instead of piling up. The sum is then L2-normalised. Texts that
 * share words therefore land close in cosine space, and a query retrieves the
 * document it is about. Same text in, byte-identical vector out, so a test can
 * seed a chunk with `fakeEmbedOne(text)` and a query for `text` scores 1.0.
 * Text with no words (empty, punctuation only) hashes as one raw feature, so
 * it still gets a unit vector.
 */
export function fakeEmbedOne(text, dim = DEFAULTS.embeddingDim) {
  const words = fakeTokens(text);
  const features = words.length === 0 ? [[`raw:${text}`, 1]] : words.map((w) => [w, 1]);
  for (let i = 1; i < words.length; i++) features.push([`${words[i - 1]} ${words[i]}`, 0.5]);
  const vec = new Array(dim).fill(0);
  for (const [feature, weight] of features) {
    const h = fnv1a(feature);
    vec[h % dim] += h & 0x80000000 ? -weight : weight;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  // A whole-text cancellation (two features, same slot, opposite signs) is
  // the one way to reach zero; fall back to a fixed unit axis.
  if (norm === 0) vec[fnv1a(String(text)) % dim] = 1;
  else for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Sleep that resolves `false` early when the client has gone away. */
function sleep(ms, res) {
  if (ms <= 0) return Promise.resolve(!res.destroyed);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      res.off('close', onClose);
      resolve(!res.destroyed);
    }, ms);
    res.once('close', onClose);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    [FAKE_PROVIDER_HEADER]: 'test-data',
  });
  res.end(JSON.stringify(body));
}

/**
 * Start a fake provider.
 *
 * @param {object} [options] see `server.d.mts` for every field.
 * @returns {Promise<import('./server.d.mts').FakeProvider>}
 */
export async function startFakeProvider(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const requests = [];
  let seq = 0;
  let chatSeq = 0;

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    try {
      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return sendJson(res, 200, { ok: true, provider: 'fake-provider' });
      }
      if (req.method !== 'POST') return sendJson(res, 404, { error: { message: 'not found' } });
      const body = await readJson(req);
      const id = `fake-provider-${++seq}`;

      if (path.endsWith('/chat/completions')) {
        requests.push({ kind: 'chat', body });
        return await chat(body, id, res);
      }
      if (path.endsWith('/embeddings')) {
        requests.push({ kind: 'embeddings', body });
        return await embeddings(body, id, res);
      }
      return sendJson(res, 404, { error: { message: `fake-provider: no route ${path}` } });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { error: { message: String(err) } });
    }
  });

  async function chat(body, id, res) {
    const pacing = cfg.chatPacing?.(body, chatSeq++) ?? {};
    const firstDelayMs = pacing.firstDelayMs ?? cfg.streamFirstDelayMs;
    const tokensPerSec = pacing.tokensPerSec ?? cfg.streamTokensPerSec;
    const model = String(body.model ?? 'fake-provider/model');
    const scripted = directiveReply(body.messages);
    const configured =
      scripted !== undefined
        ? Math.ceil(scripted.length / CHARS_PER_TOKEN)
        : (directiveTokens(body.messages) ?? cfg.bodyTokens);
    const cap = Number.isFinite(body.max_tokens) && body.max_tokens > 0 ? Math.floor(body.max_tokens) : Infinity;
    const outTokens = Math.min(configured, cap);
    const finishReason = outTokens < configured ? 'length' : 'stop';
    const content =
      scripted !== undefined ? scripted.slice(0, outTokens * CHARS_PER_TOKEN) : fakeBodyText(outTokens);
    const promptTokens = promptTokensOf(body.messages);
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: outTokens,
      total_tokens: promptTokens + outTokens,
      cost: cfg.costUsd,
    };

    if (!body.stream) {
      return sendJson(res, 200, {
        id,
        provider: 'fake-provider',
        model,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
        usage,
      });
    }

    // SSE: one frame per token-sized slice, paced when asked.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      [FAKE_PROVIDER_HEADER]: 'test-data',
    });
    res.flushHeaders();
    const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const intervalMs = tokensPerSec > 0 ? Math.max(1, Math.round(1000 / tokensPerSec)) : 0;
    if (!(await sleep(firstDelayMs, res))) return;
    for (let i = 0; i < outTokens; i++) {
      const piece = content.slice(i * CHARS_PER_TOKEN, (i + 1) * CHARS_PER_TOKEN);
      frame({ id, provider: 'fake-provider', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      if (i < outTokens - 1 && !(await sleep(intervalMs, res))) return;
    }
    frame({ id, provider: 'fake-provider', model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    frame({ id, provider: 'fake-provider', model, choices: [], usage });
    res.end('data: [DONE]\n\n');
  }

  async function embeddings(body, id, res) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (!(await sleep(cfg.embeddingDelayMs, res))) return;
    const chars = inputs.reduce((n, s) => n + String(s ?? '').length, 0);
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    return sendJson(res, 200, {
      id,
      provider: 'fake-provider',
      object: 'list',
      model: String(body.model ?? 'fake-provider/embedding'),
      data: inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: fakeEmbedOne(String(text ?? ''), cfg.embeddingDim),
      })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port ?? 0, cfg.host ?? '127.0.0.1', resolve);
  });
  const addr = server.address();
  const url = `http://${cfg.host ?? '127.0.0.1'}:${addr.port}`;

  return {
    url,
    port: addr.port,
    chatCompletionsUrl: `${url}/api/v1/chat/completions`,
    embeddingsUrl: `${url}/api/v1/embeddings`,
    env: {
      CHAT_COMPLETIONS_URL: `${url}/api/v1/chat/completions`,
      EMBEDDINGS_URL: `${url}/api/v1/embeddings`,
      // A placeholder key: the real adapters refuse to call without one, and a
      // real key must never travel to a fake endpoint.
      OPENROUTER_API_KEY: FAKE_PROVIDER_API_KEY,
    },
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function numEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`fake-provider: ${name}=${raw} is not a number >= 0`);
  return n;
}

// CLI: `node test-support/fake-provider/server.mjs`. Configured by env only.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = {
    port: numEnv('FAKE_PROVIDER_PORT') ?? 4010,
    host: process.env.FAKE_PROVIDER_HOST || '127.0.0.1',
  };
  const map = {
    bodyTokens: 'FAKE_PROVIDER_BODY_TOKENS',
    streamTokensPerSec: 'FAKE_PROVIDER_STREAM_TOKENS_PER_SEC',
    streamFirstDelayMs: 'FAKE_PROVIDER_STREAM_FIRST_DELAY_MS',
    embeddingDim: 'FAKE_PROVIDER_EMBEDDING_DIM',
    embeddingDelayMs: 'FAKE_PROVIDER_EMBEDDING_DELAY_MS',
    costUsd: 'FAKE_PROVIDER_COST_USD',
  };
  for (const [key, name] of Object.entries(map)) {
    const v = numEnv(name);
    if (v !== undefined) opts[key] = v;
  }
  const fake = await startFakeProvider(opts);
  console.log(`fake-provider (TEST DATA ONLY) listening on ${fake.url}`);
  console.log(`  CHAT_COMPLETIONS_URL=${fake.chatCompletionsUrl}`);
  console.log(`  EMBEDDINGS_URL=${fake.embeddingsUrl}`);
  console.log(`  OPENROUTER_API_KEY=${FAKE_PROVIDER_API_KEY}`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

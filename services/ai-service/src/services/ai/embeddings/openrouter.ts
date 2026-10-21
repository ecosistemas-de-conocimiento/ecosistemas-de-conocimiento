// OpenRouter embedding adapter — text-only, non-streaming.
//
// INVARIANT (companion to the chat-completion adapter at
// `src/services/ai/router/adapters/openrouter.ts`): this is the ONLY file in
// the tree that calls `fetch('https://openrouter.ai/api/v1/embeddings')`.
// Anything that needs an embedding must route through here so cost tracking
// and the future trace/usage writers see a single seam.
//
// OpenRouter exposes an OpenAI-compatible embeddings endpoint
// (`POST /api/v1/embeddings`). Per plan/m3-m4-decisions.md §9 (OpenRouter
// passthrough), we reuse the same `OPENROUTER_API_KEY`. If a future cost or
// latency probe shows OpenRouter's embedding routing is materially worse
// than calling OpenAI directly, the fallback path is:
//   1. Set `OPENAI_API_KEY` in env.
//   2. Switch `OPENROUTER_EMBEDDINGS_URL` below to
//      `https://api.openai.com/v1/embeddings`.
//   3. Strip the `openai/` prefix from the model string (OpenAI doesn't
//      namespace its own models).
// That swap is local to this file; the schema, types, and consumers above
// don't change. Note this as a revision candidate for decision #9.
//
// Cost: `text-embedding-3-small` is $0.02 / 1M input tokens (decision §10).
// Falls back to `priceForEmbedding()` for any other model in the price table.

import { env } from '../../../config/env.js';
import { minimiseEgress } from '../pii-egress.js';
import { priceForEmbedding } from '../router/task-profiles.js';

// The embeddings endpoint is config-driven (`env.EMBEDDINGS_URL`) so the model
// can be served by a managed provider in dev and a self-hosted box in prod with
// no code change. Defaults to OpenRouter's OpenAI-compatible endpoint.
const OPENROUTER_EMBEDDINGS_URL = env.EMBEDDINGS_URL;

export interface EmbedOptions {
  /** Provider/model id, e.g. `openai/text-embedding-3-small`. */
  model: string;
  /** A single string or an array of strings. The API returns one vector per input. */
  input: string | string[];
  /** Falls back to `env.EMBEDDINGS_API_KEY`, then `env.OPENROUTER_API_KEY`, then `env.OPENAI_API_KEY`, when omitted. */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** One vector per input, in submission order. */
  embeddings: number[][];
  /** Echo of the model the provider actually used. */
  model: string;
  usage: {
    inputTokens: number;
    estimatedCostUsd: number;
  };
}

interface OpenRouterEmbeddingsApiResponse {
  data?: Array<{ index?: number; embedding?: number[] | string }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string | number };
}

/** Typed error matching the chat-adapter's `OpenRouterHttpError` shape. */
export class OpenRouterEmbeddingHttpError extends Error {
  public readonly status: number;
  public readonly code: string | number | undefined;
  public readonly bodySnippet: string;
  constructor(opts: { status: number; code?: string | number; message: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = 'OpenRouterEmbeddingHttpError';
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet ?? '';
  }
}

function resolveApiKey(opts: EmbedOptions): string {
  // `EMBEDDINGS_API_KEY` wins when non-empty, so a non-OpenRouter
  // `EMBEDDINGS_URL` never receives the OpenRouter key. `||` (not `??`) treats
  // `EMBEDDINGS_API_KEY=` as unset; when it is unset the chain is exactly the
  // old `OPENROUTER_API_KEY ?? OPENAI_API_KEY`.
  const key =
    opts.apiKey ?? (env.EMBEDDINGS_API_KEY || env.OPENROUTER_API_KEY) ?? env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OpenRouter embedding API key missing: pass opts.apiKey or set EMBEDDINGS_API_KEY / OPENROUTER_API_KEY (preferred) / OPENAI_API_KEY env var.',
    );
  }
  return key;
}

function appHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': process.env.OPENROUTER_APP_URL ?? 'https://ecosistemas-de-conocimiento.local',
    'X-Title': 'edc ai-service Embeddings',
  };
}

/**
 * POST to OpenRouter's embeddings endpoint. Returns one vector per input,
 * in submission order. Throws `OpenRouterEmbeddingHttpError` on non-OK HTTP
 * or error envelopes.
 */
export async function callOpenRouterEmbedding(opts: EmbedOptions): Promise<EmbedResult> {
  const apiKey = resolveApiKey(opts);
  const body = {
    model: opts.model,
    // 🔴 EGRESS SEAM 3 of 5 (§9.4; see `../pii-egress.ts`). This is the "ingest embeddings" site: ingest
    // (`src/workers/ingest.worker.ts`), `/v1/embed` and retrieve all embed
    // through this one function, so scrubbing here covers all three and makes a
    // future caller opt in by default.
    //
    // ⚠ CONSEQUENCE, stated so nobody discovers it as a retrieval bug: a chunk
    // whose text carries a CURP is embedded as `[CURP]`, and a query carrying
    // the same CURP is embedded as `[CURP]` too — the two stay consistent, but a
    // corpus ingested BEFORE this change was embedded from the raw text. Mixing
    // them degrades recall on such chunks; re-ingest is the fix.
    input: await minimiseEgress(opts.input, opts.signal),
    // Force float arrays. Some OpenRouter-routed hosts (and the open models we
    // now use, e.g. bge-m3) can return base64-packed floats otherwise, which
    // this adapter deliberately rejects rather than decodes (see below).
    encoding_format: 'float',
  };

  const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: 'POST',
    headers: appHeaders(apiKey),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  const text = await res.text();
  let parsed: OpenRouterEmbeddingsApiResponse;
  try {
    parsed = text ? (JSON.parse(text) as OpenRouterEmbeddingsApiResponse) : {};
  } catch {
    throw new OpenRouterEmbeddingHttpError({
      status: res.status,
      message: `OpenRouter embedding returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  if (!res.ok || parsed.error) {
    const msg = parsed?.error?.message ?? `HTTP ${res.status}`;
    const code = parsed?.error?.code;
    throw new OpenRouterEmbeddingHttpError({
      status: res.status,
      code,
      message: `OpenRouter embedding error (${code ?? res.status}): ${msg}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  const rawData = parsed.data ?? [];
  const embeddings: number[][] = rawData
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row, i) => {
      const e = row.embedding;
      if (Array.isArray(e)) return e as number[];
      if (typeof e === 'string') {
        // Some providers return base64-packed floats; we don't decode them
        // here in v1 — surface as an explicit error so callers know to flip
        // the encoding back to "float".
        throw new OpenRouterEmbeddingHttpError({
          status: res.status,
          message: `OpenRouter embedding row ${i} returned a non-array embedding (base64?). Set encoding_format=float on the request.`,
          bodySnippet: text.slice(0, 200),
        });
      }
      throw new OpenRouterEmbeddingHttpError({
        status: res.status,
        message: `OpenRouter embedding row ${i} missing 'embedding' field.`,
        bodySnippet: text.slice(0, 200),
      });
    });

  const model = parsed.model ?? opts.model;
  const inputTokens = resolveInputTokens(parsed.usage, opts.input);
  const estimatedCostUsd = priceForEmbedding(model, inputTokens);

  return {
    embeddings,
    model,
    usage: { inputTokens, estimatedCostUsd },
  };
}

/**
 * Pick the input-token count from the upstream usage envelope; if neither
 * `prompt_tokens` nor `total_tokens` is present, fall back to a chars/4
 * estimate summed across every input string.
 *
 * Why: some OpenRouter-routed embedding providers omit `usage` entirely
 * (Voyage and a few smaller hosts have shipped responses like that). The old
 * behaviour of returning 0 silently under-reported every embedding's cost,
 * which broke budget accounting on those routes. Chars/4 is the standard
 * tokenizer-free estimate (OpenAI's docs cite it; close enough for cost
 * tracking) and is deterministic from the request body, so the estimate is
 * reproducible without an extra round-trip.
 */
function resolveInputTokens(
  usage: OpenRouterEmbeddingsApiResponse['usage'],
  input: EmbedOptions['input'],
): number {
  const fromProvider = usage?.prompt_tokens ?? usage?.total_tokens;
  if (typeof fromProvider === 'number' && fromProvider > 0) return fromProvider;
  const inputs = Array.isArray(input) ? input : [input];
  const totalChars = inputs.reduce((acc, s) => acc + (typeof s === 'string' ? s.length : 0), 0);
  return Math.ceil(totalChars / 4);
}

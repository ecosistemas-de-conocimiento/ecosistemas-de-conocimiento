// OpenRouter account credits passthrough.
//
// Single-purpose helper around `GET https://openrouter.ai/api/v1/credits`. Used
// by the admin-gated `/v1/openrouter/credits` route so a consumer's admin
// dashboard stays out of OpenRouter's auth surface — only ai-service holds the
// platform-wide OPENROUTER_API_KEY.
//
// Shape:
//   The upstream response is `{ data: { total_credits: number, total_usage: number } }`.
//   We expose a stable, snake-case-free shape — `totalCredits`, `totalUsage`,
//   `remainingCredits = totalCredits - totalUsage`, plus `updatedAt` so a UI
//   can show "as of …". Consumers should NOT depend on undocumented fields.
//
// Cache:
//   30 second TTL, single-entry Map. The admin page is polled by a human at
//   most every few seconds; this keeps us from hammering OpenRouter while
//   still surfacing near-real-time numbers. The cache is module-scoped and
//   process-local — multi-replica deploys will each hit OpenRouter once per
//   replica per TTL, which is fine.

import { env } from '../../config/env.js';

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
export const CREDITS_CACHE_TTL_MS = 30_000;

export interface OpenRouterCredits {
  totalCredits: number;
  totalUsage: number;
  remainingCredits: number;
  /** ISO-8601 timestamp of when the upstream call resolved. */
  updatedAt: string;
}

export interface FetchCreditsOptions {
  /** Falls back to `env.OPENROUTER_API_KEY` when omitted. */
  apiKey?: string;
  signal?: AbortSignal;
}

/** Typed error for non-OK responses from OpenRouter's credits endpoint. */
export class OpenRouterCreditsError extends Error {
  public readonly status: number;
  public readonly bodySnippet: string;
  constructor(opts: { status: number; message: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = 'OpenRouterCreditsError';
    this.status = opts.status;
    this.bodySnippet = opts.bodySnippet ?? '';
  }
}

interface CacheEntry {
  value: OpenRouterCredits;
  expiresAt: number;
}

let cached: CacheEntry | null = null;

/** Test seam — clear the module-scope cache. Production never calls this. */
export function __resetOpenRouterCreditsCacheForTests(): void {
  cached = null;
}

function resolveApiKey(opts: FetchCreditsOptions): string {
  const key = opts.apiKey ?? env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'OpenRouter API key missing: pass opts.apiKey or set OPENROUTER_API_KEY env var.',
    );
  }
  return key;
}

interface OpenRouterCreditsApiResponse {
  data?: {
    total_credits?: number;
    total_usage?: number;
  };
  error?: { message?: string; code?: string | number };
}

/**
 * Fetch the OpenRouter account-wide credits balance. Returns a cached value
 * when one is fresh (within `CREDITS_CACHE_TTL_MS`); otherwise hits the API.
 *
 * Throws `OpenRouterCreditsError` for non-2xx responses (so the route layer
 * can map to 503). Network errors propagate as-is.
 */
export async function fetchOpenRouterCredits(
  opts: FetchCreditsOptions = {},
): Promise<OpenRouterCredits> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const apiKey = resolveApiKey(opts);

  const res = await fetch(CREDITS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: opts.signal,
  });

  const text = await res.text();
  let parsed: OpenRouterCreditsApiResponse;
  try {
    parsed = text ? (JSON.parse(text) as OpenRouterCreditsApiResponse) : {};
  } catch {
    throw new OpenRouterCreditsError({
      status: res.status,
      message: `OpenRouter returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  if (!res.ok || parsed.error) {
    const msg = parsed.error?.message ?? `HTTP ${res.status}`;
    throw new OpenRouterCreditsError({
      status: res.status,
      message: `OpenRouter credits error (${res.status}): ${msg}`,
      bodySnippet: text.slice(0, 200),
    });
  }

  const totalCredits = Number(parsed.data?.total_credits ?? 0);
  const totalUsage = Number(parsed.data?.total_usage ?? 0);
  const value: OpenRouterCredits = {
    totalCredits,
    totalUsage,
    remainingCredits: totalCredits - totalUsage,
    updatedAt: new Date().toISOString(),
  };
  cached = { value, expiresAt: now + CREDITS_CACHE_TTL_MS };
  return value;
}

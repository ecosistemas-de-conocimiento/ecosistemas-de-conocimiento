// Typings for the TEST-ONLY fake provider (`server.mjs`). Never shipped.

export declare const FAKE_PROVIDER_MARKER: '[FAKE-PROVIDER TEST DATA]';
export declare const FAKE_PROVIDER_HEADER: 'x-fake-provider';
export declare const FAKE_PROVIDER_API_KEY: 'fake-provider-test-key';

export interface FakeProviderOptions {
  /** Port to bind. Default: 0 (an OS-assigned free port). The CLI defaults to 4010. */
  port?: number;
  /** Host to bind. Default: 127.0.0.1. */
  host?: string;
  /** Completion length in tokens when no directive or cap applies. Default 200. */
  bodyTokens?: number;
  /** Streaming pace. 0 (default) sends every frame at once. */
  streamTokensPerSec?: number;
  /** Pause before the first streamed frame, ms. Default 0. */
  streamFirstDelayMs?: number;
  /** Embedding vector length. Default 1024 (ai-service's `EMBEDDING_DIM`). */
  embeddingDim?: number;
  /** Pause before an embeddings response, ms. Default 0. */
  embeddingDelayMs?: number;
  /** `usage.cost` reported on completions, USD. Default 0. */
  costUsd?: number;
  /**
   * Per-call streaming pace override, in-process only. Called once per chat
   * request with its body and 0-based chat-call index; any field it returns
   * replaces `streamFirstDelayMs` / `streamTokensPerSec` for that call. Lets a
   * test make ONE pass of a multi-pass generation slow (e.g. a refine pass
   * that outlives ai-service's request timeout) while the others stay fast.
   */
  chatPacing?: (
    body: Record<string, unknown>,
    callIndex: number,
  ) => { firstDelayMs?: number; tokensPerSec?: number } | undefined;
}

export interface FakeProviderRequest {
  kind: 'chat' | 'embeddings';
  /** The JSON body ai-service sent, after its PII egress scrub. */
  body: Record<string, unknown>;
}

export interface FakeProvider {
  url: string;
  port: number;
  chatCompletionsUrl: string;
  embeddingsUrl: string;
  /**
   * Spread into ai-service's environment: both endpoint URLs plus a placeholder
   * `OPENROUTER_API_KEY` (the adapters refuse to call without a key, and a real
   * key must never travel to a fake endpoint).
   */
  env: { CHAT_COMPLETIONS_URL: string; EMBEDDINGS_URL: string; OPENROUTER_API_KEY: string };
  /** Every request received, in order. */
  requests: FakeProviderRequest[];
  close(): Promise<void>;
}

export declare function startFakeProvider(options?: FakeProviderOptions): Promise<FakeProvider>;
export declare function fakeEmbedOne(text: string, dim?: number): number[];
export declare function fakeBodyText(tokens: number): string;

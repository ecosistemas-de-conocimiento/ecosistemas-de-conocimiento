// 0.33.0: the hand-written response types for ai-service's retrieval fields —
// `warnings` on retrieve and retrieve/multi, `legs` on multi, `retrievalTrace`
// on generate — must match the server's Zod contract.
//
// Response types are hand-written (only REQUEST types are generated), so a
// server change to these shapes would not reach the client by itself. The
// type-level half below fails `npm run typecheck` at the REPO ROOT (the root
// tsconfig includes `packages/*/src/**`; the client's own excludes tests).
//
// Same rule as `types-compat.test.ts`: never `true as Mutual<…>`. The false
// branch is `false`, so a mismatch fails the `Record<string, true>` constraint
// by property name.

import { describe, expect, it } from 'vitest';

import type { z } from '../../../src/contract/zod.js';

import type {
  retrievalTraceEntrySchema,
  retrievalWarningSchema,
  retrieveMultiResponseSchema,
  retrieveResponseSchema,
  syncGenerationResponseSchema,
} from '../../../src/contract/responses.js';
import { AIClient } from './index.js';
import type {
  IncludeContextItem,
  RetrievalTraceEntry,
  RetrievalWarning,
  RetrieveMultiResult,
  RetrieveResult,
  SyncResult,
} from './index.js';

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Server<S extends z.ZodTypeAny> = z.infer<S>;

type FieldParity = {
  RetrievalWarning: Mutual<RetrievalWarning, Server<typeof retrievalWarningSchema>>;
  RetrievalTraceEntry: Mutual<RetrievalTraceEntry, Server<typeof retrievalTraceEntrySchema>>;
  'RetrieveResult.warnings': Mutual<
    RetrieveResult['warnings'],
    Server<typeof retrieveResponseSchema>['warnings']
  >;
  'RetrieveMultiResult.warnings': Mutual<
    RetrieveMultiResult['warnings'],
    Server<typeof retrieveMultiResponseSchema>['warnings']
  >;
  'RetrieveMultiResult.legs': Mutual<
    RetrieveMultiResult['legs'],
    Server<typeof retrieveMultiResponseSchema>['legs']
  >;
  'SyncResult.retrievalTrace': Mutual<
    SyncResult['retrievalTrace'],
    Server<typeof syncGenerationResponseSchema>['retrievalTrace']
  >;
};
type FieldParityProof<T extends Record<string, true>> = T;
export type RetrievalFieldsParity = FieldParityProof<FieldParity>;

// The includeContext knobs come from the GENERATED request type; pin that they
// are there, so a regenerated file that lost them fails typecheck.
const inlineItem: IncludeContextItem = {
  corpus: 'c',
  query: 'q',
  mode: 'hybrid',
  rerank: true,
  filter: { conversationId: 'x' },
  asOf: '2026-10-17T00:00:00Z',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('0.33.0 retrieval response fields', () => {
  it('retrieveMulti passes legs and warnings through untouched', async () => {
    const body = {
      query: 'q',
      rewritten: false,
      chunks: [],
      corpora: [],
      legs: ['dense', 'lexical'],
      warnings: [{ code: 'RERANK_DEGRADED', message: 'm', reason: 'timeout' }],
    };
    const client = new AIClient({
      baseUrl: 'http://ai.local',
      apiKey: 'k',
      fetch: (async () => json(body)) as typeof fetch,
    });
    const res = await client.retrieve.retrieveMulti({ corpora: ['a'], query: 'q' });
    expect(res.legs).toEqual(['dense', 'lexical']);
    expect(res.warnings?.[0]?.reason).toBe('timeout');
  });

  it('accepts the inline includeContext knobs', () => {
    expect(inlineItem).toMatchObject({ mode: 'hybrid', rerank: true });
  });
});

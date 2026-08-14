// Unit tests for the query-condensation machinery. The router is a stub so no
// LLM is called; we assert the mechanism (fail-safe, sanitize, content-agnostic
// wording) rather than any model behaviour.

import { describe, expect, it, vi } from 'vitest';

import { env } from '../../config/env.js';
import type { LLMRouter, RouteRequest, RouteResult } from '../ai/router/types.js';
import { condenseQuery } from './condense.js';
import type { RetrieveRewrite } from './types.js';

function stubRouter(impl: (req: RouteRequest) => Partial<RouteResult>): {
  router: LLMRouter;
  route: ReturnType<typeof vi.fn>;
} {
  const route = vi.fn(async (req: RouteRequest) => ({ content: '', ...impl(req) }) as RouteResult);
  return { router: { route }, route };
}

const CTX = { org: 'o1', project: 'p1' };
const INSTRUCTION = 'CONSUMER-OWNED REWRITE INSTRUCTION';

const history: RetrieveRewrite['history'] = [
  { role: 'user', content: 'Tell me about the widgets.' },
  { role: 'assistant', content: 'There are three widgets: A, B and C.' },
];

describe('condenseQuery', () => {
  it('returns the question unchanged when there is no history (first turn)', async () => {
    const { router, route } = stubRouter(() => ({ content: 'SHOULD NOT BE USED' }));
    const out = await condenseQuery(router, {
      directive: { instruction: INSTRUCTION },
      question: 'What about those?',
      ctx: CTX,
    });
    expect(out).toBe('What about those?');
    expect(route).not.toHaveBeenCalled();
  });

  it('ignores history made only of system turns (nothing to resolve)', async () => {
    const { router, route } = stubRouter(() => ({ content: 'rewritten' }));
    const out = await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history: [{ role: 'system', content: 'setup' }] },
      question: 'raw',
      ctx: CTX,
    });
    expect(out).toBe('raw');
    expect(route).not.toHaveBeenCalled();
  });

  it('rewrites the question using history + the cheapest tier', async () => {
    const { router, route } = stubRouter(() => ({ content: 'which widgets are available' }));
    const out = await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history },
      question: 'and those?',
      ctx: CTX,
    });
    expect(out).toBe('which widgets are available');
    const req = route.mock.calls[0]![0] as RouteRequest;
    // Cheapest tier.
    expect(req.effortLevel).toBe('quick');
    expect(req.maxTokens).toBe(80);
    // CONTENT-AGNOSTIC: the ONLY wording the service injects is the consumer's
    // instruction, passed verbatim as the system message. History + question
    // ride as real chat turns.
    expect(req.messages[0]).toEqual({ role: 'system', content: INSTRUCTION });
    expect(req.messages[req.messages.length - 1]).toEqual({ role: 'user', content: 'and those?' });
    expect(req.messages).toHaveLength(4); // system + 2 history + question
  });

  it('strips wrapping quotes/guillemets and collapses whitespace', async () => {
    const { router } = stubRouter(() => ({ content: '  «  which   widgets »  ' }));
    const out = await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history },
      question: 'q',
      ctx: CTX,
    });
    expect(out).toBe('which widgets');
  });

  it('falls back to the raw question when the rewrite is too short', async () => {
    const { router } = stubRouter(() => ({ content: 'x' }));
    const out = await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history },
      question: 'the original question',
      ctx: CTX,
    });
    expect(out).toBe('the original question');
  });

  it('fails safe to the raw question when the router throws', async () => {
    const router: LLMRouter = {
      route: vi.fn(async () => {
        throw new Error('budget exceeded');
      }),
    };
    const out = await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history },
      question: 'the original question',
      ctx: CTX,
    });
    expect(out).toBe('the original question');
  });

  it('caps the history it feeds the model to the last few non-system turns', async () => {
    const many: RetrieveRewrite['history'] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}`,
    }));
    const { router, route } = stubRouter(() => ({ content: 'condensed query text' }));
    await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history: many },
      question: 'q',
      ctx: CTX,
    });
    const req = route.mock.calls[0]![0] as RouteRequest;
    // system + <=6 history + question.
    expect(req.messages.length).toBeLessThanOrEqual(8);
  });

  it('hands the rewrite call an abort signal so a compliant router can cancel it', async () => {
    const { router, route } = stubRouter(() => ({ content: 'which widgets are available' }));
    await condenseQuery(router, {
      directive: { instruction: INSTRUCTION, history },
      question: 'and those?',
      ctx: CTX,
    });
    const req = route.mock.calls[0]![0] as RouteRequest;
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails safe to the raw question when the rewrite HANGS past the timeout', async () => {
    // F4 regression: a slow/hung rewrite is not a thrown error, so without a
    // wall-clock bound `condenseQuery` would block `/v1/retrieve/multi` forever.
    // Fake timers make the CONDENSE_TIMEOUT_MS bound instant + deterministic.
    vi.useFakeTimers();
    try {
      // route() never settles — models a rewrite that stalls indefinitely and
      // ignores the abort signal (the worst case the bound must still survive).
      const route = vi.fn((_req: RouteRequest) => new Promise<RouteResult>(() => {}));
      const router: LLMRouter = { route };

      const promise = condenseQuery(router, {
        directive: { instruction: INSTRUCTION, history },
        question: 'the original question',
        ctx: CTX,
      });

      // Advancing past the timeout must be enough to resolve — resolution does
      // NOT depend on route() ever settling.
      await vi.advanceTimersByTimeAsync(env.CONDENSE_TIMEOUT_MS + 1);

      await expect(promise).resolves.toBe('the original question');
      expect(route).toHaveBeenCalledTimes(1);
      // The stalled upstream call was aborted on timeout.
      const req = route.mock.calls[0]![0] as RouteRequest;
      expect(req.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

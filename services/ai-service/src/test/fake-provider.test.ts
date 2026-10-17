// Contract test for the TEST-ONLY fake provider (`test-support/fake-provider/`).
//
// The fake provider replaced the in-service MOCK_* switches. Every consumer
// e2e and several integration files now depend on it speaking the OpenRouter
// shapes the REAL adapters parse, so this file drives the real adapters at it:
// if the fake drifts from what `adapters/openrouter.ts` or
// `embeddings/openrouter.ts` read, this goes red here rather than as a
// confusing failure in some consumer's e2e.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  FAKE_PROVIDER_HEADER,
  FAKE_PROVIDER_MARKER,
  fakeBodyText,
  fakeEmbedOne,
  startFakeProvider,
  type FakeProvider,
} from '../../test-support/fake-provider/server.mjs';

let fake: FakeProvider;
let chat: typeof import('../services/ai/router/adapters/openrouter.js');
let embed: typeof import('../services/ai/embeddings/openrouter.js');

beforeAll(async () => {
  fake = await startFakeProvider({ bodyTokens: 40 });
  // The adapters read their URLs from `env.ts` at module load.
  for (const [k, v] of Object.entries(fake.env)) vi.stubEnv(k, v);
  vi.resetModules();
  chat = await import('../services/ai/router/adapters/openrouter.js');
  embed = await import('../services/ai/embeddings/openrouter.js');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fake.close();
});

const MESSAGES = [{ role: 'user' as const, content: 'Say something.' }];

describe('fake provider — chat completions', () => {
  it('answers the non-streaming adapter with a marked body and real-shaped usage', async () => {
    const out = await chat.callOpenRouter({ model: 'x/y', messages: MESSAGES, maxTokens: 800, temperature: 0 });
    expect(out.contentText.startsWith(FAKE_PROVIDER_MARKER)).toBe(true);
    expect(out.contentText).toBe(fakeBodyText(40));
    expect(out.finishReason).toBe('stop');
    expect(out.usage.completionTokens).toBe(40);
    expect(out.usage.promptTokens).toBeGreaterThan(0);
    expect(out.usage).toMatchObject({ costUsd: 0, costSource: 'openrouter' });
  });

  it('honours max_tokens: cuts the body and reports `length`', async () => {
    const out = await chat.callOpenRouter({ model: 'x/y', messages: MESSAGES, maxTokens: 10, temperature: 0 });
    expect(out.finishReason).toBe('length');
    expect(out.usage.completionTokens).toBe(10);
    expect(out.contentText).toHaveLength(40);
  });

  it('streams deltas that the streaming adapter reassembles into the same body', async () => {
    const deltas: string[] = [];
    const out = await chat.streamingCallOpenRouter({
      model: 'x/y',
      messages: MESSAGES,
      maxTokens: 800,
      temperature: 0,
      onDelta: (t) => deltas.push(t),
    });
    expect(deltas).toHaveLength(40);
    expect(deltas.join('')).toBe(fakeBodyText(40));
    expect(out.contentText).toBe(fakeBodyText(40));
    expect(out.finishReason).toBe('stop');
    expect(out.usage.completionTokens).toBe(40);
  });

  it('a `[[FAKE_OUTPUT_TOKENS:n]]` directive sets the length for that request only', async () => {
    const out = await chat.callOpenRouter({
      model: 'x/y',
      messages: [{ role: 'user', content: 'long please [[FAKE_OUTPUT_TOKENS:300]]' }],
      maxTokens: 800,
      temperature: 0,
    });
    expect(out.usage.completionTokens).toBe(300);
    expect(out.finishReason).toBe('stop');
  });

  it('marks every response with the test-data header', async () => {
    const res = await fetch(fake.chatCompletionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x/y', messages: MESSAGES }),
    });
    expect(res.headers.get(FAKE_PROVIDER_HEADER)).toBe('test-data');
    const body = (await res.json()) as { id: string; provider: string };
    expect(body.provider).toBe('fake-provider');
    expect(body.id.startsWith('fake-provider-')).toBe(true);
  });
});

describe('fake provider — streaming abort', () => {
  it('a caller abort mid-stream surfaces as OpenRouterAbortError with the partial', async () => {
    const slow = await startFakeProvider({ bodyTokens: 200, streamTokensPerSec: 50 });
    try {
      vi.stubEnv('CHAT_COMPLETIONS_URL', slow.chatCompletionsUrl);
      vi.resetModules();
      const slowChat = await import('../services/ai/router/adapters/openrouter.js');
      const ctrl = new AbortController();
      let seen = 0;
      const call = slowChat.streamingCallOpenRouter({
        model: 'x/y',
        messages: MESSAGES,
        maxTokens: 800,
        temperature: 0,
        signal: ctrl.signal,
        onDelta: () => {
          seen++;
          if (seen === 3) ctrl.abort();
        },
      });
      const err = await call.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(slowChat.OpenRouterAbortError);
      expect((err as InstanceType<typeof slowChat.OpenRouterAbortError>).partial.usage.completionTokens).toBe(3);
    } finally {
      vi.stubEnv('CHAT_COMPLETIONS_URL', fake.chatCompletionsUrl);
      await slow.close();
    }
  });
});

describe('fake provider — abort with a reason', () => {
  it('an abort carrying a non-AbortError reason still yields the partial', async () => {
    // The cooperative shutdown aborts with a string reason, so `fetch` rejects
    // with that string rather than a DOMException named `AbortError`.
    const slow = await startFakeProvider({ bodyTokens: 200, streamTokensPerSec: 50 });
    try {
      vi.stubEnv('CHAT_COMPLETIONS_URL', slow.chatCompletionsUrl);
      vi.resetModules();
      const slowChat = await import('../services/ai/router/adapters/openrouter.js');
      const ctrl = new AbortController();
      let seen = 0;
      const err = await slowChat
        .streamingCallOpenRouter({
          model: 'x/y',
          messages: MESSAGES,
          maxTokens: 800,
          temperature: 0,
          signal: ctrl.signal,
          onDelta: () => {
            seen++;
            if (seen === 2) ctrl.abort('ai-service:shutdown');
          },
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(slowChat.OpenRouterAbortError);
      expect((err as InstanceType<typeof slowChat.OpenRouterAbortError>).partial.usage.completionTokens).toBe(2);
    } finally {
      vi.stubEnv('CHAT_COMPLETIONS_URL', fake.chatCompletionsUrl);
      await slow.close();
    }
  });
});

describe('fake provider — embeddings', () => {
  it('returns fakeEmbedOne(text) per input, in order, through the real adapter', async () => {
    const out = await embed.callOpenRouterEmbedding({ model: 'baai/bge-m3', input: ['alpha', 'beta'] });
    expect(out.embeddings).toEqual([fakeEmbedOne('alpha'), fakeEmbedOne('beta')]);
    expect(out.embeddings[0]).toHaveLength(1024);
    expect(out.model).toBe('baai/bge-m3');
    expect(out.usage.inputTokens).toBe(Math.ceil('alphabeta'.length / 4));
  });

  it('records the body it received (after the service-side egress scrub)', async () => {
    const before = fake.requests.length;
    await embed.callOpenRouterEmbedding({ model: 'm', input: 'recorded' });
    const last = fake.requests.at(-1)!;
    expect(fake.requests.length).toBe(before + 1);
    expect(last.kind).toBe('embeddings');
    expect(last.body['input']).toBe('recorded');
    expect(last.body['encoding_format']).toBe('float');
  });

  it('vectors are deterministic and unit length', () => {
    const v = fakeEmbedOne('norm check');
    expect(fakeEmbedOne('norm check')).toEqual(v);
    expect(Math.sqrt(v.reduce((s, n) => s + n * n, 0))).toBeCloseTo(1, 6);
  });
});

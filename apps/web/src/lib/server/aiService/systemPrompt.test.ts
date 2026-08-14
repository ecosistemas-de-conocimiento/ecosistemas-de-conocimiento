/**
 * The loud check: if chat sends a system prompt and ai-service does not report
 * having applied it, we must throw rather than return an answer generated
 * without chat's instructions.
 *
 * `systemPromptApplied` absent (an ai-service predating system-prompt support)
 * must fail exactly like `false` — treating "missing" as success is the silent
 * failure this whole migration exists to remove.
 */

import { describe, expect, it } from 'vitest';
import { AIServiceClient, assertSystemPromptApplied } from './client';
import { buildChatUnitRequest } from '$lib/server/engine/wire';

function stubFetch(body: unknown): { fetch: typeof fetch; sent: () => unknown } {
  let sentBody: unknown;
  const impl = (async (_url: string, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, sent: () => sentBody };
}

const MESSAGES = [
  { role: 'system', content: 'Eres un asistente. No inventes detalles.' },
  { role: 'user', content: 'hola' },
];

describe('assertSystemPromptApplied', () => {
  it('passes when a system prompt was sent and applied', () => {
    expect(() => assertSystemPromptApplied('rules', true)).not.toThrow();
  });

  it('throws when the field is false (a refactor dropped unit.systemPrompt)', () => {
    expect(() => assertSystemPromptApplied('rules', false)).toThrow(/did not apply/);
  });

  it('throws when the field is ABSENT (deployment predates system-prompt support)', () => {
    expect(() => assertSystemPromptApplied('rules', undefined)).toThrow(/did not apply/);
  });

  it('is a no-op when we never asked for a system prompt', () => {
    expect(() => assertSystemPromptApplied(undefined, undefined)).not.toThrow();
  });
});

describe('AIServiceClient.generateSync', () => {
  it('sends unit.systemPrompt on the wire and returns when it is applied', async () => {
    const stub = stubFetch({ text: 'ok', systemPromptApplied: true });
    const client = new AIServiceClient({
      baseUrl: 'http://ai.test',
      apiKey: 'k',
      fetch: stub.fetch,
    });

    const res = await client.generateSync(
      buildChatUnitRequest({ messages: MESSAGES, unitKey: 's1' }),
    );

    const sent = stub.sent() as { unit: { systemPrompt?: string; input?: { userPrompt?: string } } };
    expect(sent.unit.systemPrompt).toContain('No inventes detalles');
    expect(sent.unit.input?.userPrompt).not.toContain('No inventes detalles');
    expect(res.text).toBe('ok');
  });

  it('throws when ai-service omits systemPromptApplied', async () => {
    const stub = stubFetch({ text: 'ok' });
    const client = new AIServiceClient({
      baseUrl: 'http://ai.test',
      apiKey: 'k',
      fetch: stub.fetch,
    });

    await expect(
      client.generateSync(buildChatUnitRequest({ messages: MESSAGES, unitKey: 's1' })),
    ).rejects.toThrow(/did not apply the system prompt/);
  });

  it('does not throw for a request that carries no system prompt', async () => {
    const stub = stubFetch({ text: 'ok' });
    const client = new AIServiceClient({
      baseUrl: 'http://ai.test',
      apiKey: 'k',
      fetch: stub.fetch,
    });

    const res = await client.generateSync(
      buildChatUnitRequest({ messages: [{ role: 'user', content: 'hola' }], unitKey: 's1' }),
    );
    expect(res.text).toBe('ok');
  });
});

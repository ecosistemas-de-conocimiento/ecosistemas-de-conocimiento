import { describe, expect, it, vi } from 'vitest';
import { condenseQuery, type AIClient } from '@edc/chat-engine/core';
import { withCondenseDeadline } from './condenseDeadline';

const history = [
  { role: 'user' as const, content: '¿Qué dicen los testimonios de Oaxaca?' },
  { role: 'assistant' as const, content: 'Hablan del agua.' },
];

function client(delayMs: number): AIClient {
  return {
    generateSync: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ text: 'agua en Oaxaca y Chiapas', costUsd: 0 } as never), delayMs),
      ),
    retrieve: vi.fn(async () => ({ matches: [] })),
    ingest: vi.fn(async () => ({}) as never),
  };
}

const ask = (ai: AIClient) =>
  condenseQuery(ai, {
    condenseSystemPrompt: 'x',
    surface: 's',
    orgId: 'o',
    userId: 'u',
    history,
    question: '¿y en Chiapas?',
  });

describe('withCondenseDeadline', () => {
  it('keeps a rewrite that arrives in time', async () => {
    expect(await ask(withCondenseDeadline(client(5), 200))).toBe('agua en Oaxaca y Chiapas');
  });

  it('🔴 a slow condense falls back to the question as asked, at the deadline', async () => {
    const t0 = Date.now();
    expect(await ask(withCondenseDeadline(client(2000), 50))).toBe('¿y en Chiapas?');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('passes every other method through', async () => {
    const inner = client(0);
    await withCondenseDeadline(inner).retrieve({ corpus: 'c', query: 'q' } as never);
    expect(inner.retrieve).toHaveBeenCalledOnce();
  });
});

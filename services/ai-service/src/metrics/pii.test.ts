// The emit side of the PII egress metrics. Asserts on the DEFAULT registry —
// the one `GET /metrics` scrapes — for the reason `llm.test.ts` gives.

import { describe, expect, it } from 'vitest';
import { register } from '@prometheus-io/client';

import { recordEgressScrub } from './pii.js';

async function sample(name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await register.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === name);
  if (!m) return 0;
  const hit = (m.values as Array<{ value: number; labels: Record<string, unknown> }>).find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return hit?.value ?? 0;
}

describe('recordEgressScrub', () => {
  it('counts one payload per call and each non-zero kind by its count', async () => {
    const payloads = await sample('ai_pii_egress_scrubbed_total', { seam: 'embeddings' });
    const rfc = await sample('ai_pii_redactions_total', { seam: 'embeddings', kind: 'rfc' });

    recordEgressScrub('embeddings', { rfc: 3, curp: 0 });

    expect((await sample('ai_pii_egress_scrubbed_total', { seam: 'embeddings' })) - payloads).toBe(1);
    expect((await sample('ai_pii_redactions_total', { seam: 'embeddings', kind: 'rfc' })) - rfc).toBe(3);
  });

  it('never creates a series for a zero kind — cardinality stays with what happened', async () => {
    recordEgressScrub('chat', { curp: 0 });
    const metrics = await register.getMetricsAsJSON();
    const m = metrics.find((x) => x.name === 'ai_pii_redactions_total');
    const chatCurp = (m?.values ?? []).find(
      (v) => v.labels['seam'] === 'chat' && v.labels['kind'] === 'curp',
    );
    expect(chatCurp).toBeUndefined();
  });

  it('never throws, whatever it is handed', () => {
    expect(() => recordEgressScrub('rerank', { curp: Number.NaN })).not.toThrow();
  });
});

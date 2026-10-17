// PII egress metrics. EMIT SIDE ONLY — same contract as `./llm.ts`: definitions
// and never-throwing increment helpers, registered on the ONE registry
// `./registry.ts` exports (never the client by package name; see that header).
//
// WHY THESE EXIST: the minimiser at an egress seam is invisible when it works.
// A scrubbed call and a bypassed one both return 200 with the same shape, so
// "the scrub is on" was a claim nobody could check from outside the code
// (aiinfra rerank-pii-egress handoff §5.1). These counters make it checkable:
// `ai_pii_egress_scrubbed_total` rising with traffic says the seam scrubbed
// before sending; `ai_pii_redactions_total` says what it found.
//
// ⚠ LABEL CARDINALITY. Both label sets are FIXED and small: `seam` is the
// `EgressSeam` union below, `kind` is `PII_KINDS` (six values). No tenant, no
// model, no text. A count is never content.
//
// ⚠ SCOPE TODAY: only the rerank and sparse-embed seams increment these. The
// three OpenRouter seams (chat, chat stream, embeddings) have seam values
// reserved here but do not call `recordEgressScrub` yet — wiring them is a separate change in files
// this module does not own. A zero on those seams means "not wired", not
// "nothing scrubbed".

import type { PiiKind } from '../services/ai/pii/index.js';
import { client, reuse } from './registry.js';

const { Counter } = client;

/** Every egress seam `pii-egress.ts` names. A new seam is a compile error, not an unlabelled series. */
export type EgressSeam = 'rerank' | 'chat' | 'chat_stream' | 'embeddings' | 'sparse_embed';

/** One scrubbed payload, counted just before it goes on the wire. */
export const piiEgressScrubbedTotal = reuse(
  'ai_pii_egress_scrubbed_total',
  () =>
    new Counter({
      name: 'ai_pii_egress_scrubbed_total',
      help: 'Payloads minimised at an egress seam before the network call, by seam.',
      labelNames: ['seam'] as const,
    }),
);

/** Redactions made at an egress seam, by PII kind. */
export const piiRedactionsTotal = reuse(
  'ai_pii_redactions_total',
  () =>
    new Counter({
      name: 'ai_pii_redactions_total',
      help: 'PII redactions made at an egress seam, by seam and kind.',
      labelNames: ['seam', 'kind'] as const,
    }),
);

/**
 * Record one scrubbed egress payload and its redactions.
 *
 * Never throws: a metrics backend is not allowed to fail an egress call — the
 * scrub already happened, and losing a data point beats losing the request.
 */
export function recordEgressScrub(
  seam: EgressSeam,
  counts: Readonly<Partial<Record<PiiKind, number>>>,
): void {
  try {
    piiEgressScrubbedTotal.inc({ seam });
    for (const [kind, n] of Object.entries(counts)) {
      if (typeof n === 'number' && n > 0) piiRedactionsTotal.inc({ seam, kind }, n);
    }
  } catch {
    // See the doc comment.
  }
}

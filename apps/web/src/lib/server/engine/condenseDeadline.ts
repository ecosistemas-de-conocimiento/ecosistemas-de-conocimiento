/**
 * A deadline on the engine's condense call (`condenseQuery`, the follow-up →
 * standalone-question rewrite). It runs BEFORE retrieval and the answer, so
 * its whole wait lands in front of the first words.
 *
 * Past the deadline the call rejects; `condenseQuery` already treats a failed
 * call as "search the question as asked" and logs `condense.failed`. The late
 * result is dropped (it still bills).
 *
 * Wrap ONLY the client handed to `prepareTurn`: condense is the one model call
 * `prepareTurn` makes. The answer's own `generateSync` must never get this.
 *
 * 6 s is inferred, not measured here: the hosted condense measured a 4.64 s
 * median and 21.7 s max on dev (2026-10-26, `plan/spark-chat-eval-2026-10-26.md`),
 * so the deadline cuts the slow tail and keeps most rewrites.
 */

import type { AIClient } from '@edc/chat-engine/core';

export const CONDENSE_TIMEOUT_MS = 6000;

export function withCondenseDeadline<T extends AIClient>(client: T, ms = CONDENSE_TIMEOUT_MS): T {
  return {
    ...client,
    generateSync(req) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        client.generateSync(req),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error(`condense over ${ms} ms`), { name: 'TimeoutError' })),
            ms,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    },
  };
}

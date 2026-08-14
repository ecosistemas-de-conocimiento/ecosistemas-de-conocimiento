import type { Access, CollectionConfig } from 'payload'

import { isPlatformAdmin } from '../access'

/**
 * Idempotency dedupe for ai-service → backend webhook callbacks.
 *
 * One row per (correlationKey, eventKey, event). The receiver INSERTs, and
 * whether that insert CONFLICTS is what decides between "run the dispatch" and
 * "return 200, we already did this". ai-service retries on 5xx and timeouts, so
 * without this table every retry would re-apply the same `documents` update.
 *
 * 🔴 THE UNIQUE INDEX DOES NOT EXIST YET, SO DEDUPE IS CURRENTLY INERT.
 * It lived in a baseline migration, and this repo has none — see
 * `src/migrations/README.md`, which lists it as one of three indexes the first
 * baseline must add. Until then a retried callback inserts a second row and
 * runs its dispatch again. The dispatch is a status update on a `documents`
 * row and is idempotent in practice, so the consequence today is duplicate
 * rows here rather than corruption — but this is a REAL gap, not a nicety.
 *
 * Shape (only the ingest path is used today):
 *   - `correlationKey` — `ingestId` for ingest events.
 *   - `eventKey`       — `docId` for per-doc events; empty string for
 *                        batch-level events (`ingest.progress`).
 *   - `event`          — the event-type string verbatim.
 *
 * Empty-string default for `eventKey` (rather than NULL) so the unique
 * index treats batch events as distinct from per-doc events — Postgres
 * `UNIQUE` treats NULLs as not-equal, which would let duplicate
 * `ingest.progress` events through.
 *
 * Read access: platform admins only. The receiver route writes via
 * `overrideAccess: true`; no Admin-UI create/update/delete.
 *
 * ⚠ THIS USED TO BE AN EMAIL-DOMAIN SUFFIX CHECK. That is not an authorization
 * rule, it is a guess: it grants every account at one company and nobody else.
 * It breaks the moment a real operator has an address at a different domain,
 * and it silently over-grants to every colleague who happens to share one.
 * `isPlatformAdmin` is the flag that actually means "operator" here.
 */

const denyAll: Access = () => false

export const AiServiceCallbacks: CollectionConfig = {
  slug: 'aiServiceCallbacks',
  admin: {
    useAsTitle: 'event',
    description:
      'Webhook callback idempotency dedupe (ai-service → backend). Operator debug only; writes happen via the receiver route, not the Admin UI.',
  },
  access: {
    read: isPlatformAdmin,
    create: denyAll,
    update: denyAll,
    delete: denyAll,
  },
  fields: [
    {
      name: 'correlationKey',
      type: 'text',
      required: true,
      index: true,
      admin: {
        description: 'ai-service ingestId (or requestId, if we ever wire generate.enqueue).',
      },
    },
    {
      name: 'eventKey',
      type: 'text',
      required: true,
      defaultValue: '',
      index: true,
      admin: {
        description:
          'docId for per-doc events; empty string for batch-level events (ingest.progress).',
      },
    },
    {
      name: 'event',
      type: 'text',
      required: true,
      index: true,
    },
    {
      name: 'receivedAt',
      type: 'date',
      required: true,
      admin: { date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'rawBody',
      type: 'textarea',
      admin: {
        description:
          'Raw JSON body as received from ai-service. Retained for debugging signature / payload drift.',
      },
    },
  ],
  /**
   * 🔴 UNIQUE (correlation_key, event_key, event) MUST be added by the first
   * baseline migration. Payload's collection config has no composite-unique
   * helper, and this collection's entire purpose depends on that constraint —
   * see the header and `src/migrations/README.md`.
   */
}

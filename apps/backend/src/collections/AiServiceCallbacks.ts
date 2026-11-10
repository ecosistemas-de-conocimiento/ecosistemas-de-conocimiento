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
 * The unique index is `ai_service_callbacks_natural_key_unq`, added by the
 * baseline migration (`20260908_092211_baseline.ts`).
 *
 * 🔴 THE ROW IS KEPT; ONLY ITS BODY EXPIRES. `lib/callbackRetention.ts` sets
 * `rawBody` to NULL after `CALLBACK_RETENTION_DAYS` (default 30). Deleting the
 * row would let a late retry run its dispatch again.
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
      /**
       * 🔴 `required` ALONE REFUSES THE EMPTY STRING. Payload's text validator
       * reads `''` as missing, so every batch-level event (and a transcription
       * callback with no `externalId`) failed the dedupe insert and was answered
       * 500, forever. The column stays NOT NULL; any string passes.
       */
      validate: (value: unknown) => typeof value === 'string' || 'eventKey must be a string',
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
      /**
       * 🔴 MATCHES THE 100,000-CHAR SLICE in `app/api/ai-service/callback/route.ts`.
       * Without it Payload's 40,000 default refused the dedupe insert of any
       * `transcribe.completed` carrying a longer transcript, and the route
       * answered 500 — the callback was never applied. Validation only; the
       * column is unbounded `varchar`, so no migration.
       */
      maxLength: 100_000,
      admin: {
        description:
          'JSON body as received, except a transcript: its text is replaced by its length and SHA-256 (audit 2026-10-28). Set to NULL after CALLBACK_RETENTION_DAYS (default 30).',
      },
    },
  ],
  /**
   * UNIQUE (correlation_key, event_key, event) lives in the baseline migration:
   * Payload's collection config has no composite-unique helper.
   */
}

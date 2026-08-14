# Migrations — there is no baseline yet

`index.ts` exports an empty array. That is the intended state right now, not an
oversight.

## Why it is empty

This repo is a fresh start assembled from two Payload apps, each of which
arrived with its own baseline migration describing its own schema. Those two
baselines could not be sequenced together — they create overlapping tables
(`users`, `projects`) with different shapes, and the second would fail against
the first. Both were **deleted**, because the alternative is a migration history
that describes a database nobody will ever have.

Nothing is deployed. There is no production data. The cheapest correct move is
one clean baseline generated once the schema stops moving.

## How the schema gets created today

`src/payload.config.ts` runs with `push: true`. Payload diffs the config against
the database and applies the difference at boot. That is fine for a local or dev
database being recreated freely, and it is the ONLY thing creating tables right
now.

⚠ **Push is not safe on a database with data in it.** It will drop a column to
match the config without asking anyone. Do not point a push-enabled build at
anything you care about.

## Generating the first baseline

Do all four steps together. Doing the first without the rest leaves a deployed
environment with no schema at all.

1. Bring up an **empty** database and let a `pnpm dev` boot push the full
   schema, so what you generate from is what the config actually says.
2. `pnpm --filter @edc/backend payload migrate:create baseline`
3. Add the generated file to `index.ts`.
4. Flip the app to migrations-only, in the same change:
   - set `PAYLOAD_DISABLE_PUSH=1` in every deployed environment;
   - change the `start` script back to `payload migrate && next start`.

## Add these to the baseline by hand

Payload has no compound-unique index in its collection config, so two
constraints this code depends on are enforced in `beforeValidate` hooks today.
A hook is a check, not a lock: two simultaneous inserts can both pass it.

When you write the baseline, add real partial unique indexes for:

- `memberships (user, organization)` — see `collections/Memberships.ts`
- `ratings (message, user)` — see `collections/Ratings.ts`. This one is the more
  important of the two: without it, two fast clicks on the star widget can
  produce two rows for the same answer, and every average computed over the
  table is quietly wrong.
- `ai_service_callbacks (correlation_key, event_key, event)` — the callback
  receiver's idempotency depends on an INSERT conflicting. Without the index
  there is nothing to conflict with, and an ai-service retry re-runs the
  dispatch.

The application code stays as it is: the hooks give a readable error in the
admin panel, and the index closes the race underneath them.

## Also worth an index

Not correctness, but every one of these is on a hot path:

- `documents (organization, publication_status)` — the visibility constraint
  `OR(uploaded_by = me, AND(publication_status = 'published', organization IN …))`
  runs on every document list.
- `documents (uploaded_by)` — the other half of the same OR.
- `documents (publish_ingest_id)` — the callback receiver looks a row up by it
  on every ingest event.
- `ratings (organization)` and `ratings (message)` — tenant filter and the
  find-before-upsert.

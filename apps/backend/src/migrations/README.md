# Migrations — the baseline exists

`20260814_205354_baseline.ts` is the first and, so far, only migration. It was
cut on 2026-08-14, when every database in every environment was still empty —
the only moment a baseline can be cut cleanly rather than reconciled.

This file used to say "there is no baseline yet" and describe how to make one.
That history is preserved below under "How this got here", because the reasoning
still matters the next time someone is tempted to regenerate it.

## The rules now

🔴 **Push is off in every deployed environment.** `PAYLOAD_DISABLE_PUSH=1` in
dev, stage and prod (`infra/fleet/env-manifests.md` §1 and §6). The backend's
`start` script is `payload migrate && next start`, so a deploy applies pending
migrations and fails loudly if it cannot.

✅ **Schema changes go through `payload migrate:create <name>`.** Change the
collection config, run it against a database that is already at the current
baseline, review the generated SQL, commit both the `.ts` and the `.json`
snapshot. Payload rewrites `index.ts` for you.

⚠ **The local demo still runs on push** (`infra/docker-compose.yml` sets
`PAYLOAD_DISABLE_PUSH=0`). Convenient, and fine for a throwaway database — but
see the next section before you trust a local database to behave like a
deployed one.

## 🔴 Four indexes in the baseline are hand-written, and push does not know them

Payload's field config has no compound index, so these four were appended to the
generated `up()` by hand, in a clearly-marked block at the bottom of the file:

| index | table | columns |
|---|---|---|
| `ratings_message_user_unq` | `ratings` | `message_id, user_id` |
| `memberships_user_organization_unq` | `memberships` | `user_id, organization_id` |
| `ai_service_callbacks_natural_key_unq` | `ai_service_callbacks` | `correlation_key, event_key, event` |
| `documents_organization_publication_status_idx` | `documents` | `organization_id, publication_status` |

Two consequences, both easy to trip over:

1. **A regenerated baseline will not contain them.** They are not in the drizzle
   schema Payload diffs against, so `migrate:create` cannot emit them. If this
   baseline is ever regenerated, copy the block forward by hand.
2. **A push-enabled boot can drop them.** Push reconciles the database toward
   the drizzle schema. An index that is not in that schema is not something push
   has any reason to keep. Nothing errors when they go — the ratings table just
   starts accepting duplicate rows again.

### Why the three `_unq` ones are correctness, not tuning

`collections/Ratings.ts`, `collections/Memberships.ts` and the callback receiver
in `app/api/ai-service/callback/route.ts` all de-duplicate in application code:
a `beforeValidate` hook, or a find-then-create. **A hook is a check, not a
lock.** Two concurrent requests both read "no row exists", both pass, both
write. Only the database can close that.

The application code stays exactly as it is — the hooks produce the readable
error in the admin panel. The indexes close the race underneath them.

- `ratings (message_id, user_id)` is the one that matters most. Two fast clicks
  on the star widget produce two rows for the same answer, silently, and every
  average computed over the table is then wrong with no way to tell which row
  the user meant.
- `ai_service_callbacks (correlation_key, event_key, event)` is what makes the
  callback receiver's idempotency real: it INSERTs and treats a unique violation
  as "already processed". With no unique index there is nothing to conflict
  with, so an ai-service retry re-runs the whole dispatch.
  🔴 **The index NAME is part of the contract** — `route.ts` matches the string
  `ai_service_callbacks_natural_key_unq` in the raw driver error. Renaming the
  index silently narrows the dedupe to the other error shapes it checks for.
- `memberships (user_id, organization_id)` keeps role resolution unambiguous.

⚠ They are plain `UNIQUE`, not partial. An earlier draft of this file called for
"partial unique indexes"; a `WHERE` clause buys nothing, because every column
involved is `NOT NULL`.

### The "also worth an index" list was mostly already satisfied

An earlier draft listed seven hot-path indexes to add by hand. Six of them
already exist: Payload emits them from `index: true` on the field, verified
against the real schema —

`documents_organization_idx`, `documents_uploaded_by_idx`,
`documents_publish_ingest_id_idx`, `ratings_organization_idx`,
`ratings_message_idx`, `media_uploaded_by_idx`, `media_organization_idx`.

Only the **composite** `documents (organization_id, publication_status)` was
genuinely missing, and that is the fourth hand-written index above. It serves
the `AND(publication_status = 'published', organization IN …)` branch of the
document visibility constraint in one scan.

## ⚠ New columns on `media`, and what they mean for existing rows

`collections/Media.ts` has `uploaded_by` and `organization`. Both are NULLABLE
on purpose: `POST /api/media` carries only the file, so a multi-ecosistema
uploader has no unambiguous organization, and server-side writes
(`overrideAccess: true`, no user) have no uploader to stamp.

🔴 **A `media` row with `uploaded_by = NULL` matches neither the read constraint
nor the update/delete one.** Such rows are invisible and undeletable to everyone
except a platform admin. That is fail-closed and deliberate — the alternative is
guessing an owner for a file whose owner was never recorded.

Nothing was deployed when the baseline was cut, so the baseline creates these
columns and no backfill is needed. Recorded here in case a database predating
the baseline ever turns up:

```sql
-- Derive the owner from the document that points at the file.
UPDATE media m
SET uploaded_by_id = d.uploaded_by_id, organization_id = d.organization_id
FROM documents d
WHERE d.media_file_id = m.id AND m.uploaded_by_id IS NULL;
```

Files no document points at cannot be backfilled this way and should be reviewed
by hand or deleted.

## How this got here

This repo was assembled from two Payload apps, each of which arrived with its
own baseline migration describing its own schema. Those two baselines could not
be sequenced together — they create overlapping tables (`users`, `projects`)
with different shapes, and the second would fail against the first. **Both were
deleted**, because the alternative is a migration history that describes a
database nobody will ever have.

`index.ts` then exported an empty array on purpose until 2026-08-14, when the
baseline was generated from an empty `edc_backend` that a push-enabled boot had
just built from the config. It was verified by dropping and recreating that
database, running `payload migrate`, and inserting deliberately conflicting rows
through `psql` to confirm each unique index actually rejects the second write.

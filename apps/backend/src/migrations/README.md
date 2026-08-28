# Migrations — the baseline exists

`20260814_205354_baseline.ts` is the first and, so far, only migration. It was
cut on 2026-08-14, when every database in every environment was still empty —
the only moment a baseline can be cut cleanly rather than reconciled.

This file used to say "there is no baseline yet" and describe how to make one.
That history is preserved below under "How this got here", because the reasoning
still matters the next time someone is tempted to regenerate it.

## The rules now

🔴 **Push is off everywhere, by default, and no variable is needed to keep it
that way.** The gate in `payload.config.ts` is opt-IN —
`push: process.env.NODE_ENV !== 'test' && process.env.PAYLOAD_ALLOW_PUSH === '1'`
— so an environment that wants push has to say so out loud. It was opt-out until
2026-08-14, which meant one forgotten variable in one environment was enough to
lose the hand-written indexes below, silently. That is the wrong direction to
fail in. The backend's `start` script is `payload migrate && next start`, so a
deploy applies pending migrations and fails loudly if it cannot.

✅ **Schema changes go through `payload migrate:create <name>`.** Change the
collection config, run it against a database that is already at the current
baseline, review the generated SQL, commit both the `.ts` and the `.json`
snapshot. Payload rewrites `index.ts` for you.

✅ **The local demo runs on migrations too**, as of 2026-08-14.
`apps/backend/Dockerfile.dev`'s `CMD` runs `pnpm exec payload migrate` before
`next dev`, matching the production image's `pnpm start`, and neither compose
file sets a push variable any more. It used to push, which was convenient for a
throwaway database and not free: a pushed local database is missing the four
hand-written indexes below, so a duplicate-rating race would **not** reproduce
locally while it **was** blocked in dev/stage/prod. Local is exactly where you
would try to reproduce it, so that was the worst possible split.

🔧 `PAYLOAD_ALLOW_PUSH=1` is still there for iterating on the schema locally.
Expect the four indexes to disappear while it is on, and cut a migration rather
than leaving a database in that state.

## 🔴 Seven indexes are hand-written, and push does not know them

Payload's field config has no compound index, so these were appended to a
generated `up()` by hand, in a clearly-marked block at the bottom of the file.
Four are in the baseline; three arrived with the corpus graph.

| index | table | columns | migration |
|---|---|---|---|
| `ratings_message_user_unq` | `ratings` | `message_id, user_id` | baseline |
| `memberships_user_organization_unq` | `memberships` | `user_id, organization_id` | baseline |
| `ai_service_callbacks_natural_key_unq` | `ai_service_callbacks` | `correlation_key, event_key, event` | baseline |
| `documents_organization_publication_status_idx` | `documents` | `organization_id, publication_status` | baseline |
| `graph_entities_org_type_key_unq` | `graph_entities` | `organization_id, type, canonical_key` | `20260828_083851_corpus_graph` |
| `graph_mentions_document_entity_unq` | `graph_mentions` | `document_id, entity_id` | `20260828_083851_corpus_graph` |
| `graph_relations_document_edge_unq` | `graph_relations` | `document_id, from_entity_id, to_entity_id, type` | `20260828_083851_corpus_graph` |

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

### The three graph ones are correctness for the same reason

`lib/graph/writer.ts` de-duplicates in application code too — a find-then-create
for entities, a delete-then-insert for one document's mentions and relations —
and the race is not hypothetical: re-extracting one document while the backfill
sweeps the same ecosistema is the intended way to use both tools.
`plan/adr-corpus-graph.md` §4.2.

- `graph_entities (organization_id, type, canonical_key)` **is** node identity
  (ADR §4.1, D5). Two concurrent extractions that both name "consulta previa"
  would otherwise create two nodes, and every support count over the graph is
  then split between them. That matters most for `GRAPH_MIN_SUPPORT` (§7.3.3),
  where a split count can drop a legitimate edge below the visibility
  threshold. The writer catches the losing INSERT and adopts the winner's row,
  so this index is what makes that recovery possible instead of a duplicate.
- `graph_mentions (document_id, entity_id)` keeps the table one row per
  **pair**, not per occurrence. Support is a count of DISTINCT DOCUMENTS, so a
  duplicated pair makes one document look like two independent sources.
- `graph_relations (document_id, from_entity_id, to_entity_id, type)` keeps one
  edge per document, for the same reason.
  ⚠ It does **not** collapse a symmetric `A→B` / `B→A` pair — those are
  genuinely different tuples. The writer orders the endpoints ascending for
  `relacionado_con` before insert, and that ordering is what makes this index
  cover the symmetric case too.

Verified the same way the baseline's were: `payload migrate` against a scratch
database, then deliberately conflicting `INSERT`s through `psql` to confirm each
one rejects the second write (and that a different `type` with the same
`canonical_key` is still allowed).

## 🔴 The corpus-graph migration also REWRITES eight foreign keys by hand

`migrate:create` emitted every graph foreign key as `ON DELETE set null`,
against columns it declared `NOT NULL` in the same statement. Postgres applies
the referential action first and only then checks the constraint, so the delete
raises `23502 null value in column "document_id" violates not-null constraint`.

Concretely: **`DELETE /api/documents/:id` 500s for any document extraction has
touched** — and because the delete never completes, `retireDeletedDocumentHook`
never runs either, so the document's chunks stay retrievable in ai-service while
the user believes it is gone.

A second `db.execute` block in `20260828_083851_corpus_graph.ts` drops and
recreates all eight with `ON DELETE cascade`, which is both correct here (a
mention is a statement *about* a document and is meaningless without it) and the
existing house pattern — every pre-existing FK pointing at `documents` in the
baseline is already `cascade`.

⚠ **The `.json` snapshot still says `set null`,** because the snapshot is
generated from Payload's drizzle schema and that is what the schema says. Same
class of divergence as the hand-written indexes, and the same consequence: a
`PAYLOAD_ALLOW_PUSH=1` boot can revert these to `set null` and re-break document
deletion silently. Verified by `DELETE`ing a document with mentions and
relations against the scratch database and confirming both cascade away while
the shared `graph_entities` rows survive.

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

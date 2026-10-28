# Migrations — the baseline exists

`20260908_092211_baseline.ts` is the first migration. It replaced an
eight-migration chain on 2026-09-08.

The chain since then:

| migration | what | hand-written part |
|---|---|---|
| `20261017_231817_documents_uploaded_in_session` | `documents.uploaded_in_session_id`, FK to `sessions` `ON DELETE set null` (the column is nullable, so that is correct here), and its index | SQL: none (the header comment is hand-written); no backfill, on purpose (the header says why) |
| `20261020_193707_ratings_fk_cascade` | all four `ratings` FKs (`message_id`, `session_id`, `organization_id`, `user_id`) rewritten to `ON DELETE cascade` | 🔴 SQL: ALL of it. `migrate:create` emitted an empty migration; the `.json` still says `set null`. See "The ratings foreign keys" below |
| `20261024_201817_graph_entities_public_figure` | `graph_entities.public_figure boolean DEFAULT false NOT NULL` — the persona public-figure mark; existing rows stay false (hidden) | SQL: none (the header comment is hand-written); no backfill, on purpose |
| `20261024_230631_documents_testimonio_title` | `documents.testimonio_title varchar` (nullable) — a testimonio's system-proposed title; NULL shows the fallback label | SQL: none (the header comment is hand-written); backfill is `scripts/backfill-testimonio-titles.ts`, not the migration |
| `20261027_002257_sessions_kind` | `sessions.kind` enum (`generales` \| `resonancias`) `DEFAULT 'generales' NOT NULL` + index — the conversation kind; existing rows become `generales` | SQL: none (the header comment is hand-written); no backfill |
| `20261027_053800_student_view` | `student_profiles` (two consent flags, default false) and `suggestions` (+ `enum_suggestions_kind`) — the student view | 🔴 SQL: removed the re-emitted `sessions.kind` statements; added UNIQUE `student_profiles_user_organization_unq`; `down` reordered (generated order failed). Up/down/up measured on a throwaway postgres:16 2026-10-26. Renamed from `053603` at integration (2026-10-26) so it sorts after `053737_memberships_role_estudiante`; `.json` prevId + `enum_memberships_role` hand-fixed to chain after it |
| `20261027_061014_student_view_fk_cascade` | `student_profiles.user_id` / `organization_id` and `suggestions.organization_id` FKs → `ON DELETE cascade`; `suggestions.author_id` nullable (stays `set null`: a suggestion survives its author, anonymous). Audit 2026-10-27 item 5: those NOT NULL + set null FKs refused user/ecosistema deletes (23502) | 🔴 SQL: the three cascade rewrites (generated: only `author_id DROP NOT NULL`); the `.json` still says `set null` for them; `.json` prevId hand-chained to `053800`. Up/down/up + `migrate:create` = "No schema changes" measured on a throwaway postgres:16 2026-10-27 |
| `20261027_225429_documents_public_figures` | `documents.keep_public_figures boolean` (nullable; NULL = the ecosistema's `keepPublicFigures`) and `documents.public_figures_kept jsonb` (the reviewers' log of kept public names) | SQL: none (the header comment is hand-written); no backfill. Up/down/up measured on a throwaway postgres:16 2026-10-27 |
| `20261028_054402_student_testimonio_consent` | `student_profiles.share_testimonios_at timestamptz` (nullable) — when a student accepted that the teacher report shows their testimonios, anonymised (owner ruling Q20); NULL = not given / withdrawn | SQL: none (the header comment is hand-written); no backfill, on purpose. Up/down/up + `migrate:create` = "No schema changes" measured on a throwaway postgres:16 2026-10-27 |
| `20261028_083327_student_testimonio_consent_version` | `student_profiles.share_testimonios_version numeric` (nullable) — the testimonio consent wording's version at acceptance (`lib/student/testimonioConsent.ts`); only the current version counts | SQL: none (the header comment is hand-written); no backfill, on purpose: consents under the earlier wording stay NULL and no longer count (fail-closed, owner ruling Q20). Up/down(all)/up measured on a throwaway postgres:16 2026-10-28; a second `migrate:create` after it generated nothing and waited at its create-anyway prompt (no file written) |
| `20261028_162050_organizations_answer_style` | `organizations.answer_style_generales`, `answer_style_resonancias`, `answer_style_interviewer` varchar (nullable) — the per-ecosistema answer style, one text per prompt (owner ruling 2026-10-28, `lib/answerStyle.ts`); NULL = the prompt unchanged | SQL: none (the header comment is hand-written); no backfill: the Discapacidad draft is `scripts/seed-answer-style.ts`. Up/down/up measured on a throwaway postgres:16 2026-10-28; a second `migrate:create` after it wrote no file |
| `20261028_170129_documents_wiki_links` | `documents.wiki_links jsonb` (nullable) — the `[[wikilinks]]` that attached to a note's graph (`lib/graph/wikilinks.ts`, owner ruling Q7); `graph_mentions.seeded boolean DEFAULT false NOT NULL` — a seed-only mention, never evidence for another note's seed | SQL: none (the header comment is hand-written); no backfill (old notes re-extract). Regenerated after `162050` (earlier cuts `083127`/`090800` never ran anywhere). Up/down/up + `migrate:create` = "No schema changes" measured on a throwaway postgres:16 2026-10-28 |

⚠ A migration file is frozen once committed, comments included. Nothing had ever been deployed
— no CI, no deploy script, and `edc_backend` on `localhost:45432` was the only
chain-aware database in existence — so the chain described a history no database
would ever replay.

This file used to say "there is no baseline yet" and describe how to make one,
and then said the same thing about `20260814_205354_baseline.ts`. Both are
preserved below under "How this got here", because the reasoning still matters
the next time someone is tempted to regenerate it.

## The rules now

🔴 **Push is off everywhere, by default, and no variable is needed to keep it
that way.** The gate in `payload.config.ts` is opt-IN —
`push: process.env.NODE_ENV !== 'test' && process.env.PAYLOAD_ALLOW_PUSH === '1'`
— so an environment that wants push has to say so out loud. It was opt-out until
2026-08-14, which meant one forgotten variable in one environment was enough to
lose the hand-written indexes below, silently. That is the wrong direction to
fail in. The backend's `start` script is `sh scripts/migrate.sh && next start` (the script
requires Payload's `Done.` line; a bare exit 0 is not proof), so a
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
Four arrived with the first baseline; three with the corpus graph.

All seven now live in `20260908_092211_baseline.ts`; the "arrived in" column
records which of the collapsed migrations first carried them, because that is
where the reasoning was written.

| index | table | columns | arrived in |
|---|---|---|---|
| `ratings_message_user_unq` | `ratings` | `message_id, user_id` | 2026-08-14 baseline |
| `memberships_user_organization_unq` | `memberships` | `user_id, organization_id` | 2026-08-14 baseline |
| `ai_service_callbacks_natural_key_unq` | `ai_service_callbacks` | `correlation_key, event_key, event` | 2026-08-14 baseline |
| `documents_organization_publication_status_idx` | `documents` | `organization_id, publication_status` | 2026-08-14 baseline |
| `graph_entities_org_type_key_unq` | `graph_entities` | `organization_id, type, canonical_key` | `20260829_203018_corpus_graph` |
| `graph_mentions_document_entity_unq` | `graph_mentions` | `document_id, entity_id` | `20260829_203018_corpus_graph` |
| `graph_relations_document_edge_unq` | `graph_relations` | `document_id, from_entity_id, to_entity_id, type` | `20260829_203018_corpus_graph` |

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

## 🔴 The baseline also REWRITES eleven foreign keys by hand

Eight of them arrived with `20260829_203018_corpus_graph` and were carried
forward verbatim. **Three are new on 2026-09-08** and are the subject of the
next section — read that one too.

`migrate:create` emitted every graph foreign key as `ON DELETE set null`,
against columns it declared `NOT NULL` in the same statement. Postgres applies
the referential action first and only then checks the constraint, so the delete
raises `23502 null value in column "document_id" violates not-null constraint`.

Concretely: **`DELETE /api/documents/:id` 500s for any document extraction has
touched** — and because the delete never completes, `retireDeletedDocumentHook`
never runs either, so the document's chunks stay retrievable in ai-service while
the user believes it is gone.

A second `db.execute` block in `20260908_092211_baseline.ts` drops and
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

## 🔴 `anonymisation_reviews` had the same defect for eleven days

Found on 2026-09-08 while cutting this baseline, by checking `pg_constraint` on
the live `edc_backend` rather than by reading the migration. All three foreign
keys on `anonymisation_reviews` were `confdeltype = 'n'` (SET NULL) against
columns that are all `NOT NULL`:

- `anonymisation_reviews_document_id_documents_id_fk`
- `anonymisation_reviews_organization_id_organizations_id_fk`
- `anonymisation_reviews_reviewer_id_users_id_fk`

Identical mechanism, identical blast radius: deleting a document that has a
review row raises `23502`, `DELETE /api/documents/:id` 500s,
`retireDeletedDocumentHook` never runs, and the document's chunks stay
retrievable in ai-service while the user believes it is gone. The table already
held 6 rows when this was found. **`20260828_191401_anonymisation_review.ts`
shipped the bug and nobody caught it**, because that migration was reviewed as
generated output rather than checked against `pg_constraint`.

⚠ **This one is a FIX, not a copy-forward.** It is applied for the first time in
`20260908_092211_baseline.ts`, and it was applied to the live `edc_backend` by
hand as well — that database was STAMPED with the baseline, not migrated by it,
and a stamp applies no DDL.

⚠ **Check `pg_constraint`, not the generated SQL, whenever a migration adds a
required relationship.** The generator's default is wrong for every one of them.

```sql
-- Every FK that would 23502 on a parent delete.
SELECT c.conrelid::regclass AS tbl, c.conname, a.attname
FROM pg_constraint c
JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
WHERE c.contype = 'f' AND c.confdeltype = 'n' AND a.attnotnull;
```

🟡 **That query still returns rows, and they were left alone deliberately.**
`documents`, `media`, `sessions`, `memberships` and `teams` (and `ratings`
until `20261020_193707_ratings_fk_cascade`) all point
at `organizations` (and several at `users`) with SET NULL against NOT NULL
columns, inherited from the 2026-08-14 baseline. The consequence is narrower:
**deleting an organization or a user is broken**, and neither is a product
operation today — there is no route for either. Fixing them means choosing
between CASCADE (deleting an ecosistema deletes its corpus) and RESTRICT (a
readable refusal), and that is a product decision, not a migration cleanup.
Verified on the scratch database: `DELETE FROM organizations` fails on
`memberships.organization_id` before it reaches anything else.

## 🔴 The ratings foreign keys are hand-written too (2026-10-20)

`20261020_193707_ratings_fk_cascade` drops and recreates the four `ratings`
foreign keys with `ON DELETE cascade`. Before it, a rated message, an
ecosistema with ratings and a user who ever rated could not be deleted
(23502; audit 2026-10-17 §3 item 9). A user's ratings are DELETED, not
anonymised; the migration header says why.

Made the same way as the baseline's FK rewrites, and with the same two
consequences: a regenerated baseline will not carry it, and a
`PAYLOAD_ALLOW_PUSH=1` boot can revert it to `set null`. Checked on
2026-10-20: `migrate:create --skip-empty` wrote nothing before this migration
(no drift between the config and the latest `.json`), and
`migrate:create --force-accept-warning` produced a `.json` that differs from
the previous one in its `id` only. `collections/Ratings.deletePaths.pg.test.ts`
pins the four `confdeltype = 'c'`, the three deletes, and a `down()`/`up()`
round trip that reproduces the old 23502.

⚠ **It does not make a user or an ecosistema deletable by itself.** The 23502
query above still lists `sessions`, `memberships`, `documents`, `media` and
`teams`. That test pins that too.

## ✅ The corpus-label columns have NO hand-written part

`documents.tema` and `documents.lengua` — the corpus's own theme and language
ground truth, which the product had nowhere to store until now. They arrived in
`20260905_060357_document_corpus_labels` and are now part of the baseline. Two
nullable `varchar` columns, no enum, no index, no constraint. **Fully generated,
so a regeneration has nothing to copy forward and `PAYLOAD_ALLOW_PUSH=1` has
nothing to drop.** Recorded here because the lists above are where someone
checks, and "this one is safe" is worth being able to read.

⚠ **Neither column is an enum, and that is deliberate.** `tema` is a closed set
of four *today* (`traduccion|dengue|escuela|discapacidad`), which makes a Payload
`select` look obvious. But those values come from `corpus-generativo`, a separate
repo regenerated by a script — a fifth theme would fail the seed on row 1 with
`invalid input value for enum`, and adding one means an `ALTER TYPE` migration.
Nothing in the product branches on either value. See the field headers in
`collections/Documents.ts`.

⚠ **`documents.lengua` is not just a column.** It is NULL for anything that is
not a `documento`, enforced twice — a `beforeValidate` hook that internal writers
cannot skip, and field `read` access. A migration that ever makes it `NOT NULL`,
or a push that drops the collection's hooks, breaks a privacy rule rather than a
default. The reasoning is on the field.

🔴 **The seeded rows are NOT backfilled by any migration**, on purpose: the
values come from a manifest in another checkout, not from anything Postgres can
compute. `src/seed/backfillCorpusLabels.cli.ts` is a separate, dry-run-by-default
pass the owner runs by hand. It was run against `edc_backend` on 2026-09-08:
285 scanned, 250 updated (191 joined on a SIM id, 59 on their seeded title), 35
rows not seeded by the corpus left untouched.

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

The chain has been collapsed twice. Both times for the same reason — no
database anywhere would ever replay it — and both times the hand-written SQL
was the entire risk of the operation.

### 2026-09-08 — the second collapse, eight migrations into one

The chain ran `20260814_205354_baseline` → `20260905_060357_document_corpus_labels`.
It was collapsed because **nothing had ever been deployed**: no CI, no deploy
script, `infra/fleet/topology.md`, `runbook.md`, `env-manifests.md` and
`plan/deploy-and-local-demo.md` all say so, local `main` was 76 commits ahead of
an unpushed `origin/main`, and `edc_backend` on `localhost:45432` was the only
chain-aware database in existence.

Order matters and this is the order it was done in:

1. **`20260905_060357_document_corpus_labels` was applied first.** It was
   committed but never run — `documents.tema` and `documents.lengua` did not
   exist. The database has to match HEAD's config *before* the stamp in step 6,
   or the stamp records something untrue.
2. **`src/seed/backfillCorpusLabels.cli.ts --organization=1 --apply`**, so
   `tema` and `lengua` actually hold values. 250 rows updated.
3. **`rm src/migrations/*.ts src/migrations/*.json`, then
   `payload migrate:create baseline`.** With no `.json` snapshot on disk,
   `migrate:create` diffs against an empty schema and emits a full CREATE. It
   **never connects to a database** (`disableDBConnect`) — verified by running
   it with `DATABASE_URI` pointing at a database that does not exist, which
   succeeded.
4. **The hand-written SQL was restored from `git show HEAD:…`, not retyped.**
   15 statements: 4 indexes from the 2026-08-14 baseline, 3 indexes and 8
   rewritten foreign keys from `20260829_203018_corpus_graph`.
5. **Three `anonymisation_reviews` foreign keys were fixed** — see that section
   above. New work, not a copy-forward.
6. **Verified on a throwaway database**, the way the 2026-08-14 baseline was:
   `payload migrate` into a fresh `edc_scratch_baseline`, then deliberately
   conflicting `INSERT`s for all seven unique indexes (each rejected the second
   write; a matching `canonical_key` under a different `type`, and a matching
   edge under a different relation `type`, were both still allowed), then a
   `DELETE` of a document carrying a mention, two relations and a review row —
   all four cascaded away, the shared `graph_entities` rows survived, and
   deleting the reviewer cascaded the review too. `migrate:down` then `migrate`
   round-tripped cleanly. A `pg_dump --schema-only` diff against the live
   `edc_backend` came back identical apart from column ORDER and the three
   foreign keys step 5 fixes. The scratch database was dropped.
7. **`edc_backend` was STAMPED, not migrated** — it already had the schema, and
   re-running the baseline against it would have dropped a graph worth ~6.6 h
   and ~$0.81 of LLM extraction (788 entities, 3065 mentions, 2502 relations,
   all confirmed untouched afterwards):
   ```sql
   DELETE FROM payload_migrations;
   INSERT INTO payload_migrations (name, batch, created_at, updated_at)
   VALUES ('20260908_092211_baseline', 1, now(), now());
   ```
   ⚠ **A stamp applies no DDL.** Step 5's three `ALTER TABLE`s were run against
   `edc_backend` by hand in the same transaction, and confirmed with
   `pg_constraint`.

**Two things were deliberately NOT carried forward.** Both are *data*
migrations over rows a fresh schema does not have:

- `20260828_080049`'s `documents_rels` backfill. It `SELECT`s from
  `documents.session_id`, a column the baseline never creates.
- `20260828_081504`'s `UPDATE messages SET corpus_status = 'skipped'`. It
  existed to classify messages that predated the column; the column's `DEFAULT
  'pending'` is correct for every row created from here on.

⚠ **One drift was found and left alone.** `edc_backend` still carries
`documents.session_id` (32 non-NULL values), its index and its foreign key,
even though `20260828_080049` dropped that column and ran successfully. Nothing
in HEAD's config knows the column, it is nullable, and its FK is SET NULL
against a nullable column, so it is inert. It is recorded here rather than
dropped, because dropping it destroys 32 values nobody has explained yet —
`documents_rels` holds 34 session links, so it is probably a subset, but
"probably" is not a reason to delete data on a shared database.

### 2026-08-14 — the first collapse, and why `index.ts` was empty before it

This repo was assembled from two Payload apps, each of which arrived with its
own baseline migration describing its own schema. Those two baselines could not
be sequenced together — they create overlapping tables (`users`, `projects`)
with different shapes, and the second would fail against the first. **Both were
deleted**, because the alternative is a migration history that describes a
database nobody will ever have.

`index.ts` then exported an empty array on purpose until 2026-08-14, when
`20260814_205354_baseline` was generated from an empty `edc_backend` that a
push-enabled boot had just built from the config. It was verified by dropping
and recreating that database, running `payload migrate`, and inserting
deliberately conflicting rows through `psql` to confirm each unique index
actually rejects the second write.

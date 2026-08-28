import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * `documents.session` goes PLURAL — a document can be attached to several
 * conversations at once.
 *
 * Attaching is SHARING, never moving: a document stays in every conversation it
 * was already in. That is what lets retrieval narrow a DRAFT to the
 * conversations it belongs to without ever hiding it from one that was already
 * using it. See the field comment in `collections/Documents.ts`.
 *
 * ── 🔴 THE COPY STEP IS HAND-WRITTEN, AND WITHOUT IT THIS MIGRATION IS DATA LOSS
 *
 * Going `hasMany` moves the attachment from a COLUMN (`documents.session_id`)
 * to a JOIN TABLE (`documents_rels`). `payload migrate:create` emits both the
 * `CREATE TABLE` and the `ALTER TABLE … DROP COLUMN` — and nothing in between.
 * The generator diffs two SCHEMAS; it has no idea the old column and the new
 * table hold the same fact, so it cannot emit a copy and never will. Run as
 * generated, this migration silently detaches every existing document from its
 * conversation.
 *
 * So `up()` is deliberately three statements instead of one:
 *
 *   1. build `documents_rels` (with its FKs and indexes),
 *   2. COPY every non-null `documents.session_id` into it,   ← hand-written
 *   3. only then drop the column.
 *
 * Payload runs a migration inside a transaction, so the three are still atomic.
 *
 * `order = 1` because a row that had one session has one attachment, and
 * Payload's own writer numbers a `hasMany` list from 1
 * (`@payloadcms/drizzle` → `transform/write/relationships.js`). `path` is the
 * FIELD NAME, `'session'` (same package, `transform/write/traverseFields.js`:
 * `relationshipPath = \`${path || ''}${field.name}\``).
 *
 * ⚠ Verified against the dev database at the time this was cut: 78 document
 * rows, 32 with a `session_id`, and the copy produced exactly 32 join rows. The
 * 46 nulls are e2e leftovers whose sessions were deleted.
 *
 * ── ⚠ THE FK's DELETE BEHAVIOUR CHANGES, AND THE NEW ONE IS THE ONE WE WANT
 *
 * Old: `documents.session_id → sessions.id ON DELETE SET NULL`. Deleting a
 * conversation NULLed the column and left the document standing.
 *
 * New: `documents_rels.sessions_id → sessions.id ON DELETE CASCADE`. Deleting a
 * conversation removes the JOIN ROW — the attachment — and the document row is
 * untouched. Same outcome for the document, expressed on the right table.
 *
 * 🔴 `ON DELETE CASCADE` here does NOT delete documents. It deletes
 * attachments. `documents_rels.parent_id → documents.id ON DELETE CASCADE` is
 * the other direction: deleting a document takes its own attachments with it.
 * Neither ever removes a document because a conversation went away, which is
 * the guarantee `collections/Sessions.ts` depends on.
 *
 * ── ⚠ THE FOUR HAND-WRITTEN INDEXES ARE NOT TOUCHED
 *
 * `src/migrations/README.md` lists four indexes that exist in the baseline but
 * not in the drizzle schema, so a generated migration cannot see them and could
 * drop them. Checked against the emitted SQL: the only index dropped here is
 * `documents_session_idx`, which Payload itself emitted from `index: true` on
 * the old scalar column and which `documents_rels_sessions_id_idx` replaces.
 * `documents_organization_publication_status_idx` and the three `_unq` ones are
 * untouched.
 *
 * ── ⚠ DOWN IS LOSSY, AND IT HAS TO BE
 *
 * A column holds one session. A document attached to three cannot go back
 * whole, so `down()` keeps the FIRST attachment (lowest `order`) and drops the
 * rest. Recorded here rather than discovered: rolling this back after people
 * have shared documents across conversations throws away the extra
 * attachments.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  // 1. The join table, its FKs and its indexes. Straight from the generator.
  await db.execute(sql`
   CREATE TABLE "documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"sessions_id" integer
  );

  ALTER TABLE "documents" DROP CONSTRAINT "documents_session_id_sessions_id_fk";

  DROP INDEX "documents_session_idx";
  ALTER TABLE "documents_rels" ADD CONSTRAINT "documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "documents_rels" ADD CONSTRAINT "documents_rels_sessions_fk" FOREIGN KEY ("sessions_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "documents_rels_order_idx" ON "documents_rels" USING btree ("order");
  CREATE INDEX "documents_rels_parent_idx" ON "documents_rels" USING btree ("parent_id");
  CREATE INDEX "documents_rels_path_idx" ON "documents_rels" USING btree ("path");
  CREATE INDEX "documents_rels_sessions_id_idx" ON "documents_rels" USING btree ("sessions_id");`)

  // 2. 🔴 HAND-WRITTEN. Carry every existing attachment over BEFORE the column
  //    that holds it is dropped. The generator cannot emit this — see the
  //    header. Deleting these two lines is deleting every document's
  //    conversation.
  await db.execute(sql`
    INSERT INTO "documents_rels" ("order", "parent_id", "path", "sessions_id")
    SELECT 1, "id", 'session', "session_id" FROM "documents" WHERE "session_id" IS NOT NULL;`)

  // 3. Now the column is redundant.
  await db.execute(sql`
    ALTER TABLE "documents" DROP COLUMN "session_id";`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // 1. Put the column back, empty.
  await db.execute(sql`
    ALTER TABLE "documents" ADD COLUMN "session_id" integer;`)

  // 2. 🔴 HAND-WRITTEN, and LOSSY BY CONSTRUCTION. One column, one session:
  //    keep the first attachment and drop the rest. `DISTINCT ON` with an
  //    explicit ORDER BY makes "first" deterministic rather than whatever the
  //    planner returned that day.
  await db.execute(sql`
    UPDATE "documents" AS d
    SET "session_id" = r."sessions_id"
    FROM (
      SELECT DISTINCT ON ("parent_id") "parent_id", "sessions_id"
      FROM "documents_rels"
      WHERE "path" = 'session' AND "sessions_id" IS NOT NULL
      ORDER BY "parent_id", "order" NULLS LAST, "id"
    ) AS r
    WHERE d."id" = r."parent_id";`)

  // 3. Restore the old constraint + index, then drop the join table.
  await db.execute(sql`
   ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "documents_session_idx" ON "documents" USING btree ("session_id");
  ALTER TABLE "documents_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "documents_rels" CASCADE;`)
}

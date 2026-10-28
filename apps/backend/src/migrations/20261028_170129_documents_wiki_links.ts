import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Wikilink graph seeds (owner ruling Q7, 2026-10-28).
 *   · `documents.wiki_links` jsonb, nullable: the `[[wikilinks]]` of a note
 *     that attached to its graph (`lib/graph/wikilinks.ts`), as
 *     `{ label, occurrences }[]`; `[]` when judged and none attached. Raw
 *     targets are never stored.
 *   · `graph_mentions.seeded` boolean DEFAULT false NOT NULL: true for a
 *     mention only a seed put there. Only `seeded = false` mentions make a
 *     node "live" for another note's seed. Existing rows are model-written,
 *     so `false` is correct for them.
 * Emitted by `payload migrate:create`; no backfill: old notes get seeds from a
 * normal re-extraction.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "wiki_links" jsonb;
  ALTER TABLE "graph_mentions" ADD COLUMN "seeded" boolean DEFAULT false NOT NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP COLUMN "wiki_links";
  ALTER TABLE "graph_mentions" DROP COLUMN "seeded";`)
}

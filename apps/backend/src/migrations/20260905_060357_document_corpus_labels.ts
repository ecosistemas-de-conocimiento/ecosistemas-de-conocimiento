import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" ADD COLUMN "tema" varchar;
  ALTER TABLE "documents" ADD COLUMN "lengua" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "documents" DROP COLUMN "tema";
  ALTER TABLE "documents" DROP COLUMN "lengua";`)
}

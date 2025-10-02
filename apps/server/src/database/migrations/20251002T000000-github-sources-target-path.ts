import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Add target_path column to github_sources table
  await db.schema
    .alterTable('github_sources')
    .addColumn('target_path', 'varchar(500)', (col) => col.notNull().defaultTo(''))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Remove target_path column
  await db.schema
    .alterTable('github_sources')
    .dropColumn('target_path')
    .execute();
}

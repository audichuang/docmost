import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('github_webhook_events')
    .addColumn('processed_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('github_webhook_events')
    .dropColumn('processed_at')
    .execute();
}


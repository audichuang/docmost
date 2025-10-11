import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Allow 'folder' as a content_type for directory placeholder pages
  await sql`ALTER TABLE "github_files" DROP CONSTRAINT IF EXISTS "github_files_content_type_check"`.execute(
    db,
  );
  await sql`ALTER TABLE "github_files" ADD CONSTRAINT "github_files_content_type_check" CHECK (content_type in ('markdown','asset','folder'))`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  // Revert to original constraint
  await sql`ALTER TABLE "github_files" DROP CONSTRAINT IF EXISTS "github_files_content_type_check"`.execute(
    db,
  );
  await sql`ALTER TABLE "github_files" ADD CONSTRAINT "github_files_content_type_check" CHECK (content_type in ('markdown','asset'))`.execute(
    db,
  );
}

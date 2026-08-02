import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // B1: the original constraint only stopped the same workspace from linking
  // an installation twice. It did nothing to stop installation A from being
  // linked into *both* workspace X and workspace Y — and since any workspace
  // admin can mint that installation's token once linked, that let workspace
  // Y read workspace X's private repos. An installation belongs to exactly
  // one GitHub account, so it must belong to exactly one workspace here too.
  //
  // If the pre-fix window already let two workspaces claim the same
  // installation, keep only the earliest link (the original, presumably
  // legitimate, linker) and drop the later duplicate(s) before the new
  // constraint can be added.
  await sql`
    delete from github_installations gi
    using github_installations earlier
    where gi.installation_id = earlier.installation_id
      and (gi.created_at, gi.id) > (earlier.created_at, earlier.id)
  `.execute(db);

  await db.schema
    .alterTable('github_installations')
    .dropConstraint('github_installations_ws_installation_id_unique')
    .execute();

  await db.schema
    .alterTable('github_installations')
    .addUniqueConstraint('github_installations_installation_id_unique', [
      'installation_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('github_installations')
    .dropConstraint('github_installations_installation_id_unique')
    .execute();

  await db.schema
    .alterTable('github_installations')
    .addUniqueConstraint('github_installations_ws_installation_id_unique', [
      'workspace_id',
      'installation_id',
    ])
    .execute();
}

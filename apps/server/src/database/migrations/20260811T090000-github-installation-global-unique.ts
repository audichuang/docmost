import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // B1: the original constraint only stopped the same workspace from linking
  // an installation twice. It did nothing to stop installation A from being
  // linked into *both* workspace X and workspace Y — and since any workspace
  // admin can mint that installation's token once linked, that let workspace
  // Y read workspace X's private repos. An installation belongs to exactly
  // one GitHub account, so it must belong to exactly one workspace here too.
  //
  // Refuse to guess. Auto-deleting the "later" row assumes the earliest link
  // is the legitimate one, which is exactly backwards if an attacker bound the
  // installation first — and the delete cascades that workspace's sources
  // away with it. An operator has to decide which workspace keeps it.
  const duplicates = await sql<{ installation_id: string; workspaces: number }>`
    select installation_id, count(distinct workspace_id)::int as workspaces
    from github_installations
    group by installation_id
    having count(distinct workspace_id) > 1
  `.execute(db);

  if (duplicates.rows.length > 0) {
    const ids = duplicates.rows.map((r) => r.installation_id).join(', ');
    throw new Error(
      'Cannot enforce one workspace per GitHub installation: these ' +
        `installation_ids are linked to more than one workspace (${ids}). ` +
        'Remove the incorrect links in github_installations, then re-run.',
    );
  }

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

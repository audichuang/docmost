import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // 1) github_installations
  await db.schema
    .createTable('github_installations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('app_id', 'varchar', (col) => col.notNull())
    .addColumn('installation_id', 'varchar', (col) => col.notNull())
    .addColumn('account_login', 'varchar', (col) => col.notNull())
    .addColumn('account_type', 'varchar', (col) => col.notNull()) // 'User' | 'Organization'
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('github_installations_ws_installation_id_unique', [
      'workspace_id',
      'installation_id',
    ])
    .addCheckConstraint(
      'github_installations_account_type_check',
      sql`("account_type" in ('User','Organization'))`,
    )
    .execute();

  // 2) github_sources
  await db.schema
    .createTable('github_sources')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('github_installation_id', 'uuid', (col) =>
      col.references('github_installations.id').onDelete('cascade').notNull(),
    )
    .addColumn('owner', 'varchar', (col) => col.notNull())
    .addColumn('repo', 'varchar', (col) => col.notNull())
    .addColumn('ref', 'varchar', (col) => col.notNull())
    .addColumn('root_dir', 'varchar', (col) => col.notNull().defaultTo(''))
    .addColumn('root_page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('mode', 'varchar', (col) => col.notNull().defaultTo('readonly'))
    .addColumn('active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('last_full_scan_sha', 'varchar')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('github_sources_unique_source', [
      'space_id',
      'owner',
      'repo',
      'ref',
      'root_dir',
    ])
    .execute();

  await db.schema
    .createIndex('idx_github_sources_github_installation')
    .on('github_sources')
    .column('github_installation_id')
    .execute();
  await db.schema
    .createIndex('idx_github_sources_workspace_updated_at')
    .on('github_sources')
    .columns(['workspace_id', 'updated_at'])
    .execute();

  // 3) github_files
  await db.schema
    .createTable('github_files')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('source_id', 'uuid', (col) =>
      col.references('github_sources.id').onDelete('cascade').notNull(),
    )
    .addColumn('path', 'text', (col) => col.notNull())
    .addColumn('content_type', 'varchar', (col) => col.notNull()) // 'markdown' | 'asset'
    .addColumn('page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('sha', 'varchar')
    .addColumn('etag', 'varchar')
    .addColumn('title', 'text')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('synced')) // 'synced' | 'deleted' | 'error'
    .addColumn('renamed_from_path', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('github_files_source_path_unique', ['source_id', 'path'])
    .addCheckConstraint(
      'github_files_content_type_check',
      sql`("content_type" in ('markdown','asset'))`,
    )
    .addCheckConstraint(
      'github_files_status_check',
      sql`("status" in ('synced','deleted','error'))`,
    )
    .execute();

  await db.schema
    .createIndex('idx_github_files_source_sha')
    .on('github_files')
    .columns(['source_id', 'sha'])
    .execute();
  await db.schema
    .createIndex('idx_github_files_source_updated_at')
    .on('github_files')
    .columns(['source_id', 'updated_at'])
    .execute();

  // 4) github_webhook_events
  await db.schema
    .createTable('github_webhook_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_uuid_v7()`))
    .addColumn('github_installation_id', 'uuid', (col) =>
      col.references('github_installations.id').onDelete('set null'),
    )
    .addColumn('delivery_id', 'varchar', (col) => col.notNull())
    .addColumn('event', 'varchar', (col) => col.notNull())
    .addColumn('repo_full_name', 'varchar')
    .addColumn('before_sha', 'varchar')
    .addColumn('after_sha', 'varchar')
    .addColumn('files_json', 'jsonb')
    .addColumn('processed', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('ok', 'boolean')
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('github_webhook_events_delivery_unique', ['delivery_id'])
    .execute();

  await db.schema
    .createIndex('idx_github_webhook_events_created_at')
    .on('github_webhook_events')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_github_webhook_events_created_at').on('github_webhook_events').execute();
  await db.schema.dropTable('github_webhook_events').execute();

  await db.schema.dropIndex('idx_github_files_source_updated_at').on('github_files').execute();
  await db.schema.dropIndex('idx_github_files_source_sha').on('github_files').execute();
  await db.schema.dropTable('github_files').execute();

  await db.schema.dropIndex('idx_github_sources_workspace_updated_at').on('github_sources').execute();
  await db.schema.dropIndex('idx_github_sources_github_installation').on('github_sources').execute();
  await db.schema.dropTable('github_sources').execute();

  await db.schema.dropTable('github_installations').execute();
}

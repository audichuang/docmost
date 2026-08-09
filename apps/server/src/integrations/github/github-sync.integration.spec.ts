import { Kysely, CamelCasePlugin, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { GithubSyncService } from './github-sync.service';
import { GITHUB_LOCK_NAMESPACE, githubLockKey } from './github.utils';

/**
 * The behaviours these fixes hinge on are Postgres behaviours, not TypeScript
 * ones: a transaction-scoped advisory lock actually excluding a second writer,
 * ON DELETE CASCADE reaching github_files, removePage's recursive CTE taking a
 * subtree with it, and a `not exists` correlated subquery deciding which pages
 * to unlock. A fluent mock asserts none of that — it asserts that the code
 * calls the methods the test author expected. So these run against a real
 * database, and are skipped (loudly) when one isn't configured.
 *
 *   createdb docmost_github_test
 *   DATABASE_URL=postgres://…/docmost_github_test pnpm --filter ./apps/server migration:latest
 *   GITHUB_TEST_DATABASE_URL=postgres://…/docmost_github_test npx jest --testPathPatterns integration
 */
const TEST_DB_URL = process.env.GITHUB_TEST_DATABASE_URL;
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[github integration] GITHUB_TEST_DATABASE_URL is not set — skipping the ' +
      'database-backed tests. They are the only ones that exercise the ' +
      'advisory lock, the cascades and the subtree deletion.',
  );
}

describeWithDb('GithubSyncService against a real database', () => {
  let db: KyselyDB;
  let sqlClient: ReturnType<typeof postgres>;
  let service: GithubSyncService;
  let pageService: { updatePageContent: jest.Mock; nextPagePosition: jest.Mock };

  // one workspace per run; every test builds its own space/pages beneath it
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    sqlClient = postgres(TEST_DB_URL, { max: 5, onnotice: () => {} });
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({ postgres: sqlClient }),
      plugins: [new CamelCasePlugin()],
    }) as unknown as KyselyDB;

    const pageRepo = new PageRepo(db, {} as any, { emit: () => true } as any);
    pageService = {
      updatePageContent: jest.fn().mockResolvedValue(undefined),
      nextPagePosition: jest.fn().mockResolvedValue('a0'),
    };

    service = new GithubSyncService(
      db,
      { invalidateToken: jest.fn(), getInstallationInfo: jest.fn() } as any,
      {} as any,
      pageService as any,
      pageRepo,
      {} as any,
    );

    workspaceId = uuidv7();
    await db
      .insertInto('workspaces')
      .values({ id: workspaceId, name: 'gh-int-test' } as any)
      .execute();

    userId = uuidv7();
    await db
      .insertInto('users')
      .values({
        id: userId,
        name: 'owner',
        email: `gh-int-${userId}@example.test`,
        role: 'owner',
        workspaceId,
      } as any)
      .execute();
  });

  afterAll(async () => {
    if (workspaceId) {
      await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
    }
    await db.destroy();
  });

  // ------------------------------------------------------------- fixtures

  /** uuidv7 starts with a timestamp, so a prefix collides between two rows
   *  created in the same millisecond — unique columns need the random tail. */
  const shortId = (id: string) => id.replace(/-/g, '').slice(-12);

  async function createSpace(): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('spaces')
      .values({
        id,
        name: `space-${shortId(id)}`,
        slug: `s-${shortId(id)}`,
        workspaceId,
        creatorId: userId,
      } as any)
      .execute();
    return id;
  }

  async function createPage(
    spaceId: string,
    opts: { parentPageId?: string; isLocked?: boolean; title?: string } = {},
  ): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('pages')
      .values({
        id,
        slugId: shortId(id),
        title: opts.title ?? 'page',
        spaceId,
        workspaceId,
        creatorId: userId,
        parentPageId: opts.parentPageId ?? null,
        isLocked: opts.isLocked ?? false,
        position: 'a0',
      } as any)
      .execute();
    return id;
  }

  async function createInstallation(): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('githubInstallations')
      .values({
        id,
        workspaceId,
        appId: '1',
        // installation_id is globally unique, so keep it per-row
        installationId: `inst-${shortId(id)}`,
        accountLogin: 'acme',
        accountType: 'Organization',
      } as any)
      .execute();
    return id;
  }

  async function createSource(
    spaceId: string,
    installationRowId: string,
    opts: { repo?: string; rootDir?: string; rootPageId?: string } = {},
  ): Promise<{ id: string; owner: string; repo: string; ref: string }> {
    const id = uuidv7();
    const repo = opts.repo ?? `docs-${shortId(id)}`;
    await db
      .insertInto('githubSources')
      .values({
        id,
        workspaceId,
        spaceId,
        githubInstallationId: installationRowId,
        owner: 'acme',
        repo,
        ref: 'main',
        rootDir: opts.rootDir ?? '',
        rootPageId: opts.rootPageId ?? null,
        creatorId: userId,
      } as any)
      .execute();
    return { id, owner: 'acme', repo, ref: 'main' };
  }

  async function mapFile(
    sourceId: string,
    path: string,
    contentType: 'markdown' | 'folder' | 'asset',
    pageId: string | null,
    status: 'synced' | 'error' | 'deleted' = 'synced',
  ) {
    await db
      .insertInto('githubFiles')
      .values({
        id: uuidv7(),
        sourceId,
        path,
        contentType,
        pageId,
        status,
        sha: 'sha-1',
      } as any)
      .execute();
  }

  async function pageRow(pageId: string) {
    return db
      .selectFrom('pages')
      .select(['id', 'isLocked', 'deletedAt', 'parentPageId'])
      .where('id', '=', pageId)
      .executeTakeFirst();
  }

  async function mappingStatus(sourceId: string, path: string) {
    const row = await db
      .selectFrom('githubFiles')
      .select(['status'])
      .where('sourceId', '=', sourceId)
      .where('path', '=', path)
      .executeTakeFirst();
    return row?.status;
  }

  const actor = () => ({ id: userId }) as any;

  // ------------------------------------------------------- deleteSource

  it('unlocks the pages of a removed source, and the mappings cascade away', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);

    const pageA = await createPage(spaceId, { isLocked: true });
    const pageB = await createPage(spaceId, { isLocked: true });
    await mapFile(source.id, 'a.md', 'markdown', pageA);
    await mapFile(source.id, 'b.md', 'markdown', pageB);

    await service.deleteSource(workspaceId, source.id);

    expect((await pageRow(pageA)).isLocked).toBe(false);
    expect((await pageRow(pageB)).isLocked).toBe(false);
    // pages survive — only the mapping is gone
    expect((await pageRow(pageA)).deletedAt).toBeNull();

    const sourceGone = await db
      .selectFrom('githubSources')
      .select(['id'])
      .where('id', '=', source.id)
      .executeTakeFirst();
    expect(sourceGone).toBeUndefined();

    const mappingsGone = await db
      .selectFrom('githubFiles')
      .select(['id'])
      .where('sourceId', '=', source.id)
      .execute();
    expect(mappingsGone).toHaveLength(0);
  });

  /**
   * Two sources can be mounted on the same page. Unlocking it when only one of
   * them goes away would invite edits the survivor overwrites on its next run.
   */
  it('leaves a page locked while another live source still mirrors it', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const sourceA = await createSource(spaceId, installation, { repo: 'repo-a' });
    const sourceB = await createSource(spaceId, installation, { repo: 'repo-b' });

    const shared = await createPage(spaceId, { isLocked: true });
    const onlyA = await createPage(spaceId, { isLocked: true });
    await mapFile(sourceA.id, 'README.md', 'markdown', shared);
    await mapFile(sourceB.id, 'README.md', 'markdown', shared);
    await mapFile(sourceA.id, 'solo.md', 'markdown', onlyA);

    await service.deleteSource(workspaceId, sourceA.id);

    expect((await pageRow(shared)).isLocked).toBe(true);
    expect((await pageRow(onlyA)).isLocked).toBe(false);
  });

  it('refuses to remove a source while the repo/ref lock is held elsewhere', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);
    const page = await createPage(spaceId, { isLocked: true });
    await mapFile(source.id, 'a.md', 'markdown', page);

    // a second connection standing in for a sync already running on any node
    const holder = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
    const key = githubLockKey(source.owner, source.repo, source.ref);

    try {
      // `as any`: this package's namespace import loses the tagged-template
      // call signature on the transaction handle
      await (holder as any).begin(async (tx: any) => {
        const [{ locked }] = await tx`
          select pg_try_advisory_xact_lock(${GITHUB_LOCK_NAMESPACE}::int, hashtext(${key})) as locked
        `;
        expect(locked).toBe(true);

        await expect(
          service.deleteSource(workspaceId, source.id),
        ).rejects.toThrow('github_sync_in_progress');
      });
    } finally {
      await holder.end();
    }

    // nothing half-done: the source is still there and still locked
    expect((await pageRow(page)).isLocked).toBe(true);
    expect(await mappingStatus(source.id, 'a.md')).toBe('synced');

    // and once the lock is free the same call succeeds
    await service.deleteSource(workspaceId, source.id);
    expect((await pageRow(page)).isLocked).toBe(false);
  });

  // ------------------------------------------------- deleteInstallation

  it('unlocks pages before the installation cascade removes their sources', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);

    const page = await createPage(spaceId, { isLocked: true });
    await mapFile(source.id, 'a.md', 'markdown', page);

    await service.deleteInstallation(workspaceId, installation);

    expect((await pageRow(page)).isLocked).toBe(false);
    expect((await pageRow(page)).deletedAt).toBeNull();

    const installationGone = await db
      .selectFrom('githubInstallations')
      .select(['id'])
      .where('id', '=', installation)
      .executeTakeFirst();
    expect(installationGone).toBeUndefined();

    const sourceGone = await db
      .selectFrom('githubSources')
      .select(['id'])
      .where('id', '=', source.id)
      .executeTakeFirst();
    expect(sourceGone).toBeUndefined();
  });

  // -------------------------------------------------- pruneStaleFolders

  it('removes a folder page whose directory lost its last file', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);

    const keptFolder = await createPage(spaceId, { isLocked: true, title: 'kept' });
    const staleFolder = await createPage(spaceId, { isLocked: true, title: 'stale' });
    const keptFile = await createPage(spaceId, { parentPageId: keptFolder, isLocked: true });

    await mapFile(source.id, 'kept/', 'folder', keptFolder);
    await mapFile(source.id, 'stale/', 'folder', staleFolder);
    await mapFile(source.id, 'kept/a.md', 'markdown', keptFile);

    await (service as any).pruneStaleFolders(
      { ...source, workspaceId, spaceId, rootDir: '', rootPageId: null },
      actor(),
    );

    expect((await pageRow(staleFolder)).deletedAt).not.toBeNull();
    expect(await mappingStatus(source.id, 'stale/')).toBe('deleted');

    expect((await pageRow(keptFolder)).deletedAt).toBeNull();
    expect(await mappingStatus(source.id, 'kept/')).toBe('synced');
  });

  /**
   * The data-loss case: `removePage` soft-deletes the whole subtree via a
   * recursive CTE, so clearing a husk that a human has put their own page under
   * would take that page with it.
   */
  it('releases rather than deletes a stale folder holding a page it does not own', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);

    const staleFolder = await createPage(spaceId, { isLocked: true, title: 'stale' });
    // a page the user created under the synced folder — unmapped, unlocked
    const userPage = await createPage(spaceId, {
      parentPageId: staleFolder,
      title: 'my notes',
    });
    await mapFile(source.id, 'stale/', 'folder', staleFolder);

    await (service as any).pruneStaleFolders(
      { ...source, workspaceId, spaceId, rootDir: '', rootPageId: null },
      actor(),
    );

    const userRow = await pageRow(userPage);
    expect(userRow.deletedAt).toBeNull();
    expect(userRow.parentPageId).toBe(staleFolder);

    const folderRow = await pageRow(staleFolder);
    expect(folderRow.deletedAt).toBeNull();
    // handed over: no longer mirrored, so no longer read-only
    expect(folderRow.isLocked).toBe(false);
    expect(await mappingStatus(source.id, 'stale/')).toBe('deleted');
  });

  // --------------------------------------------------- softDeleteMissing

  it("reconciles a file that failed once and was then deleted upstream", async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);

    const folder = await createPage(spaceId, { isLocked: true, title: 'docs' });
    const errored = await createPage(spaceId, { parentPageId: folder, isLocked: true });

    await mapFile(source.id, 'docs/', 'folder', folder);
    // last sync failed on this file, and it is now gone from the repo
    await mapFile(source.id, 'docs/a.md', 'markdown', errored, 'error');

    await (service as any).softDeleteMissing(
      { ...source, workspaceId, spaceId, rootDir: '', rootPageId: null },
      new Set<string>(), // nothing seen this run: the tree no longer lists it
      actor(),
    );

    expect(await mappingStatus(source.id, 'docs/a.md')).toBe('deleted');
    expect((await pageRow(errored)).deletedAt).not.toBeNull();
    // and with its last file gone the directory goes too
    expect(await mappingStatus(source.id, 'docs/')).toBe('deleted');
    expect((await pageRow(folder)).deletedAt).not.toBeNull();
  });

  it('keeps a file that failed on this very run', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const source = await createSource(spaceId, installation);

    const folder = await createPage(spaceId, { isLocked: true });
    const errored = await createPage(spaceId, { parentPageId: folder, isLocked: true });
    await mapFile(source.id, 'docs/', 'folder', folder);
    await mapFile(source.id, 'docs/a.md', 'markdown', errored, 'error');

    await (service as any).softDeleteMissing(
      { ...source, workspaceId, spaceId, rootDir: '', rootPageId: null },
      new Set(['docs/a.md']), // the tree listed it; the import is what failed
      actor(),
    );

    expect(await mappingStatus(source.id, 'docs/a.md')).toBe('error');
    expect((await pageRow(errored)).deletedAt).toBeNull();
    expect((await pageRow(folder)).deletedAt).toBeNull();
  });

  // ------------------------------------------------- mount page safety

  it('never trashes the mount page when its root README disappears', async () => {
    const spaceId = await createSpace();
    const installation = await createInstallation();
    const mount = await createPage(spaceId, { isLocked: true, title: 'Mount' });
    const source = await createSource(spaceId, installation, { rootPageId: mount });

    await mapFile(source.id, 'README.md', 'markdown', mount);

    await (service as any).softDeleteMissing(
      { ...source, workspaceId, spaceId, rootDir: '', rootPageId: mount },
      new Set<string>(),
      actor(),
    );

    expect((await pageRow(mount)).deletedAt).toBeNull();
    expect(pageService.updatePageContent).toHaveBeenCalledWith(
      mount,
      '<p></p>',
      'replace',
      'html',
      expect.anything(),
    );
  });
});

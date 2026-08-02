import { GithubSyncService } from './github-sync.service';
import { htmlToJson, jsonToText } from '../../collaboration/collaboration.util';

/**
 * Minimal stand-in for the Kysely query builder: every chained method
 * returns the same object, so any where()/select() depth typechecks without
 * hand-modelling the real fluent API. Only the terminal methods
 * (execute/executeTakeFirst) carry test-controlled behaviour.
 */
function createFluentDb(): any {
  const chain: any = {};
  const passthroughMethods = [
    'selectFrom',
    'select',
    'where',
    'orderBy',
    'innerJoin',
    'updateTable',
    'set',
    'insertInto',
    'values',
    'onConflict',
    'returning',
    'returningAll',
    'deleteFrom',
  ];
  for (const method of passthroughMethods) {
    chain[method] = jest.fn(() => chain);
  }
  chain.executeTakeFirst = jest.fn();
  chain.execute = jest.fn().mockResolvedValue(undefined);
  chain.executeTakeFirstOrThrow = jest.fn();
  // executeTx() calls db.transaction().execute(cb) with no real transaction
  // semantics needed here — just run the callback against the same chain
  chain.transaction = jest.fn(() => ({ execute: (cb: any) => cb(chain) }));
  return chain;
}

function createService(db: any) {
  const pageRepo = {
    findById: jest.fn(),
    removePage: jest.fn(),
    updatePage: jest.fn().mockResolvedValue(undefined),
    deletePage: jest.fn().mockResolvedValue(undefined),
  };
  const pageService = {
    create: jest.fn(),
    updatePageContent: jest.fn().mockResolvedValue(undefined),
  };
  const githubApi = {
    getBlob: jest.fn(),
    getContentByPath: jest.fn(),
  };
  const assetService = {
    rewriteAssets: jest.fn(),
  };
  const storageService = {};

  const service = new GithubSyncService(
    db,
    githubApi as any,
    assetService as any,
    pageService as any,
    pageRepo as any,
    storageService as any,
  );

  return { service, pageRepo, pageService, githubApi, assetService };
}

const actor = { id: 'actor-1' } as any;
const source: any = {
  id: 'source-1',
  workspaceId: 'ws-1',
  spaceId: 'space-1',
  githubInstallationId: 'inst-1',
  owner: 'acme',
  repo: 'docs',
  ref: 'main',
  rootDir: '',
  rootPageId: null,
};

describe('GithubSyncService.deleteMapping — index/README deletion rule (A4)', () => {
  it('resets the folder page instead of deleting it when a README shares it', async () => {
    const db = createFluentDb();
    // the folder-sibling lookup finds a 'folder' mapping on the same pageId
    db.executeTakeFirst.mockResolvedValueOnce({ title: 'Guide' });
    const { service, pageRepo, pageService } = createService(db);

    const result = await (service as any).deleteMapping(
      source,
      'page-1',
      'mapping-1',
      actor,
    );

    expect(result).toEqual({ ok: true });
    expect(pageRepo.removePage).not.toHaveBeenCalled();
    expect(pageService.updatePageContent).toHaveBeenCalledWith(
      'page-1',
      '<p></p>',
      'replace',
      'html',
      actor,
    );
    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Guide' }),
      'page-1',
    );
    // only the mapping's own status flips to 'deleted' — nothing else does
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('removes the page normally when nothing else shares it', async () => {
    const db = createFluentDb();
    db.executeTakeFirst.mockResolvedValueOnce(undefined); // no folder sibling
    const { service, pageRepo, pageService } = createService(db);
    pageRepo.removePage.mockResolvedValue(undefined);

    const result = await (service as any).deleteMapping(
      source,
      'page-2',
      'mapping-2',
      actor,
    );

    expect(result).toEqual({ ok: true });
    expect(pageRepo.removePage).toHaveBeenCalledWith(
      'page-2',
      actor.id,
      source.workspaceId,
    );
    expect(pageService.updatePageContent).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  /**
   * B5: a deletion that didn't actually happen must not be recorded as
   * done — otherwise nothing ever retries it.
   */
  it('leaves the mapping synced and reports failure when removePage throws', async () => {
    const db = createFluentDb();
    db.executeTakeFirst.mockResolvedValueOnce(undefined);
    const { service, pageRepo } = createService(db);
    pageRepo.removePage.mockRejectedValue(new Error('db unavailable'));

    const result = await (service as any).deleteMapping(
      source,
      'page-3',
      'mapping-3',
      actor,
    );

    expect(result).toEqual({ ok: false, error: 'db unavailable' });
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe('GithubSyncService.syncMarkdownFile — SHA shortcut liveness check (A4)', () => {
  const baseArgs = {
    source,
    token: 'tok',
    repoPath: 'guide.md',
    sha: 'sha-abc',
    blobShas: new Map<string, string>(),
    actor,
    folderCache: new Map<string, string>(),
    force: false,
  };

  it('skips re-processing when the mapped page is still alive', async () => {
    const db = createFluentDb();
    db.executeTakeFirst.mockResolvedValueOnce({
      id: 'mapping-1',
      sha: 'sha-abc',
      pageId: 'page-1',
      status: 'synced',
    });
    const { service, pageRepo, pageService, githubApi } = createService(db);
    pageRepo.findById.mockResolvedValue({ id: 'page-1', deletedAt: null });

    const result = await (service as any).syncMarkdownFile(baseArgs);

    expect(result).toEqual({ skipped: true });
    expect(githubApi.getBlob).not.toHaveBeenCalled();
    expect(pageService.create).not.toHaveBeenCalled();
  });

  /**
   * Regression: an unchanged sha used to be enough to skip a file outright.
   * A page soft-deleted underneath that mapping (eg. by the A4 bug, or any
   * other unrelated deletion) stayed deleted forever, because nothing ever
   * revisits an already-'synced' mapping row.
   */
  it('falls through and recreates the page when it was soft-deleted', async () => {
    const db = createFluentDb();
    db.executeTakeFirst.mockResolvedValueOnce({
      id: 'mapping-1',
      sha: 'sha-abc',
      pageId: 'page-1',
      status: 'synced',
    });
    const { service, pageRepo, pageService, githubApi, assetService } =
      createService(db);
    githubApi.getBlob.mockResolvedValue(Buffer.from('# Title\n\nBody'));
    assetService.rewriteAssets.mockResolvedValue({
      html: '<h1>Title</h1><p>Body</p>',
      attachmentIds: [],
    });
    pageService.create.mockResolvedValue({ id: 'new-page-id' });

    // The liveness probe sees a soft-deleted page; the A2 read-back probe
    // (includeContent) must see whatever was just written, otherwise the
    // sync correctly refuses to call the write durable.
    let written: string | undefined;
    pageService.updatePageContent.mockImplementation(
      async (_id: string, html: string) => {
        written = html;
      },
    );
    pageRepo.findById.mockImplementation(async (_id: string, opts?: any) =>
      opts?.includeTextContent
        ? {
            id: 'new-page-id',
            deletedAt: null,
            textContent: jsonToText(htmlToJson(written)),
          }
        : { id: 'page-1', deletedAt: new Date() },
    );

    const result = await (service as any).syncMarkdownFile(baseArgs);

    expect(result).toEqual({ pageId: 'new-page-id' });
    expect(pageService.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * A2: Hocuspocus swallows onStoreDocument failures, so updatePageContent()
 * resolves even when nothing reached the database. Without this read-back the
 * sync would record the blob sha and never revisit the file.
 */
describe('GithubSyncService.assertContentPersisted (A2)', () => {
  it('accepts content that matches what was written', async () => {
    const { service, pageRepo } = createService(createFluentDb());
    pageRepo.findById.mockResolvedValue({
      id: 'page-1',
      textContent: jsonToText(htmlToJson('<p>Body</p>')),
    });

    await expect(
      (service as any).assertContentPersisted('page-1', '<p>Body</p>'),
    ).resolves.toBeUndefined();
  });

  it('throws when the database still holds the old content', async () => {
    const { service, pageRepo } = createService(createFluentDb());
    pageRepo.findById.mockResolvedValue({
      id: 'page-1',
      textContent: jsonToText(htmlToJson('<p>Stale</p>')),
    });

    await expect(
      (service as any).assertContentPersisted('page-1', '<p>Body</p>'),
    ).rejects.toThrow('page_content_not_persisted');
  });

  it('throws when the page vanished entirely', async () => {
    const { service, pageRepo } = createService(createFluentDb());
    pageRepo.findById.mockResolvedValue(undefined);

    await expect(
      (service as any).assertContentPersisted('page-1', '<p>Body</p>'),
    ).rejects.toThrow('page_content_not_persisted');
  });
});

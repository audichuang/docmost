import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as path from 'path';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { markdownToHtml } from '@docmost/editor-ext';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { User } from '@docmost/db/types/entity.types';
import { PageService } from '../../core/page/services/page.service';
import { StorageService } from '../storage/storage.service';
import { GithubApiService, GithubCompareFile } from './github-api.service';
import { GithubAssetService } from './github-asset.service';
import { CreateSourceDto } from './github.dto';
import {
  extractTitle,
  INDEX_RE,
  MARKDOWN_RE,
  normalizeDir,
  titleFromSegment,
} from './github.utils';

type SourceRow = {
  id: string;
  workspaceId: string;
  spaceId: string;
  githubInstallationId: string;
  owner: string;
  repo: string;
  ref: string;
  rootDir: string;
  rootPageId: string | null;
  active: boolean;
  lastFullScanSha: string | null;
};

@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly githubApi: GithubApiService,
    private readonly assetService: GithubAssetService,
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly storageService: StorageService,
  ) {}

  // ---------------------------------------------------------------- sources

  async listSources(workspaceId: string) {
    return this.db
      .selectFrom('githubSources as s')
      .innerJoin('githubInstallations as i', 'i.id', 's.githubInstallationId')
      .innerJoin('spaces as sp', 'sp.id', 's.spaceId')
      .select([
        's.id',
        's.owner',
        's.repo',
        's.ref',
        's.rootDir',
        's.spaceId',
        's.active',
        's.lastFullScanSha',
        's.lastSyncedAt',
        's.lastSyncError',
        's.createdAt',
        'i.accountLogin',
        'sp.name as spaceName',
      ])
      .where('s.workspaceId', '=', workspaceId)
      .orderBy('s.createdAt', 'desc')
      .execute();
  }

  async createSource(workspaceId: string, userId: string, dto: CreateSourceDto) {
    const installation = await this.db
      .selectFrom('githubInstallations')
      .select(['id'])
      .where('id', '=', dto.githubInstallationId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (!installation) throw new NotFoundException('github_installation_not_found');

    return this.db
      .insertInto('githubSources')
      .values({
        workspaceId,
        spaceId: dto.spaceId,
        githubInstallationId: dto.githubInstallationId,
        owner: dto.owner,
        repo: dto.repo,
        ref: dto.ref,
        rootDir: normalizeDir(dto.rootDir),
        rootPageId: dto.rootPageId ?? null,
        creatorId: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateSourceActive(workspaceId: string, sourceId: string, active: boolean) {
    const res = await this.db
      .updateTable('githubSources')
      .set({ active, updatedAt: new Date() })
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    return Number(res.numUpdatedRows) > 0;
  }

  /** Removes the mapping only — synced pages stay where they are. */
  async deleteSource(workspaceId: string, sourceId: string) {
    await this.db
      .deleteFrom('githubSources')
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async linkInstallation(
    workspaceId: string,
    dto: { installationId: string; accountLogin: string; accountType: string; appId: string },
  ) {
    return this.db
      .insertInto('githubInstallations')
      .values({
        workspaceId,
        appId: dto.appId,
        installationId: dto.installationId,
        accountLogin: dto.accountLogin,
        accountType: dto.accountType,
      })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'installationId']).doUpdateSet({
          accountLogin: dto.accountLogin,
          accountType: dto.accountType,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // ------------------------------------------------------------- full sync

  async fullSync(
    sourceId: string,
    opts: {
      force?: boolean;
      onProgress?: (p: {
        current: number;
        total: number;
        path: string;
      }) => Promise<void> | void;
    } = {},
  ) {
    const source = await this.loadSource(sourceId);
    if (!source) throw new NotFoundException('github_source_not_found');

    this.logger.log(
      `Full sync start: ${source.owner}/${source.repo}@${source.ref} -> space ${source.spaceId}`,
    );

    try {
      const token = await this.githubApi.getInstallationToken(
        source.githubInstallationId,
      );
      const { entries, truncated } = await this.githubApi.getTree(
        source.owner,
        source.repo,
        source.ref,
        token,
      );

      if (truncated) {
        // never let a partial listing look like a complete sync
        this.logger.warn(
          `GitHub truncated the tree for ${source.owner}/${source.repo} — some files were not seen this run`,
        );
      }

      const blobShas = new Map(
        entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]),
      );

      const prefix = source.rootDir ? `${source.rootDir}/` : '';
      const markdownEntries = entries.filter(
        (e) =>
          e.type === 'blob' &&
          MARKDOWN_RE.test(e.path) &&
          (!prefix || e.path.startsWith(prefix)),
      );

      const actor = await this.getActor(source.workspaceId);
      const folderCache = new Map<string, string>();
      const seenPaths = new Set<string>();

      const total = markdownEntries.length;
      // a busy repo does not need a progress write per file
      const step = total > 50 ? 5 : 1;

      for (const [index, entry] of markdownEntries.entries()) {
        try {
          await this.syncMarkdownFile({
            source,
            token,
            repoPath: entry.path,
            sha: entry.sha,
            blobShas,
            actor,
            folderCache,
            force: opts.force ?? false,
          });
        } catch (err) {
          await this.markFileError(source.id, entry.path, err);
          this.logger.warn(
            `Failed to sync ${entry.path}: ${err instanceof Error ? err.message : err}`,
          );
        }
        seenPaths.add(entry.path);

        if (opts.onProgress && ((index + 1) % step === 0 || index + 1 === total)) {
          await opts.onProgress({ current: index + 1, total, path: entry.path });
        }
      }

      // only trust deletions when the tree listing was complete
      if (!truncated) {
        await this.softDeleteMissing(source, seenPaths, actor);
      }

      const headSha = await this.githubApi.getCommitSha(
        source.owner,
        source.repo,
        source.ref,
        token,
      );

      await this.db
        .updateTable('githubSources')
        .set({
          lastFullScanSha: headSha,
          lastSyncedAt: new Date(),
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where('id', '=', source.id)
        .execute();

      this.logger.log(
        `Full sync done: ${source.owner}/${source.repo} (${markdownEntries.length} files)`,
      );

      return { files: markdownEntries.length, truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .updateTable('githubSources')
        .set({ lastSyncError: message, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', source.id)
        .execute();
      throw err;
    }
  }

  private async syncMarkdownFile(args: {
    source: SourceRow;
    token: string;
    repoPath: string;
    sha: string | null;
    blobShas: Map<string, string>;
    actor: User;
    folderCache: Map<string, string>;
    force: boolean;
    markdown?: string;
  }) {
    const { source, token, repoPath, sha, blobShas, actor, folderCache } = args;

    const existing = await this.db
      .selectFrom('githubFiles')
      .select(['id', 'sha', 'pageId', 'status'])
      .where('sourceId', '=', source.id)
      .where('path', '=', repoPath)
      .executeTakeFirst();

    if (
      !args.force &&
      sha &&
      existing?.sha === sha &&
      existing.status === 'synced' &&
      existing.pageId
    ) {
      return { skipped: true };
    }

    let markdown = args.markdown;
    let blobSha = sha;
    if (markdown === undefined) {
      if (blobSha) {
        markdown = (
          await this.githubApi.getBlob(source.owner, source.repo, blobSha, token)
        ).toString('utf8');
      } else {
        const res = await this.githubApi.getContentByPath(
          source.owner,
          source.repo,
          repoPath,
          source.ref,
          token,
        );
        if (res.status !== 200 || !res.buffer) return { skipped: true };
        markdown = res.buffer.toString('utf8');
        blobSha = res.sha ?? null;
      }
    }

    const rawHtml = (await markdownToHtml(markdown)) as string;
    const { html: assetHtml } = await this.assetService.rewriteAssets({
      html: rawHtml,
      filePath: repoPath,
      blobShas,
      source: {
        id: source.id,
        owner: source.owner,
        repo: source.repo,
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
      },
      token,
      actorId: actor.id,
    });

    const { title, html } = extractTitle(assetHtml, repoPath);

    const relPath = source.rootDir
      ? repoPath.slice(source.rootDir.length + 1)
      : repoPath;
    const relDir = path.posix.dirname(relPath);
    const folderPageId = await this.ensureFolderChain(
      source,
      relDir === '.' ? '' : relDir,
      actor,
      folderCache,
    );

    // a directory's README becomes that directory's own page rather than a child
    const isIndex = INDEX_RE.test(path.posix.basename(relPath));
    let pageId = existing?.pageId ?? null;

    if (isIndex && folderPageId) {
      pageId = folderPageId;
    }

    if (pageId) {
      const page = await this.pageRepo.findById(pageId);
      if (!page || page.deletedAt) pageId = null;
    }

    if (!pageId) {
      const created = await this.pageService.create(actor.id, source.workspaceId, {
        title,
        spaceId: source.spaceId,
        parentPageId: folderPageId ?? source.rootPageId ?? undefined,
      });
      pageId = created.id;
    }

    // routed through the collab gateway so open editors update live
    await this.pageService.updatePageContent(pageId, html, 'replace', 'html', actor);

    await this.pageRepo.updatePage(
      { title, isLocked: true, lastUpdatedById: actor.id, updatedAt: new Date() },
      pageId,
    );

    await this.upsertFileMapping({
      sourceId: source.id,
      path: repoPath,
      contentType: 'markdown',
      pageId,
      sha: blobSha,
      title,
    });

    return { pageId };
  }

  /**
   * Materialises one page per repo directory so the page tree mirrors the repo.
   * Returns the deepest folder page id, or null at the repo root.
   */
  private async ensureFolderChain(
    source: SourceRow,
    relDir: string,
    actor: User,
    cache: Map<string, string>,
  ): Promise<string | null> {
    if (!relDir) return source.rootPageId ?? null;

    const segments = relDir.split('/').filter(Boolean);
    let parentId = source.rootPageId ?? null;
    let walked = '';

    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment;
      const mappingPath = `${source.rootDir ? `${source.rootDir}/` : ''}${walked}/`;

      const cached = cache.get(mappingPath);
      if (cached) {
        parentId = cached;
        continue;
      }

      const existing = await this.db
        .selectFrom('githubFiles')
        .select(['pageId'])
        .where('sourceId', '=', source.id)
        .where('path', '=', mappingPath)
        .where('contentType', '=', 'folder')
        .executeTakeFirst();

      let pageId = existing?.pageId ?? null;
      if (pageId) {
        const page = await this.pageRepo.findById(pageId);
        if (!page || page.deletedAt) pageId = null;
      }

      if (!pageId) {
        const created = await this.pageService.create(actor.id, source.workspaceId, {
          title: titleFromSegment(segment),
          spaceId: source.spaceId,
          parentPageId: parentId ?? undefined,
        });
        pageId = created.id;
      }

      await this.upsertFileMapping({
        sourceId: source.id,
        path: mappingPath,
        contentType: 'folder',
        pageId,
        sha: null,
        title: titleFromSegment(segment),
      });

      cache.set(mappingPath, pageId);
      parentId = pageId;
    }

    return parentId;
  }

  private async softDeleteMissing(
    source: SourceRow,
    seenPaths: Set<string>,
    actor: User,
  ) {
    const mapped = await this.db
      .selectFrom('githubFiles')
      .select(['id', 'path', 'pageId'])
      .where('sourceId', '=', source.id)
      .where('contentType', '=', 'markdown')
      .where('status', '=', 'synced')
      .execute();

    for (const row of mapped) {
      if (seenPaths.has(row.path)) continue;
      await this.deleteMapping(source, row.pageId, row.id, actor);
    }
  }

  private async deleteMapping(
    source: SourceRow,
    pageId: string | null,
    mappingId: string,
    actor: User,
  ) {
    if (pageId) {
      try {
        await this.pageRepo.removePage(pageId, actor.id, source.workspaceId);
      } catch (err) {
        this.logger.warn(
          `Failed to remove page ${pageId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.db
      .updateTable('githubFiles')
      .set({ status: 'deleted', updatedAt: new Date() })
      .where('id', '=', mappingId)
      .execute();
  }

  // --------------------------------------------------------------- webhook

  /**
   * Returns false when the delivery was already recorded, so the caller can
   * skip the work entirely.
   */
  async recordDelivery(args: {
    deliveryId: string;
    event: string;
    payload: any;
  }): Promise<boolean> {
    const inserted = await this.db
      .insertInto('githubWebhookEvents')
      .values({
        deliveryId: args.deliveryId,
        event: args.event,
        repoFullName: args.payload?.repository?.full_name ?? null,
        beforeSha: args.payload?.before ?? null,
        afterSha: args.payload?.after ?? null,
        payload: args.payload,
      })
      .onConflict((oc) => oc.column('deliveryId').doNothing())
      .returning('id')
      .executeTakeFirst();

    return Boolean(inserted);
  }

  async handlePush(deliveryId: string, payload: any) {
    const repoFullName: string = payload?.repository?.full_name;
    const before: string = payload?.before;
    const after: string = payload?.after;
    const branch = String(payload?.ref ?? '').replace(/^refs\/heads\//, '');

    if (!repoFullName || !after || !branch) {
      return this.finishDelivery(deliveryId, true, 'ignored: incomplete payload');
    }

    const [owner, repo] = repoFullName.split('/');

    try {
      const sources = (await this.db
        .selectFrom('githubSources')
        .selectAll()
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('ref', '=', branch)
        .where('active', '=', true)
        .execute()) as unknown as SourceRow[];

      if (sources.length === 0) {
        return this.finishDelivery(deliveryId, true, 'no matching source');
      }

      for (const source of sources) {
        await this.applyPushToSource(source, before, after);
      }

      await this.finishDelivery(deliveryId, true);
    } catch (err) {
      await this.finishDelivery(
        deliveryId,
        false,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  private async applyPushToSource(source: SourceRow, before: string, after: string) {
    const token = await this.githubApi.getInstallationToken(
      source.githubInstallationId,
    );

    // a force push or a first-ever sync has no usable base to compare against
    const isComparable = before && !/^0+$/.test(before);
    if (!isComparable) {
      await this.fullSync(source.id, { force: false });
      return;
    }

    let files: GithubCompareFile[];
    try {
      files = await this.githubApi.compare(
        source.owner,
        source.repo,
        before,
        after,
        token,
      );
    } catch {
      // compare fails when history was rewritten — fall back to a full scan
      await this.fullSync(source.id, { force: false });
      return;
    }

    const prefix = source.rootDir ? `${source.rootDir}/` : '';
    const actor = await this.getActor(source.workspaceId);
    const folderCache = new Map<string, string>();

    // assets first, so a page re-synced in the same push picks up fresh bytes
    for (const file of files) {
      if (MARKDOWN_RE.test(file.filename)) continue;
      if (prefix && !file.filename.startsWith(prefix)) continue;
      await this.refreshAsset(source, file, token);
    }

    for (const file of files) {
      if (!MARKDOWN_RE.test(file.filename)) continue;
      if (prefix && !file.filename.startsWith(prefix)) continue;

      try {
        if (file.status === 'removed') {
          const mapping = await this.db
            .selectFrom('githubFiles')
            .select(['id', 'pageId'])
            .where('sourceId', '=', source.id)
            .where('path', '=', file.filename)
            .executeTakeFirst();
          if (mapping) {
            await this.deleteMapping(source, mapping.pageId, mapping.id, actor);
          }
          continue;
        }

        if (file.status === 'renamed' && file.previous_filename) {
          await this.db
            .updateTable('githubFiles')
            .set({ path: file.filename, renamedFromPath: file.previous_filename })
            .where('sourceId', '=', source.id)
            .where('path', '=', file.previous_filename)
            .execute();
        }

        // push payloads carry no blob sha for the new content, so fetch by path
        await this.syncMarkdownFile({
          source,
          token,
          repoPath: file.filename,
          sha: null,
          blobShas: new Map(),
          actor,
          folderCache,
          force: true,
        });
      } catch (err) {
        await this.markFileError(source.id, file.filename, err);
        this.logger.warn(
          `Push sync failed for ${file.filename}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.db
      .updateTable('githubSources')
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', source.id)
      .execute();
  }

  /**
   * Rewrites the bytes behind an existing attachment in place, so pages that
   * already reference it show the new version without being re-synced.
   */
  private async refreshAsset(
    source: SourceRow,
    file: GithubCompareFile,
    token: string,
  ) {
    const mapping = await this.db
      .selectFrom('githubFiles')
      .select(['id', 'attachmentId'])
      .where('sourceId', '=', source.id)
      .where('path', '=', file.filename)
      .where('contentType', '=', 'asset')
      .executeTakeFirst();

    if (!mapping?.attachmentId) return;

    if (file.status === 'removed') {
      await this.db
        .updateTable('githubFiles')
        .set({ status: 'deleted', updatedAt: new Date() })
        .where('id', '=', mapping.id)
        .execute();
      return;
    }

    const attachment = await this.db
      .selectFrom('attachments')
      .select(['filePath'])
      .where('id', '=', mapping.attachmentId)
      .executeTakeFirst();
    if (!attachment) return;

    const res = await this.githubApi.getContentByPath(
      source.owner,
      source.repo,
      file.filename,
      source.ref,
      token,
    );
    if (res.status !== 200 || !res.buffer) return;

    await this.storageService.upload(attachment.filePath, res.buffer);
    await this.db
      .updateTable('githubFiles')
      .set({ sha: res.sha ?? null, status: 'synced', updatedAt: new Date() })
      .where('id', '=', mapping.id)
      .execute();
  }

  private async finishDelivery(deliveryId: string, ok: boolean, error?: string) {
    await this.db
      .updateTable('githubWebhookEvents')
      .set({ processed: true, processedAt: new Date(), ok, error: error ?? null })
      .where('deliveryId', '=', deliveryId)
      .execute();
  }

  // --------------------------------------------------------------- helpers

  private async loadSource(sourceId: string): Promise<SourceRow | null> {
    const row = await this.db
      .selectFrom('githubSources')
      .selectAll()
      .where('id', '=', sourceId)
      .executeTakeFirst();
    return (row as unknown as SourceRow) ?? null;
  }

  private async upsertFileMapping(values: {
    sourceId: string;
    path: string;
    contentType: string;
    pageId: string | null;
    sha: string | null;
    title: string | null;
  }) {
    await this.db
      .insertInto('githubFiles')
      .values({ ...values, status: 'synced' })
      .onConflict((oc) =>
        oc.columns(['sourceId', 'path']).doUpdateSet({
          pageId: values.pageId,
          sha: values.sha,
          title: values.title,
          contentType: values.contentType,
          status: 'synced',
          error: null,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }

  private async markFileError(sourceId: string, repoPath: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await this.db
      .insertInto('githubFiles')
      .values({
        sourceId,
        path: repoPath,
        contentType: 'markdown',
        status: 'error',
        error: message,
      })
      .onConflict((oc) =>
        oc
          .columns(['sourceId', 'path'])
          .doUpdateSet({ status: 'error', error: message, updatedAt: new Date() }),
      )
      .execute();
  }

  /** Pages created by the sync are attributed to the workspace owner. */
  private async getActor(workspaceId: string): Promise<User> {
    const owner = await this.db
      .selectFrom('users')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .executeTakeFirst();

    if (!owner) throw new NotFoundException('workspace_has_no_users');
    return owner as User;
  }
}

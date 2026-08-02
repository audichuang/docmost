import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as path from 'path';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx, executeTx } from '@docmost/db/utils';
import { markdownToHtml } from '@docmost/editor-ext';
import { htmlToJson, jsonToText } from '../../collaboration/collaboration.util';
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
  isCompareSaturated,
  isPageAlive,
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
    // An installation now belongs to exactly one workspace (unique on
    // installation_id alone). Re-linking it somewhere else is refused rather
    // than reassigned: the row id is referenced by github_sources, so silently
    // moving the workspace would leave another workspace's sources hanging off
    // an installation it no longer owns. Disconnect it there first.
    const existing = await this.db
      .selectFrom('githubInstallations')
      .select(['id', 'workspaceId'])
      .where('installationId', '=', dto.installationId)
      .executeTakeFirst();

    if (existing && existing.workspaceId !== workspaceId) {
      throw new ConflictException('github_installation_linked_elsewhere');
    }

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
        oc.column('installationId').doUpdateSet({
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

    // re-fetched before every request rather than held for the whole run —
    // an installation token is only valid an hour, and a large sync can
    // easily outlive that (B7). getInstallationToken() itself caches, so
    // this is a Map lookup, not a network call, on every iteration but the
    // one near expiry.
    const getToken = () => this.githubApi.getInstallationToken(source.githubInstallationId);

    try {
      const { entries, truncated } = await this.githubApi.getTree(
        source.owner,
        source.repo,
        source.ref,
        await getToken(),
      );

      if (truncated) {
        // GitHub caps the recursive tree and offers no way to page through
        // the rest of it. Proceeding would silently drop files while still
        // reporting a clean sync (A5) — fail loudly instead so the error is
        // visible and BullMQ retries.
        throw new Error(
          `github_tree_truncated: ${source.owner}/${source.repo}@${source.ref} has too ` +
            'many entries for a single recursive listing',
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
      const failures: { path: string; error: string }[] = [];

      const total = markdownEntries.length;
      // a busy repo does not need a progress write per file
      const step = total > 50 ? 5 : 1;

      for (const [index, entry] of markdownEntries.entries()) {
        try {
          await this.syncMarkdownFile({
            source,
            token: await getToken(),
            repoPath: entry.path,
            sha: entry.sha,
            blobShas,
            actor,
            folderCache,
            force: opts.force ?? false,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.markFileError(source.id, entry.path, err);
          failures.push({ path: entry.path, error: message });
          this.logger.warn(`Failed to sync ${entry.path}: ${message}`);
        }
        seenPaths.add(entry.path);

        if (opts.onProgress && ((index + 1) % step === 0 || index + 1 === total)) {
          await opts.onProgress({ current: index + 1, total, path: entry.path });
        }
      }

      // the tree listing is already known-complete (truncation throws above)
      failures.push(...(await this.softDeleteMissing(source, seenPaths, actor)));

      if (failures.length > 0) {
        // B5: a sync with per-file failures must fail the job so BullMQ
        // retries — github_files.error already has the per-path detail,
        // this is just the source-level summary
        throw new Error(this.summarizeFailures('github_sync_partial_failure', failures));
      }

      const headSha = await this.githubApi.getCommitSha(
        source.owner,
        source.repo,
        source.ref,
        await getToken(),
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

  private summarizeFailures(
    prefix: string,
    failures: { path: string; error: string }[],
  ): string {
    const shown = failures.slice(0, 5).map((f) => f.path).join(', ');
    const more = failures.length > 5 ? `, +${failures.length - 5} more` : '';
    return `${prefix}: ${failures.length} file(s) failed (${shown}${more})`;
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
      // A4: an unchanged sha is not enough — the mapped page can have been
      // soft-deleted underneath this mapping (eg. a sibling README's folder
      // page getting trashed). Skipping without checking left it deleted
      // forever, since nothing else ever revisits an already-'synced' row.
      const mappedPage = await this.pageRepo.findById(existing.pageId);
      if (isPageAlive(mappedPage)) return { skipped: true };
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
      if (!isPageAlive(page)) pageId = null;
    }

    let createdNewPage = false;
    if (!pageId) {
      const created = await this.pageService.create(actor.id, source.workspaceId, {
        title,
        spaceId: source.spaceId,
        parentPageId: folderPageId ?? source.rootPageId ?? undefined,
      });
      pageId = created.id;
      createdNewPage = true;
    }

    try {
      // routed through the collab gateway so open editors update live
      await this.pageService.updatePageContent(pageId, html, 'replace', 'html', actor);
      await this.assertContentPersisted(pageId, html);

      // the lock flag and the mapping row must agree with each other — a
      // mapping that outlives its page, or a locked page nothing maps to,
      // is exactly the orphan B6 is about, so these two writes are atomic
      await executeTx(this.db, async (trx) => {
        await this.pageRepo.updatePage(
          {
            title,
            isLocked: true,
            lastUpdatedById: actor.id,
            updatedAt: new Date(),
            // B4: reconciled on every sync, not only a detected rename — a
            // page whose folder moved must move with it. Skipped for an
            // index page, whose parent is governed by ensureFolderChain
            // (its pageId *is* the folder page, not a child of it).
            ...(isIndex ? {} : { parentPageId: folderPageId ?? source.rootPageId ?? null }),
          },
          pageId,
          trx,
        );

        await this.upsertFileMapping(
          {
            sourceId: source.id,
            path: repoPath,
            contentType: 'markdown',
            pageId,
            sha: blobSha,
            title,
          },
          trx,
        );
      });
    } catch (err) {
      if (createdNewPage) {
        // B6: nothing durable points at this page yet (no mapping row was
        // ever written) — a half-finished sync must not leave a blank,
        // locked orphan behind. Residual risk: a hard process kill between
        // pageService.create() succeeding and this catch running can't be
        // caught at all; closing that fully would need create() to accept a
        // caller-supplied id (it doesn't) or a separate reconciliation
        // pass — both out of scope here.
        await this.pageRepo.deletePage(pageId).catch(() => {});
      }
      throw err;
    }

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

      const title = titleFromSegment(segment);

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
        if (!isPageAlive(page)) {
          pageId = null;
        } else if (page.parentPageId !== (parentId ?? null)) {
          // B4: reconciled on every sync — a directory that moved must
          // carry its page along, not just a file detected as renamed
          await this.pageRepo.updatePage(
            { parentPageId: parentId ?? null, updatedAt: new Date() },
            pageId,
          );
        }
      }

      if (!pageId) {
        // B6: atomic — a folder page with no mapping row is structurally
        // invisible to the sync and would be recreated on every later scan
        pageId = await executeTx(this.db, async (trx) => {
          const created = await this.pageService.create(
            actor.id,
            source.workspaceId,
            { title, spaceId: source.spaceId, parentPageId: parentId ?? undefined },
            trx,
          );

          await this.upsertFileMapping(
            {
              sourceId: source.id,
              path: mappingPath,
              contentType: 'folder',
              pageId: created.id,
              sha: null,
              title,
            },
            trx,
          );

          return created.id;
        });
      } else {
        await this.upsertFileMapping({
          sourceId: source.id,
          path: mappingPath,
          contentType: 'folder',
          pageId,
          sha: null,
          title,
        });
      }

      cache.set(mappingPath, pageId);
      parentId = pageId;
    }

    return parentId;
  }

  private async softDeleteMissing(
    source: SourceRow,
    seenPaths: Set<string>,
    actor: User,
  ): Promise<{ path: string; error: string }[]> {
    const mapped = await this.db
      .selectFrom('githubFiles')
      .select(['id', 'path', 'pageId'])
      .where('sourceId', '=', source.id)
      .where('contentType', '=', 'markdown')
      .where('status', '=', 'synced')
      .execute();

    const failures: { path: string; error: string }[] = [];
    for (const row of mapped) {
      if (seenPaths.has(row.path)) continue;
      const result = await this.deleteMapping(source, row.pageId, row.id, actor);
      if (!result.ok) failures.push({ path: row.path, error: result.error ?? 'delete_failed' });
    }
    return failures;
  }

  private async deleteMapping(
    source: SourceRow,
    pageId: string | null,
    mappingId: string,
    actor: User,
  ): Promise<{ ok: boolean; error?: string }> {
    if (pageId) {
      // A4: a directory's README shares its page with the directory itself
      // (see syncMarkdownFile's isIndex branch). Removing just the README
      // must not take the folder page — and every child page under it —
      // down with it, so check for that sharing before ever calling
      // removePage.
      const folderSibling = await this.db
        .selectFrom('githubFiles')
        .select(['title'])
        .where('sourceId', '=', source.id)
        .where('pageId', '=', pageId)
        .where('contentType', '=', 'folder')
        .where('status', '=', 'synced')
        .executeTakeFirst();

      if (folderSibling) {
        // the README supplied this page's content; with it gone, the page
        // reverts to being just the (still very much alive) folder page
        await this.pageService.updatePageContent(pageId, '<p></p>', 'replace', 'html', actor);
        await this.pageRepo.updatePage(
          { title: folderSibling.title, lastUpdatedById: actor.id, updatedAt: new Date() },
          pageId,
        );
      } else {
        try {
          await this.pageRepo.removePage(pageId, actor.id, source.workspaceId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to remove page ${pageId}: ${message}`);
          // B5: leave the mapping 'synced' so the next rescan retries the
          // removal instead of pretending it already happened
          return { ok: false, error: message };
        }
      }
    }

    await this.db
      .updateTable('githubFiles')
      .set({ status: 'deleted', updatedAt: new Date() })
      .where('id', '=', mappingId)
      .execute();

    return { ok: true };
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
    // re-fetched before every request — see fullSync's getToken for why a
    // single token held across the whole run isn't safe (B7)
    const getToken = () => this.githubApi.getInstallationToken(source.githubInstallationId);

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
        await getToken(),
      );
    } catch {
      // compare fails when history was rewritten — fall back to a full scan
      await this.fullSync(source.id, { force: false });
      return;
    }

    if (isCompareSaturated(files.length)) {
      // A5: GitHub's compare API caps at 300 changed files with no
      // total-count field, so we can't tell what's missing from this list —
      // reconcile against `after` directly instead of trusting a partial diff
      await this.fullSync(source.id, { force: false });
      return;
    }

    // A3: real blob shas for this push's target tree, so rewriteAssets can
    // resolve relative asset links the same way a full sync does. One tree
    // fetch here beats one API call per link across every changed file.
    let blobShas: Map<string, string>;
    try {
      const tree = await this.githubApi.getTree(source.owner, source.repo, after, await getToken());
      if (tree.truncated) {
        // a partial listing can't be trusted to resolve asset links — treat
        // it the same as compare saturation (A5)
        await this.fullSync(source.id, { force: false });
        return;
      }
      blobShas = new Map(
        tree.entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]),
      );
    } catch {
      await this.fullSync(source.id, { force: false });
      return;
    }

    const prefix = source.rootDir ? `${source.rootDir}/` : '';
    const actor = await this.getActor(source.workspaceId);
    const folderCache = new Map<string, string>();
    const failures: { path: string; error: string }[] = [];

    // assets first, so a page re-synced in the same push picks up fresh bytes
    for (const file of files) {
      if (MARKDOWN_RE.test(file.filename)) continue;
      if (prefix && !file.filename.startsWith(prefix)) continue;
      await this.refreshAsset(source, file, await getToken());
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
            const result = await this.deleteMapping(source, mapping.pageId, mapping.id, actor);
            if (!result.ok) {
              failures.push({ path: file.filename, error: result.error ?? 'delete_failed' });
            }
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
          token: await getToken(),
          repoPath: file.filename,
          sha: null,
          blobShas,
          actor,
          folderCache,
          force: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.markFileError(source.id, file.filename, err);
        failures.push({ path: file.filename, error: message });
        this.logger.warn(`Push sync failed for ${file.filename}: ${message}`);
      }
    }

    if (failures.length > 0) {
      // B5: a push with per-file failures must fail the job so BullMQ
      // retries, not report success with the failures buried in the logs
      const message = this.summarizeFailures('github_push_partial_failure', failures);
      await this.db
        .updateTable('githubSources')
        .set({ lastSyncError: message, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', source.id)
        .execute();
      throw new Error(message);
    }

    await this.db
      .updateTable('githubSources')
      .set({ lastSyncedAt: new Date(), lastSyncError: null, updatedAt: new Date() })
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

  /**
   * A2: confirm the write actually reached the database.
   *
   * Hocuspocus swallows every error thrown by `onStoreDocument` — see
   * `storeDocumentHooks()` in @hocuspocus/server, which catches, logs
   * "Document stays in memory to avoid data loss", and returns. That is
   * deliberate (a failed autosave must not crash an editing session), but it
   * means `updatePageContent()` resolves happily even when the transaction
   * that should have written `content` / `textContent` / `ydoc` failed. The
   * sync would then record the blob SHA as synced and, because of the SHA
   * shortcut, never look at that file again.
   *
   * Reading the row back is independent of that hook's error handling and
   * works across nodes, unlike an in-memory failure flag on whichever node
   * happened to own the document.
   *
   * `textContent` is the comparison key, not `content`: htmlToJson() stamps a
   * freshly generated `id` on every node, so the same HTML converted twice is
   * never deeply equal, and the stored document has additionally been through
   * a Yjs round-trip. `textContent` is what the store itself derives with
   * jsonToText(), so it is stable on both sides.
   *
   * Residual gap: a change that alters only formatting or attributes while
   * leaving the text identical would pass this check even if the store
   * failed. Catching that needs an id-insensitive structural diff.
   */
  private async assertContentPersisted(pageId: string, html: string) {
    const expected = jsonToText(htmlToJson(html));
    const page = await this.pageRepo.findById(pageId, {
      includeTextContent: true,
    });

    if (!page || (page.textContent ?? '') !== expected) {
      throw new Error(
        `page_content_not_persisted: ${pageId} — the collaboration store ` +
          'reported success but the database still holds different content',
      );
    }
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

  private async upsertFileMapping(
    values: {
      sourceId: string;
      path: string;
      contentType: string;
      pageId: string | null;
      sha: string | null;
      title: string | null;
    },
    trx?: KyselyTransaction,
  ) {
    await dbOrTx(this.db, trx)
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

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { generateSlugId } from '../../common/helpers';
import { jsonToText } from '../../collaboration/collaboration.util';
import { GithubService } from './github.service';
import { GithubMapper } from './github.mapper';
import { GithubLinkRewriter } from './github.link-rewriter';
import { createYdocFromJson } from '../../common/helpers/prosemirror/utils';
import { CreateSourceDto, LinkInstallationDto } from './github.types';
import { EnvironmentService } from '../environment/environment.service';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';

@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly gh: GithubService,
    private readonly mapper: GithubMapper,
    private readonly rewriter: GithubLinkRewriter,
    private readonly env: EnvironmentService,
    private readonly collab: CollaborationGateway,
  ) {}

  async createSourceAndStartFullSync(workspaceId: string, dto: CreateSourceDto) {
    const src = await this.db
      .insertInto('githubSources')
      .values({
        workspaceId,
        spaceId: dto.spaceId,
        githubInstallationId: dto.githubInstallationId,
        owner: dto.owner,
        repo: dto.repo,
        ref: dto.ref,
        rootDir: dto.rootDir || '',
        rootPageId: dto.rootPageId || null,
        active: dto.active ?? true,
      })
      .returningAll()
      .executeTakeFirst();

    // Trigger full sync (inline for MVP)
    if (src) await this.fullSync(workspaceId, src.id);
    return src;
  }

  async listSources(workspaceId: string) {
    return this.db
      .selectFrom('githubSources')
      .selectAll()
      .select((eb) =>
        eb
          .selectFrom('githubWebhookEvents as e')
          .select('e.ok')
          .whereRef('e.githubInstallationId', '=', 'githubSources.githubInstallationId')
          .where('e.repoFullName', '=', sql<string>`${eb.ref('githubSources.owner')} || '/' || ${eb.ref('githubSources.repo')}`)
          .orderBy('e.processedAt desc')
          .orderBy('e.createdAt desc')
          .limit(1)
          .as('lastEventOk'),
      )
      .select((eb) =>
        eb
          .selectFrom('githubWebhookEvents as e2')
          .select('e2.processedAt')
          .whereRef('e2.githubInstallationId', '=', 'githubSources.githubInstallationId')
          .where('e2.repoFullName', '=', sql<string>`${eb.ref('githubSources.owner')} || '/' || ${eb.ref('githubSources.repo')}`)
          .orderBy('e2.processedAt desc')
          .orderBy('e2.createdAt desc')
          .limit(1)
          .as('lastEventProcessedAt'),
      )
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async fullSync(workspaceId: string, sourceId: string, opts?: { force?: boolean }) {
    const source = await this.db
      .selectFrom('githubSources')
      .selectAll()
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (!source) {
      throw new NotFoundException('Source not found');
    }

    this.logger.log(`Full sync start for source ${sourceId}`);

    const token = await this.gh.getInstallationToken(source.githubInstallationId);
    const tree = await this.gh.getTree(source.owner, source.repo, source.ref, token);

    const files: Array<{ path: string }> = (tree?.tree || [])
      .filter((n: any) => n.type === 'blob')
      .map((n: any) => ({ path: n.path as string }))
      .filter((n) => /\.(md|mdx)$/i.test(n.path));

    // Cache for folder pages to avoid redundant DB lookups/creates per run
    const folderCache = new Map<string, string | null>();

    for (const f of files) {
      let relPath = f.path;
      if (source.rootDir) {
        const prefix = source.rootDir.endsWith('/') ? source.rootDir : `${source.rootDir}/`;
        if (!relPath.startsWith(prefix)) {
          continue; // outside configured root_dir; skip
        }
        relPath = relPath.slice(prefix.length);
      }

      const relDir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
      const fileName = relPath.includes('/') ? relPath.substring(relPath.lastIndexOf('/') + 1) : relPath;
      const isIndexLike = /^(readme|index)\.(md|mdx)$/i.test(fileName) && relDir.length > 0;

      const existing = await this.db
        .selectFrom('githubFiles')
        .selectAll()
        .where('sourceId', '=', source.id)
        .where('path', '=', relPath)
        .executeTakeFirst();

      const etag = opts?.force ? undefined : (existing?.etag || undefined);
      const contentRes = await this.gh.getContent(
        source.owner,
        source.repo,
        f.path,
        source.ref,
        token,
        etag,
      );

      if (contentRes.status === 304) {
        this.logger.debug(`[fullSync] ${source.id} ${relPath} -> 304 not modified`);
        // mark scanned time on existing mapping
        if (existing) {
          await this.db
            .updateTable('githubFiles')
            .set({ updatedAt: new Date() })
            .where('id', '=', existing.id)
            .execute();
        }
        continue; // unchanged
      }
      if (contentRes.status !== 200) {
        this.logger.warn(`[fullSync] skip ${f.path} status=${contentRes.status}`);
        continue;
      }

      const body = contentRes.body;
      const base64 = body?.content as string;
      const md = base64 ? Buffer.from(base64, 'base64').toString('utf-8') : '';

      // Markdown → HTML → rewrite assets → TipTap JSON
      const html = await this.mapper.markdownToHtml(md);
      const pageDir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';

      // Ensure folder chain so the page hierarchy mirrors repo directories.
      const folderPageId = await this.ensureFolderChain(workspaceId, source, relDir, folderCache);
      const rewrite = await this.rewriter.rewriteHtml(html, {
        owner: source.owner,
        repo: source.repo,
        ref: source.ref,
        token,
        pageDir,
        workspaceId,
        spaceId: source.spaceId,
        pageId: isIndexLike ? (folderPageId ?? null) : (existing?.pageId ?? null),
        creatorId: await this.getDefaultWorkspaceUserId(workspaceId),
      });

      const prosemirrorJson = await this.mapper.htmlToTipTap(rewrite.html);
      const { title: extractedTitle, prosemirrorJson: finalJson } = await this.mapper.extractTitleAndRemoveHeading(prosemirrorJson);
      const title = extractedTitle;
      const ydocBuf = createYdocFromJson(finalJson);
      const textContent = jsonToText(finalJson);

      // If file is README/index inside a folder, target the folder page itself.
      if (isIndexLike && folderPageId) {
        this.logger.debug(`[fullSync] ${source.id} ${relPath} -> update folder page ${folderPageId}`);
        await this.pageRepo.updatePage(
          {
            title: title,
            content: finalJson,
            textContent,
            ydoc: ydocBuf,
            lastUpdatedById: await this.getDefaultWorkspaceUserId(workspaceId),
            isLocked: true,
          },
          folderPageId,
        );
        // Evict in-memory collab doc
        this.collab.closeDocumentConnections(`page.${folderPageId}`);

        // ensure folder mapping row exists for the directory path (with trailing slash)
        await this.upsertFolderMapping(source.id, relDir, title, folderPageId);

        // also map the actual README path to the same page for traceability
        await this.upsertGithubFile(source.id, relPath, body.sha, contentRes.etag, title, folderPageId);
        continue;
      }

      if (existing?.pageId) {
        this.logger.debug(`[fullSync] ${source.id} ${relPath} -> update page ${existing.pageId}`);
        await this.pageRepo.updatePage(
          {
            title: title,
            content: finalJson,
            textContent,
            ydoc: ydocBuf,
            lastUpdatedById: await this.getDefaultWorkspaceUserId(workspaceId),
            isLocked: true,
          },
          existing.pageId,
        );
        this.collab.closeDocumentConnections(`page.${existing.pageId}`);
        // Ensure correct tree placement according to folder structure
        await this.db
          .updateTable('pages')
          .set({ parentPageId: folderPageId ?? source.rootPageId ?? null, updatedAt: new Date() })
          .where('id', '=', existing.pageId)
          .execute();
      } else {
        const position = await this.nextPagePosition(source.spaceId, source.rootPageId ?? undefined);
        const created = await this.pageRepo.insertPage({
          slugId: generateSlugId(),
          title,
          content: finalJson,
          textContent,
          ydoc: ydocBuf,
          position,
          parentPageId: folderPageId ?? source.rootPageId ?? null,
          spaceId: source.spaceId,
          creatorId: await this.getDefaultWorkspaceUserId(workspaceId),
          workspaceId,
          lastUpdatedById: await this.getDefaultWorkspaceUserId(workspaceId),
          isLocked: true,
        });
        this.logger.debug(`[fullSync] ${source.id} ${relPath} -> create page ${created.id} parent=${folderPageId ?? source.rootPageId ?? null}`);
        this.collab.closeDocumentConnections(`page.${created.id}`);

        // link mapping to page
        await this.upsertGithubFile(source.id, relPath, body.sha, contentRes.etag, title, created.id);

        // assign attachments (created without pageId) to this page
        if (rewrite.attachmentIds.length > 0) {
          await this.db
            .updateTable('attachments')
            .set({ pageId: created.id, updatedAt: new Date() })
            .where('id', 'in', rewrite.attachmentIds)
            .execute();
        }
        continue;
      }

      // update mapping
      await this.upsertGithubFile(source.id, relPath, body.sha, contentRes.etag, title, existing?.pageId ?? (isIndexLike ? folderPageId : null));
    }

    // Update last_full_scan_sha for the source to current head
    try {
      const headSha = await this.gh.getCommitSha(source.owner, source.repo, source.ref, token);
      await this.db
        .updateTable('githubSources')
        .set({ lastFullScanSha: headSha, updatedAt: new Date() })
        .where('id', '=', source.id)
        .execute();
    } catch (e) {
      this.logger.warn(`Unable to update last_full_scan_sha for source ${source.id}`);
    }

    this.logger.log(`Full sync done for source ${sourceId}`);
  }

  /** Ensure folder chain pages exist for relDir (e.g., 'a/b'), return deepest folder pageId or null when relDir is ''. */
  private async ensureFolderChain(
    workspaceId: string,
    source: { id: string; spaceId: string; rootPageId: string | null },
    relDir: string,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    if (!relDir) return source.rootPageId ?? null;
    if (cache.has(relDir)) return cache.get(relDir)!;

    const segments = relDir.split('/');
    let currentPath = '';
    let parentId: string | null = source.rootPageId ?? null;

    for (const seg of segments) {
      currentPath = currentPath ? `${currentPath}/${seg}` : seg;

      // Look for an existing folder mapping for this cumulative path (stored with trailing slash)
      const mapping = await this.db
        .selectFrom('githubFiles')
        .select(['id', 'pageId'])
        .where('sourceId', '=', source.id)
        .where('path', '=', `${currentPath}/`)
        .executeTakeFirst();

      if (mapping?.pageId) {
        parentId = mapping.pageId;
        continue;
      }

      // Create a placeholder folder page
      const title = this.titleFromSegment(seg);
      const empty = { type: 'doc', content: [{ type: 'paragraph', content: [] }] } as any;
      const ydocBuf = createYdocFromJson(empty);
      const created = await this.pageRepo.insertPage({
        slugId: generateSlugId(),
        title,
        content: empty,
        textContent: '',
        ydoc: ydocBuf,
        position: await this.nextPagePosition(source.spaceId, parentId ?? undefined),
        parentPageId: parentId,
        spaceId: source.spaceId,
        creatorId: await this.getDefaultWorkspaceUserId(workspaceId),
        workspaceId,
        lastUpdatedById: await this.getDefaultWorkspaceUserId(workspaceId),
      });

      // Store mapping row marking this as a folder placeholder
      await this.upsertFolderMapping(source.id, currentPath, title, created.id);
      parentId = created.id;
    }

    cache.set(relDir, parentId);
    return parentId;
  }

  private titleFromSegment(seg: string): string {
    const s = decodeURIComponent(seg).replace(/[-_]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private async upsertFolderMapping(sourceId: string, dirPath: string, title: string | null, pageId: string) {
    const pathKey = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
    const row = await this.db
      .selectFrom('githubFiles')
      .select(['id'])
      .where('sourceId', '=', sourceId)
      .where('path', '=', pathKey)
      .executeTakeFirst();
    if (row) {
      await this.db
        .updateTable('githubFiles')
        .set({ title, pageId, updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute();
    } else {
      await this.db
        .insertInto('githubFiles')
        .values({
          sourceId,
          path: pathKey,
          contentType: 'folder',
          pageId,
          sha: null,
          etag: null,
          title,
          status: 'synced',
        } as any)
        .execute();
    }
  }

  private async getDefaultWorkspaceUserId(workspaceId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('users')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt')
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async upsertGithubFile(
    sourceId: string,
    path: string,
    sha: string,
    etag: string | undefined,
    title: string | null,
    pageId: string | null,
  ) {
    const row = await this.db
      .selectFrom('githubFiles')
      .select(['id'])
      .where('sourceId', '=', sourceId)
      .where('path', '=', path)
      .executeTakeFirst();

    if (row) {
      await this.db
        .updateTable('githubFiles')
        .set({ sha, etag: etag ?? null, title, pageId, updatedAt: new Date() })
        .where('id', '=', row.id)
        .execute();
    } else {
      await this.db
        .insertInto('githubFiles')
        .values({
          sourceId,
          path,
          contentType: 'markdown',
          pageId,
          sha,
          etag: etag ?? null,
          title,
          status: 'synced',
        })
        .execute();
    }
  }

  private async nextPagePosition(spaceId: string, parentPageId?: string) {
    const lastBase = this.db
      .selectFrom('pages')
      .select(['position'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1);

    if (parentPageId) {
      const last = await lastBase.where('parentPageId', '=', parentPageId).executeTakeFirst();
      return generateJitteredKeyBetween(last?.position ?? null, null);
    } else {
      const last = await lastBase.where('parentPageId', 'is', null).executeTakeFirst();
      return generateJitteredKeyBetween(last?.position ?? null, null);
    }
  }

  // ydoc creation delegated to createYdocFromJson from utils in fullSync

  async handlePush(payload: any, deliveryId: string) {
    this.logger.debug(`Push webhook ${deliveryId}`);
    const installationNumeric = payload?.installation?.id;
    let ghInstallRowId: string = null;
    if (installationNumeric) {
      const inst = await this.db
        .selectFrom('githubInstallations')
        .select(['id'])
        .where('installationId', '=', String(installationNumeric))
        .executeTakeFirst();
      ghInstallRowId = inst?.id ?? null;
    }

    const repoFullName = payload?.repository?.full_name ?? null;
    const before = payload?.before ?? null;
    const after = payload?.after ?? null;
    const filesJson = payload?.commits
      ? {
          added: [...new Set(payload.commits.flatMap((c) => c.added || []))],
          modified: [...new Set(payload.commits.flatMap((c) => c.modified || []))],
          removed: [...new Set(payload.commits.flatMap((c) => c.removed || []))],
        }
      : null;

    const ins = await this.db
      .insertInto('githubWebhookEvents')
      .values({
        githubInstallationId: ghInstallRowId,
        deliveryId: deliveryId,
        event: 'push',
        repoFullName: repoFullName,
        beforeSha: before,
        afterSha: after,
        filesJson: filesJson as any,
        processed: false,
      })
      .onConflict((oc) => oc.column('deliveryId').doNothing())
      .returning('id')
      .execute();
    if (!ins || ins.length === 0) {
      // duplicate event delivery; skip processing
      return;
    }

    // Process incrementals for matching sources
    try {
      if (!repoFullName || !after) return;
      const [owner, repo] = repoFullName.split('/');
      // ref like 'refs/heads/branch'
      const refRaw = payload?.ref as string | undefined;
      const branch = refRaw?.startsWith('refs/heads/')
        ? refRaw.substring('refs/heads/'.length)
        : (refRaw || '');

      const sources = await this.db
        .selectFrom('githubSources')
        .selectAll()
        .where('owner', '=', owner)
        .where('repo', '=', repo)
        .where('ref', '=', branch)
        .where('active', '=', true)
        .$if(!!ghInstallRowId, (qb) =>
          qb.where('githubInstallationId', '=', ghInstallRowId),
        )
        .execute();

      if (sources.length === 0) return;

      // Use Compare API to get robust change list
      // Use installation token from the first source's installation (assume same in practice)
      const token = await this.gh.getInstallationToken(sources[0].githubInstallationId);
      const cmp = await this.gh.compare(owner, repo, before, after, token);
      const files: Array<{ filename: string; status: string; previous_filename?: string }> = cmp?.files || [];

      for (const source of sources) {
        const prefix = source.rootDir ? (source.rootDir.endsWith('/') ? source.rootDir : `${source.rootDir}/`) : '';

        // cache folder pages per source for this webhook processing
        const folderCache = new Map<string, string | null>();
        for (const file of files) {
          const fpath = file.filename;
          if (!/\.(md|mdx)$/i.test(fpath)) continue;
          if (prefix && !fpath.startsWith(prefix)) continue;
          const relPath = prefix ? fpath.slice(prefix.length) : fpath;
          const relDir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
          const fileName = relPath.includes('/') ? relPath.substring(relPath.lastIndexOf('/') + 1) : relPath;
          const isIndexLike = /^(readme|index)\.(md|mdx)$/i.test(fileName) && relDir.length > 0;

          if (file.status === 'removed') {
            // mark mapping deleted & soft-delete page if exists
            const mapping = await this.db
              .selectFrom('githubFiles')
              .selectAll()
              .where('sourceId', '=', source.id)
              .where('path', '=', relPath)
              .executeTakeFirst();
            await this.db
              .updateTable('githubFiles')
              .set({ status: 'deleted', updatedAt: new Date() })
              .where('sourceId', '=', source.id)
              .where('path', '=', relPath)
              .execute();
            if (mapping?.pageId) {
              const actor = await this.getDefaultWorkspaceUserId(source.workspaceId);
              if (actor) {
                await this.pageRepo.removePage(mapping.pageId, actor);
              }
            }
            continue;
          }

          if (file.status === 'renamed' && file.previous_filename) {
            if (prefix && !file.previous_filename.startsWith(prefix)) {
              // previous path outside root_dir scope; skip renaming update in our mapping
            } else {
              const prev = prefix
                ? file.previous_filename.slice(prefix.length)
                : file.previous_filename;
            await this.db
              .updateTable('githubFiles')
              .set({ path: relPath, renamedFromPath: prev, updatedAt: new Date() })
              .where('sourceId', '=', source.id)
              .where('path', '=', prev)
              .execute();
            }
          }

          // added/modified or renamed → fetch content and upsert page mapping
          const existing = await this.db
            .selectFrom('githubFiles')
            .selectAll()
            .where('sourceId', '=', source.id)
            .where('path', '=', relPath)
            .executeTakeFirst();

          // Force fetch on push to guarantee freshness even if ETag didn't change
          const contentRes = await this.gh.getContent(owner, repo, fpath, source.ref, token, undefined);
          if (contentRes.status === 304) {
            await this.db
              .updateTable('githubFiles')
              .set({ updatedAt: new Date() })
              .where('sourceId', '=', source.id)
              .where('path', '=', relPath)
              .execute();
            continue;
          }
          if (contentRes.status !== 200) continue;

          const body = contentRes.body;
          const base64 = body?.content as string;
          const md = base64 ? Buffer.from(base64, 'base64').toString('utf-8') : '';
          const html = await this.mapper.markdownToHtml(md);
          const pageDir = fpath.includes('/') ? fpath.substring(0, fpath.lastIndexOf('/')) : '';
          const folderPageId = await this.ensureFolderChain(source.workspaceId, source, relDir, folderCache);
          const rewrite = await this.rewriter.rewriteHtml(html, {
            owner,
            repo,
            ref: source.ref,
            token,
            pageDir,
            workspaceId: source.workspaceId,
            spaceId: source.spaceId,
            pageId: isIndexLike ? (folderPageId ?? null) : (existing?.pageId ?? null),
            creatorId: await this.getDefaultWorkspaceUserId(source.workspaceId),
          });
          const prosemirrorJson = await this.mapper.htmlToTipTap(rewrite.html);
          const { title: extractedTitle, prosemirrorJson: finalJson } = await this.mapper.extractTitleAndRemoveHeading(prosemirrorJson);
          const title = extractedTitle;
          const ydocBuf = createYdocFromJson(finalJson);
          const textContent = jsonToText(finalJson);

          if (isIndexLike && folderPageId) {
            await this.pageRepo.updatePage(
              {
                title,
                content: finalJson,
                textContent,
                ydoc: ydocBuf,
                lastUpdatedById: await this.getDefaultWorkspaceUserId(source.workspaceId),
                isLocked: true,
              },
              folderPageId,
            );
            this.collab.closeDocumentConnections(`page.${folderPageId}`);
            await this.upsertFolderMapping(source.id, relDir, title, folderPageId);
            await this.upsertGithubFile(source.id, relPath, body.sha, contentRes.etag, title, folderPageId);
            continue;
          }

          if (existing?.pageId) {
            await this.pageRepo.updatePage(
              {
                title,
                content: finalJson,
                textContent,
                ydoc: ydocBuf,
                lastUpdatedById: await this.getDefaultWorkspaceUserId(source.workspaceId),
                isLocked: true,
              },
              existing.pageId,
            );
            this.collab.closeDocumentConnections(`page.${existing.pageId}`);
            // Ensure correct parent (folder wrapper) in case page was created before folder hierarchy support
            await this.db
              .updateTable('pages')
              .set({ parentPageId: folderPageId ?? source.rootPageId ?? null, updatedAt: new Date() })
              .where('id', '=', existing.pageId)
              .execute();
          } else {
            const position = await this.nextPagePosition(source.spaceId, source.rootPageId ?? undefined);
            const created = await this.pageRepo.insertPage({
              slugId: generateSlugId(),
              title,
              content: finalJson,
              textContent,
              ydoc: ydocBuf,
              position,
              parentPageId: folderPageId ?? source.rootPageId ?? null,
              spaceId: source.spaceId,
              creatorId: await this.getDefaultWorkspaceUserId(source.workspaceId),
              workspaceId: source.workspaceId,
              lastUpdatedById: await this.getDefaultWorkspaceUserId(source.workspaceId),
              isLocked: true,
            });
            this.collab.closeDocumentConnections(`page.${created.id}`);
            await this.upsertGithubFile(source.id, relPath, body.sha, contentRes.etag, title, created.id);
            if (rewrite.attachmentIds.length > 0) {
              await this.db
                .updateTable('attachments')
                .set({ pageId: created.id, updatedAt: new Date() })
                .where('id', 'in', rewrite.attachmentIds)
                .execute();
            }
            continue;
          }

          await this.upsertGithubFile(source.id, relPath, body.sha, contentRes.etag, title, existing?.pageId ?? null);
        }

        // mark source updatedAt after processing its changes
        await this.db
          .updateTable('githubSources')
          .set({ updatedAt: new Date() })
          .where('id', '=', source.id)
          .execute();
      }

      await this.db
        .updateTable('githubWebhookEvents')
        .set({ processed: true, ok: true, processedAt: new Date() } as any)
        .where('deliveryId', '=', deliveryId)
        .execute();
    } catch (err) {
      await this.db
        .updateTable('githubWebhookEvents')
        .set({ processed: true, ok: null, error: String(err), processedAt: new Date() } as any)
        .where('deliveryId', '=', deliveryId)
        .execute();
      this.logger.error('handlePush error', err as any);
    }
  }

  async updateSourceActive(workspaceId: string, sourceId: string, active?: boolean): Promise<boolean> {
    const src = await this.db
      .selectFrom('githubSources')
      .select(['id'])
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!src) throw new NotFoundException('Source not found');
    if (typeof active === 'boolean') {
      await this.db
        .updateTable('githubSources')
        .set({ active, updatedAt: new Date() })
        .where('id', '=', sourceId)
        .execute();
      return true;
    }
    return false;
  }

  async deleteSource(workspaceId: string, sourceId: string) {
    const src = await this.db
      .selectFrom('githubSources')
      .select(['id'])
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!src) throw new NotFoundException('Source not found');
    await this.db.deleteFrom('githubSources').where('id', '=', sourceId).execute();
  }

  async linkInstallation(workspaceId: string, dto: LinkInstallationDto) {
    const appId = this.env.getGithubAppId();
    const now = new Date();
    const existing = await this.db
      .selectFrom('githubInstallations')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('installationId', '=', dto.installationId)
      .executeTakeFirst();

    if (existing) {
      await this.db
        .updateTable('githubInstallations')
        .set({ accountLogin: dto.accountLogin, accountType: dto.accountType, appId, updatedAt: now })
        .where('id', '=', existing.id)
        .execute();
      return { ok: true, id: existing.id };
    }

    const row = await this.db
      .insertInto('githubInstallations')
      .values({
        workspaceId,
        appId,
        installationId: dto.installationId,
        accountLogin: dto.accountLogin,
        accountType: dto.accountType,
        createdAt: now,
        updatedAt: now,
      } as any)
      .returningAll()
      .executeTakeFirst();
    return { ok: true, id: row?.id };
  }
}

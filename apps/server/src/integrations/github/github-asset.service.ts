import { Injectable, Logger } from '@nestjs/common';
import { load } from 'cheerio';
import { Readable } from 'stream';
import * as path from 'path';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { StorageService } from '../storage/storage.service';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getMimeType } from '../../common/helpers';
import { GithubApiService } from './github-api.service';
import { deriveAssetAttachmentId, resolveRepoPath } from './github.utils';

const MAX_ASSET_BYTES = 50 * 1024 * 1024;

export type AssetRewriteContext = {
  html: string;
  /** repo-relative path of the markdown file whose links we are resolving */
  filePath: string;
  /** repo path -> blob sha, from the tree listing */
  blobShas: Map<string, string>;
  source: {
    id: string;
    owner: string;
    repo: string;
    workspaceId: string;
    spaceId: string;
  };
  token: string;
  actorId: string;
};

/**
 * Turns relative asset references in GitHub markdown into Docmost attachments.
 *
 * An asset whose blob sha is unchanged since the last sync keeps its existing
 * attachment, so re-syncing a repo does not re-upload every image.
 *
 * Residual risk: the storage upload and the two DB writes below are not one
 * distributed transaction. If the process dies after the upload but before
 * the attachments/github_files rows commit, the uploaded object is orphaned
 * in storage — the deterministic id means the *next* successful run
 * overwrites it rather than piling up a new one, but nothing proactively
 * reclaims storage bytes for a path that's never retried (eg. removed from
 * the doc before that retry happens). A storage GC pass would close this;
 * out of scope here.
 */
@Injectable()
export class GithubAssetService {
  private readonly logger = new Logger(GithubAssetService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storageService: StorageService,
    private readonly githubApi: GithubApiService,
  ) {}

  async rewriteAssets(
    ctx: AssetRewriteContext,
  ): Promise<{ html: string; attachmentIds: string[] }> {
    const $ = load(ctx.html);
    const attachmentIds: string[] = [];

    const targets: { el: any; attr: 'src' | 'href'; value: string }[] = [];
    $('img[src]').each((_, el) => {
      targets.push({ el, attr: 'src', value: $(el).attr('src') });
    });
    $('a[href]').each((_, el) => {
      targets.push({ el, attr: 'href', value: $(el).attr('href') });
    });

    for (const target of targets) {
      const repoPath = resolveRepoPath(ctx.filePath, target.value);
      if (!repoPath) continue;

      const sha = ctx.blobShas.get(repoPath);
      // a relative link pointing at a markdown file is a page link, not an asset
      if (!sha || /\.(md|mdx)$/i.test(repoPath)) continue;

      try {
        const attachment = await this.ensureAttachment(ctx, repoPath, sha);
        if (!attachment) continue;

        $(target.el).attr(
          target.attr,
          `/api/files/${attachment.id}/${attachment.fileName}`,
        );
        attachmentIds.push(attachment.id);
      } catch (err) {
        // Swallowing this would leave the page holding an unresolved relative
        // URL while the file is still recorded as synced — and the unchanged
        // -sha shortcut then stops anything from ever repairing it. Fail the
        // file instead so the job retries.
        throw new Error(
          `asset_import_failed: ${repoPath} from ${ctx.source.owner}/${ctx.source.repo} — ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    return { html: $.html(), attachmentIds };
  }

  private async ensureAttachment(
    ctx: AssetRewriteContext,
    repoPath: string,
    sha: string,
  ): Promise<{ id: string; fileName: string } | null> {
    const existing = await this.db
      .selectFrom('githubFiles')
      .select(['id', 'sha', 'attachmentId'])
      .where('sourceId', '=', ctx.source.id)
      .where('path', '=', repoPath)
      .where('contentType', '=', 'asset')
      .executeTakeFirst();

    // deterministic per (source, path): a retry after a partial failure, or
    // a later sync that finds the same content changed, reuses this exact
    // id instead of minting a new row that orphans the old one
    const attachmentId = deriveAssetAttachmentId(ctx.source.id, repoPath);
    const isFirstTimeForThisPath = existing?.attachmentId !== attachmentId;

    if (!isFirstTimeForThisPath && existing?.sha === sha) {
      const attachment = await this.db
        .selectFrom('attachments')
        .select(['id', 'fileName'])
        .where('id', '=', attachmentId)
        .executeTakeFirst();
      if (attachment) return attachment;
    }

    const buffer = await this.githubApi.getBlob(
      ctx.source.owner,
      ctx.source.repo,
      sha,
      ctx.token,
    );

    if (buffer.length > MAX_ASSET_BYTES) {
      this.logger.warn(`Skipping oversized asset ${repoPath} (${buffer.length} bytes)`);
      return null;
    }

    const fileName = path.posix.basename(repoPath);
    const fileExt = path.posix.extname(fileName);
    const storageFilePath = `${getAttachmentFolderPath(
      AttachmentType.File,
      ctx.source.workspaceId,
    )}/${attachmentId}/${fileName}`;

    try {
      await this.storageService.uploadStream(
        storageFilePath,
        Readable.from(buffer),
        { recreateClient: true },
      );

      // upsert, not insert: the id is stable across retries/content updates
      await this.db
        .insertInto('attachments')
        .values({
          id: attachmentId,
          filePath: storageFilePath,
          fileName,
          fileSize: buffer.length,
          mimeType: getMimeType(fileName),
          type: AttachmentType.File,
          fileExt,
          creatorId: ctx.actorId,
          workspaceId: ctx.source.workspaceId,
          spaceId: ctx.source.spaceId,
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            filePath: storageFilePath,
            fileName,
            fileSize: buffer.length,
            mimeType: getMimeType(fileName),
            fileExt,
            updatedAt: new Date(),
          }),
        )
        .execute();

      await this.db
        .insertInto('githubFiles')
        .values({
          sourceId: ctx.source.id,
          path: repoPath,
          contentType: 'asset',
          sha,
          attachmentId,
          status: 'synced',
        })
        .onConflict((oc) =>
          oc.columns(['sourceId', 'path']).doUpdateSet({
            sha,
            attachmentId,
            status: 'synced',
            error: null,
            updatedAt: new Date(),
          }),
        )
        .execute();
    } catch (err) {
      if (isFirstTimeForThisPath) {
        // nothing referenced this row yet; a half-finished import must not
        // leave it behind for nothing to ever clean up. The uploaded storage
        // bytes are not rolled back here — see the class doc comment.
        await this.db
          .deleteFrom('attachments')
          .where('id', '=', attachmentId)
          .execute()
          .catch(() => {});
      }
      throw err;
    }

    return { id: attachmentId, fileName };
  }
}

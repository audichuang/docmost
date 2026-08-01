import { Injectable, Logger } from '@nestjs/common';
import { load } from 'cheerio';
import { Readable } from 'stream';
import { v7 } from 'uuid';
import * as path from 'path';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { StorageService } from '../storage/storage.service';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getMimeType } from '../../common/helpers';
import { GithubApiService } from './github-api.service';
import { resolveRepoPath } from './github.utils';

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
        this.logger.warn(
          `Failed to import asset ${repoPath} from ${ctx.source.owner}/${ctx.source.repo}: ${
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

    if (existing?.attachmentId && existing.sha === sha) {
      const attachment = await this.db
        .selectFrom('attachments')
        .select(['id', 'fileName'])
        .where('id', '=', existing.attachmentId)
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

    const attachmentId = v7();
    const fileName = path.posix.basename(repoPath);
    const fileExt = path.posix.extname(fileName);
    const storageFilePath = `${getAttachmentFolderPath(
      AttachmentType.File,
      ctx.source.workspaceId,
    )}/${attachmentId}/${fileName}`;

    await this.storageService.uploadStream(
      storageFilePath,
      Readable.from(buffer),
      { recreateClient: true },
    );

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

    return { id: attachmentId, fileName };
  }
}

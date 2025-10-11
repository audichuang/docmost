import { Injectable, Logger } from '@nestjs/common';
import { load } from 'cheerio';
import { v7 as uuid7 } from 'uuid';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { StorageService } from '../storage/storage.service';
import { getAttachmentFolderPath } from '../../core/attachment/attachment.utils';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { getMimeType, sanitizeFileName } from '../../common/helpers';
import { GithubService } from './github.service';
import pLimit from 'p-limit';
import bytes from 'bytes';
import { EnvironmentService } from '../environment/environment.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';

@Injectable()
export class GithubLinkRewriter {
  private readonly logger = new Logger(GithubLinkRewriter.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storage: StorageService,
    private readonly gh: GithubService,
    private readonly env: EnvironmentService,
    @InjectQueue(QueueName.ATTACHMENT_QUEUE) private attachmentQueue: Queue,
  ) {}

  /**
   * Rewrites relative asset links to Docmost attachments and uploads content to storage.
   * Returns updated HTML and the list of created attachment IDs.
   */
  async rewriteHtml(
    html: string,
    opts: {
      owner: string;
      repo: string;
      ref: string;
      token: string;
      pageDir: string; // repo-relative directory of the page file
      workspaceId: string;
      spaceId: string;
      pageId?: string | null;
      creatorId?: string | null;
    },
  ): Promise<{ html: string; attachmentIds: string[] }> {
    const {
      owner,
      repo,
      ref,
      token,
      pageDir,
      workspaceId,
      spaceId,
      pageId,
      creatorId,
    } = opts;
    const $ = load(html);
    const created: string[] = [];
    const cache = new Map<string, { id: string; apiPath: string }>();
    let sizeLimit = 50 * 1024 * 1024;
    try {
      const limStr = this.env.getFileUploadSizeLimit() || '50mb';
      sizeLimit = bytes(limStr) as number;
    } catch {
      // Use default size limit if parsing fails
    }

    const resolveRel = (raw: string) => {
      try {
        const clean = decodeURIComponent(raw.replace(/^\.?\/+/, ''));
        // pageDir may be '' for root
        const prefix = pageDir
          ? pageDir.endsWith('/')
            ? pageDir
            : pageDir + '/'
          : '';
        const full = (prefix + clean).replace(/\\/g, '/');
        const normalized = full
          .split('/')
          .reduce<string[]>((acc, seg) => {
            if (seg === '.' || seg === '') return acc;
            if (seg === '..') acc.pop();
            else acc.push(seg);
            return acc;
          }, [])
          .join('/');
        return normalized;
      } catch {
        return null;
      }
    };

    const uploadOnce = async (repoPath: string) => {
      const cached = cache.get(repoPath);
      if (cached) return cached;

      // ensure we have creatorId before any upload to avoid orphan blobs
      if (!creatorId) {
        this.logger.warn(
          'No creatorId provided for attachment; skipping asset fetch',
        );
        return null;
      }

      // fetch via Contents API (base64)
      const r = await this.gh.getContent(owner, repo, repoPath, ref, token);
      if (r.status !== 200) {
        this.logger.warn(`asset fetch failed ${repoPath}: ${r.status}`);
        return null;
      }
      const base64 = r.body?.content as string;
      if (!base64) return null;
      const buf = Buffer.from(base64, 'base64');
      if (buf.length > sizeLimit) {
        this.logger.warn(
          `asset too large (${buf.length} > ${sizeLimit}): ${repoPath}`,
        );
        return null;
      }

      const ext = (repoPath.split('.').pop() || '').toLowerCase();
      const fileName = sanitizeFileName(
        repoPath.split('/').pop() || `file.${ext || 'bin'}`,
      );
      const mime = getMimeType(fileName);
      const id = uuid7();
      const storagePath = `${getAttachmentFolderPath(AttachmentType.File, workspaceId)}/${id}/${fileName}`;
      await this.storage.upload(storagePath, buf);

      await this.db
        .insertInto('attachments')
        .values({
          id,
          filePath: storagePath,
          fileName,
          fileSize: buf.length,
          mimeType: mime,
          type: 'file',
          fileExt: '.' + (ext || ''),
          creatorId: creatorId,
          workspaceId,
          pageId: pageId ?? null,
          spaceId,
        })
        .execute();

      // queue indexing for PDF/DOCX
      const extLower = (ext || '').toLowerCase();
      if (['pdf', 'docx'].includes(extLower)) {
        try {
          await this.attachmentQueue.add(
            QueueJob.ATTACHMENT_INDEX_CONTENT,
            { attachmentId: id },
            { removeOnComplete: true, removeOnFail: false },
          );
        } catch (e) {
          this.logger.warn(`failed to queue indexing for ${id}: ${String(e)}`);
        }
      }

      const apiPath = `/api/files/${id}/${fileName}`;
      const entry = { id, apiPath };
      cache.set(repoPath, entry);
      created.push(id);
      return entry;
    };

    // images
    $('img[src]').each((_, el) => {
      const $img = $(el);
      const src = ($img.attr('src') || '').trim();
      if (!src || /^https?:\/\//i.test(src) || src.startsWith('/api/files/'))
        return;
      $img.attr('data-pending-asset', src);
    });
    // videos
    $('video[src]').each((_, el) => {
      const $el = $(el);
      const src = ($el.attr('src') || '').trim();
      if (!src || /^https?:\/\//i.test(src) || src.startsWith('/api/files/'))
        return;
      $el.attr('data-pending-asset', src);
    });
    // <video><source src=...>
    $('video source[src]').each((_, el) => {
      const $el = $(el);
      const src = ($el.attr('src') || '').trim();
      if (!src || /^https?:\/\//i.test(src) || src.startsWith('/api/files/'))
        return;
      $el.attr('data-pending-asset', src);
    });
    // anchors (attachments)
    $('a[href]').each((_, el) => {
      const $a = $(el);
      const href = ($a.attr('href') || '').trim();
      if (
        !href ||
        /^https?:\/\//i.test(href) ||
        href.startsWith('/api/files/') ||
        href.startsWith('#')
      )
        return;
      $a.attr('data-pending-asset', href);
    });

    // process pending assets sequentially (can be optimized with p-limit)
    const limit = pLimit(4);
    const work = $('[data-pending-asset]')
      .toArray()
      .map((node) =>
        limit(async () => {
          const $el = $(node);
          const raw = $el.attr('data-pending-asset')!;
          const repoPath = resolveRel(raw);
          if (!repoPath) {
            $el.removeAttr('data-pending-asset');
            return;
          }
          const entry = await uploadOnce(repoPath);
          $el.removeAttr('data-pending-asset');
          if (!entry) return;

          if ($el.is('img')) {
            $el
              .attr('src', entry.apiPath)
              .attr('data-attachment-id', entry.id)
              .attr('width', $el.attr('width') || '100%')
              .attr('data-align', $el.attr('data-align') || 'center');
          } else if ($el.is('video')) {
            $el
              .attr('src', entry.apiPath)
              .attr('data-attachment-id', entry.id)
              .attr('width', $el.attr('width') || '100%')
              .attr('data-align', $el.attr('data-align') || 'center');
          } else if ($el.is('a')) {
            const fileName = entry.apiPath.split('/').pop()!;
            const mime = getMimeType(fileName);
            const $div = $('<div>')
              .attr('data-type', 'attachment')
              .attr('data-attachment-url', entry.apiPath)
              .attr('data-attachment-name', fileName)
              .attr('data-attachment-mime', mime)
              .attr('data-attachment-id', entry.id);
            $el.replaceWith($div);
          } else if ($el.is('source') && $el.parent('video').length) {
            // Replace <source src> inside <video> as well
            $el.attr('src', entry.apiPath).attr('data-attachment-id', entry.id);
          }
        }),
      );
    await Promise.all(work);

    return { html: $.root().html() || html, attachmentIds: created };
  }
}

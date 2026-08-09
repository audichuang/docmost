import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as crypto from 'crypto';
import { EnvironmentService } from '../environment/environment.service';
import { QueueJob, QueueName } from '../queue/constants';
import { GithubSyncService } from './github-sync.service';

/** A stable id per delivery so a redelivered webhook recreates the *same*
 *  job (idempotent) instead of being silently dropped or duplicated. */
export function pushJobId(deliveryId: string): string {
  return `github-push-${deliveryId}`;
}

/**
 * BullMQ ignores `add()` for an id that still exists in ANY state, and this
 * queue deliberately retains failed jobs. Without clearing a terminal job
 * first, a redelivery or the replay sweep returns success while creating no
 * work at all — the exact loss B3 set out to fix.
 */
export async function enqueuePushJob(
  queue: Queue,
  deliveryId: string,
  payload: unknown,
): Promise<void> {
  const jobId = pushJobId(deliveryId);
  const existing = await queue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    // already queued or running — leave it alone
    if (state !== 'completed' && state !== 'failed') return;
    await existing.remove().catch(() => undefined);
  }

  await queue.add(QueueJob.GITHUB_PUSH, { deliveryId, payload }, { jobId });
}

/**
 * B3: pure replay rule — a delivery only counts as "already handled" once it
 * has been processed *successfully*.
 *
 * `recordDelivery` returning false just means the row already exists; on its
 * own that is not proof the push was ever queued (the process may have died
 * between the insert and the `queue.add()` call), so a still-unprocessed row
 * must go out again.
 *
 * A row that was processed but failed (`ok = false`, e.g. GitHub was briefly
 * unreachable and BullMQ exhausted its attempts) must also be replayable —
 * GitHub's redelivery is exactly the second chance that case needs.
 */
export function shouldReplayDelivery(
  row: { processed: boolean; ok: boolean | null } | undefined,
): boolean {
  if (!row) return true;
  return !row.processed || row.ok === false;
}

@Controller('integrations/github')
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly sync: GithubSyncService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.GITHUB_QUEUE) private readonly githubQueue: Queue,
  ) {}

  @HttpCode(202)
  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') event: string,
    @Headers('x-github-delivery') deliveryId: string,
  ) {
    const secret = this.env.getGithubWebhookSecret();
    if (!secret) throw new UnauthorizedException('webhook_not_configured');
    if (!deliveryId || !event) throw new BadRequestException('missing_headers');

    this.verifySignature(req.rawBody, signature, secret);

    const payload = req.body as any;

    // the unique delivery_id is what makes redelivery idempotent
    const isNew = await this.sync.recordDelivery({ deliveryId, event, payload });

    if (event === 'push') {
      if (!isNew) {
        // "already recorded" is not the same as "already processed" — only
        // skip if a prior attempt actually finished the job
        const existing = await this.db
          .selectFrom('githubWebhookEvents')
          .select(['processed', 'ok'])
          .where('deliveryId', '=', deliveryId)
          .executeTakeFirst();

        if (!shouldReplayDelivery(existing)) {
          this.logger.debug(`Ignoring already-processed GitHub delivery ${deliveryId}`);
          return { ok: true, duplicate: true };
        }
        // fall through: recorded but never finished — (re)enqueue below
      }

      // an in-flight job is left alone; a terminal one is cleared first so
      // the redelivery actually creates work
      await enqueuePushJob(this.githubQueue, deliveryId, payload);
      return { ok: true };
    }

    if (!isNew) {
      this.logger.debug(`Ignoring duplicate GitHub delivery ${deliveryId}`);
      return { ok: true, duplicate: true };
    }

    // Close the row out: we are never going to act on this event, and a row
    // left unprocessed is invisible to the retention sweep, which only removes
    // processed deliveries.
    await this.sync.finishDelivery(deliveryId, true, `ignored: ${event}`);
    return { ok: true };
  }

  private verifySignature(rawBody: Buffer, signature: string, secret: string) {
    if (!rawBody || !signature) {
      throw new UnauthorizedException('missing_signature');
    }

    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')}`;

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);

    // timingSafeEqual throws on length mismatch, so check that first
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new UnauthorizedException('invalid_signature');
    }
  }
}

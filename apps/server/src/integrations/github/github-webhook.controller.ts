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
import * as crypto from 'crypto';
import { EnvironmentService } from '../environment/environment.service';
import { QueueJob, QueueName } from '../queue/constants';
import { GithubSyncService } from './github-sync.service';

@Controller('integrations/github')
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);

  constructor(
    private readonly env: EnvironmentService,
    private readonly sync: GithubSyncService,
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

    // the unique delivery_id is what makes redelivery a no-op
    const isNew = await this.sync.recordDelivery({ deliveryId, event, payload });
    if (!isNew) {
      this.logger.debug(`Ignoring duplicate GitHub delivery ${deliveryId}`);
      return { ok: true, duplicate: true };
    }

    if (event === 'push') {
      await this.githubQueue.add(QueueJob.GITHUB_PUSH, { deliveryId, payload });
    }

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

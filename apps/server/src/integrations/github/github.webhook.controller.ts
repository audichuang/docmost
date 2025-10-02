import { Controller, Headers, Post, Req, HttpCode, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { GithubSyncService } from './github.sync.service';
import { EnvironmentService } from '../environment/environment.service';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';

@Controller('integrations/github')
export class GithubWebhookController {
  constructor(
    private readonly sync: GithubSyncService,
    private readonly env: EnvironmentService,
  ) {}

  @Public()
  @SkipTransform()
  @HttpCode(200)
  @Post('webhook')
  async handle(
    @Req() req: any,
    @Headers('x-github-event') event: string,
    @Headers('x-github-delivery') delivery: string,
    @Headers('x-hub-signature-256') sig256: string,
  ) {
    const secret = this.env.getGithubWebhookSecret();
    const raw = req.rawBody ?? JSON.stringify(req.body ?? {});
    if (!secret || !sig256) {
      Logger.warn('GitHub webhook missing secret or signature', GithubWebhookController.name);
      return { ok: false, error: 'invalid-signature' };
    }
    const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (exp.length !== sig256.length) {
      Logger.warn('GitHub webhook signature length mismatch', GithubWebhookController.name);
      return { ok: false, error: 'invalid-signature' };
    }
    if (!crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig256))) {
      Logger.warn('GitHub webhook signature mismatch', GithubWebhookController.name);
      return { ok: false, error: 'invalid-signature' };
    }

    if (event === 'ping') return { ok: true };
    if (event === 'push') {
      await this.sync.handlePush(req.body, delivery);
      return { ok: true };
    }
    if (event === 'installation' || event === 'installation_repositories') {
      await this.sync.handleInstallation(req.body, event);
      return { ok: true };
    }
    return { ok: true };
  }
}

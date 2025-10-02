import { Module } from '@nestjs/common';
import { GithubController } from './github.controller';
import { GithubWebhookController } from './github.webhook.controller';
import { GithubService } from './github.service';
import { GithubSyncService } from './github.sync.service';
import { GithubSyncProgressService } from './github-sync-progress.service';
import { GithubLinkRewriter } from './github.link-rewriter';
import { GithubMapper } from './github.mapper';
import { ImportModule } from '../import/import.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { EnvironmentModule } from '../environment/environment.module';

@Module({
  imports: [EnvironmentModule, ImportModule, CollaborationModule],
  controllers: [GithubController, GithubWebhookController],
  providers: [
    GithubService,
    GithubSyncService,
    GithubSyncProgressService,
    GithubLinkRewriter,
    GithubMapper,
  ],
})
export class GithubModule {}

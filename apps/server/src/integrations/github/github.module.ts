import { Module } from '@nestjs/common';
import { PageModule } from '../../core/page/page.module';
import { StorageModule } from '../storage/storage.module';
import { GithubApiService } from './github-api.service';
import { GithubAssetService } from './github-asset.service';
import { GithubSyncService } from './github-sync.service';
import { GithubController } from './github.controller';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubProcessor } from './github.processor';

@Module({
  imports: [PageModule, StorageModule],
  controllers: [GithubController, GithubWebhookController],
  providers: [
    GithubApiService,
    GithubAssetService,
    GithubSyncService,
    GithubProcessor,
  ],
  exports: [GithubSyncService],
})
export class GithubModule {}

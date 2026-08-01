import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../queue/constants';
import { GithubSyncService } from './github-sync.service';

@Processor(QueueName.GITHUB_QUEUE)
export class GithubProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(GithubProcessor.name);

  constructor(private readonly sync: GithubSyncService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case QueueJob.GITHUB_FULL_SYNC: {
        const { sourceId, force } = job.data;
        await job.updateProgress({ phase: 'starting', current: 0, total: 0 });
        const result = await this.sync.fullSync(sourceId, {
          force,
          onProgress: (p) =>
            job.updateProgress({ phase: 'syncing', ...p }),
        });
        await job.updateProgress({
          phase: 'completed',
          current: result.files,
          total: result.files,
          truncated: result.truncated,
        });
        break;
      }

      case QueueJob.GITHUB_PUSH: {
        const { deliveryId, payload } = job.data;
        await this.sync.handlePush(deliveryId, payload);
        break;
      }
    }
  }

  @OnWorkerEvent('failed')
  onError(job: Job, err: Error) {
    this.logger.error(`GitHub job ${job?.name} failed: ${err.message}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

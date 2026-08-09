import { Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job, Queue } from 'bullmq';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { QueueJob, QueueName } from '../queue/constants';
import { GithubSyncService } from './github-sync.service';
import { enqueuePushJob } from './github-webhook.controller';
import { GITHUB_LOCK_NAMESPACE, githubLockKey } from './github.utils';

// how long a contended job waits before checking the lock again — the lock
// itself has no separate timeout, see withSourceLock
const LOCK_RETRY_DELAY_MS = 5_000;

// how long a delivery is given to be picked up normally before the sweep
// below treats it as abandoned
const REPLAY_STALE_AFTER_MS = 10 * 60 * 1000;
const REPLAY_BATCH_SIZE = 50;

// Every push stores its entire webhook payload as jsonb, and nothing ever
// removed a row — on an active repo this is the fastest-growing table in the
// database, in a deployment where disk is often the scarce resource. A
// processed delivery has served both of its purposes long before this:
// idempotency (GitHub's redelivery window is hours) and forensics.
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

@Processor(QueueName.GITHUB_QUEUE)
export class GithubProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(GithubProcessor.name);

  constructor(
    private readonly sync: GithubSyncService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.GITHUB_QUEUE) private readonly githubQueue: Queue,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<void> {
    const lockKey = await this.resolveLockKey(job);

    // no ref identity to serialize on (payload we can't map to a repo/ref) —
    // there is nothing to race with, so just run it
    if (!lockKey) {
      await this.run(job);
      return;
    }

    const outcome = await this.withSourceLock(lockKey, () => this.run(job));
    if (outcome.acquired) return;

    // A6: another job for this owner/repo/ref is already running — that is
    // exactly the race that lets a full scan write stale content after a
    // newer push already synced it (or two pushes land out of order), so
    // wait our turn instead of running concurrently. moveToDelayed + throwing
    // DelayedError is BullMQ's sanctioned way to requeue a job without
    // burning a retry attempt or losing it.
    await job.moveToDelayed(Date.now() + LOCK_RETRY_DELAY_MS, token);
    throw new DelayedError();
  }

  private async run(job: Job): Promise<void> {
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

  /**
   * A6: both job kinds lock on the same owner/repo/ref key so a full scan of
   * a source can never run at the same time as a push touching that same
   * source (or another push for the same ref) — on any node, since this is a
   * database-wide advisory lock rather than a per-process one. This mirrors
   * (without replacing) the source lookup GithubSyncService.handlePush does
   * internally; keep the two in sync if that lookup ever changes.
   */
  private async resolveLockKey(job: Job): Promise<string | null> {
    if (job.name === QueueJob.GITHUB_FULL_SYNC) {
      const source = await this.db
        .selectFrom('githubSources')
        .select(['owner', 'repo', 'ref'])
        .where('id', '=', job.data?.sourceId ?? '')
        .executeTakeFirst();
      return source ? githubLockKey(source.owner, source.repo, source.ref) : null;
    }

    if (job.name === QueueJob.GITHUB_PUSH) {
      const repoFullName: string = job.data?.payload?.repository?.full_name;
      const branch = String(job.data?.payload?.ref ?? '').replace(
        /^refs\/heads\//,
        '',
      );
      if (!repoFullName || !branch) return null;

      const [owner, repo] = repoFullName.split('/');
      return owner && repo ? githubLockKey(owner, repo, branch) : null;
    }

    return null;
  }

  /**
   * Holds a Postgres transaction-scoped advisory lock for the duration of
   * `fn`, keyed by `lockKey`. Transaction scope means the lock is released
   * automatically on commit *or* rollback — no separate unlock call, and no
   * risk of a slow job's stale unlock clearing a different job's live lock.
   * ponytail: pins one pool connection for the life of `fn` (a full sync can
   * run minutes); fine at GITHUB_QUEUE's current concurrency, revisit with a
   * dedicated lock connection if that stops being true.
   */
  private async withSourceLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    return executeTx(this.db, async (trx) => {
      const lock = await sql<{ locked: boolean }>`
        select pg_try_advisory_xact_lock(${GITHUB_LOCK_NAMESPACE}::int, hashtext(${lockKey})) as locked
      `.execute(trx);

      if (!lock.rows[0]?.locked) return { acquired: false as const };

      const result = await fn();
      return { acquired: true as const, result };
    });
  }

  /**
   * B3: a GitHub redelivery is what normally recovers a push that was
   * recorded but never queued (see github-webhook.controller.ts), but GitHub
   * only retries for a limited window. If Redis was unavailable for longer
   * than that, nothing will ever ask us to try again — sweep anything still
   * unprocessed past a grace period and re-enqueue it ourselves. The
   * deterministic jobId makes this safe to run even while a slow delivery is
   * still legitimately in flight.
   */
  @Interval('github-webhook-replay', 5 * 60 * 1000)
  async replayStaleDeliveries(): Promise<void> {
    const stale = await this.db
      .selectFrom('githubWebhookEvents')
      .select(['deliveryId', 'payload'])
      // Only the crash window (recorded but never enqueued). A row that ran
      // and failed stays out of this sweep on purpose — replaying it here
      // would retry forever every interval. Those get their second chance
      // from GitHub's own redelivery, which is bounded, via
      // shouldReplayDelivery() in the webhook controller.
      .where('processed', '=', false)
      .where('event', '=', 'push')
      .where('createdAt', '<', new Date(Date.now() - REPLAY_STALE_AFTER_MS))
      .limit(REPLAY_BATCH_SIZE)
      .execute();

    for (const row of stale) {
      try {
        await enqueuePushJob(this.githubQueue, row.deliveryId, row.payload);
      } catch (err) {
        this.logger.warn(
          `Failed to replay stale GitHub delivery ${row.deliveryId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Keeps github_webhook_events bounded — see DELIVERY_RETENTION_MS. */
  @Interval('github-webhook-prune', 6 * 60 * 60 * 1000)
  async pruneOldDeliveries(): Promise<void> {
    const res = await this.db
      .deleteFrom('githubWebhookEvents')
      // unprocessed rows are the replay sweep's business, never this one's
      .where('processed', '=', true)
      .where('createdAt', '<', new Date(Date.now() - DELIVERY_RETENTION_MS))
      .executeTakeFirst();

    const removed = Number(res.numDeletedRows ?? 0);
    if (removed > 0) {
      this.logger.log(`Pruned ${removed} GitHub webhook delivery record(s)`);
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


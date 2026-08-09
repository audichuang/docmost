import { Kysely, CamelCasePlugin } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import * as crypto from 'crypto';
import { v7 as uuidv7 } from 'uuid';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { GithubSyncService } from './github-sync.service';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubProcessor } from './github.processor';

/**
 * Retention only works if every row eventually reaches `processed = true`. The
 * sweep deletes processed rows, and events we deliberately ignore were being
 * recorded and then left unprocessed forever — so exactly the events the setup
 * guide tells operators to subscribe to (installation,
 * installation_repositories) were the ones that grew without bound.
 *
 * That is a claim about rows in a table, so it is checked against a real one.
 * See github-sync.integration.spec.ts for the setup instructions.
 */
const TEST_DB_URL = process.env.GITHUB_TEST_DATABASE_URL;
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

const WEBHOOK_SECRET = 'test-webhook-secret';

describeWithDb('GitHub webhook retention against a real database', () => {
  let db: KyselyDB;
  let sqlClient: ReturnType<typeof postgres>;
  let controller: GithubWebhookController;
  let processor: GithubProcessor;
  let queue: { getJob: jest.Mock; add: jest.Mock };

  const deliveries: string[] = [];

  beforeAll(() => {
    sqlClient = postgres(TEST_DB_URL, { max: 3, onnotice: () => {} });
    db = new Kysely<any>({
      dialect: new PostgresJSDialect({ postgres: sqlClient }),
      plugins: [new CamelCasePlugin()],
    }) as unknown as KyselyDB;

    const sync = new GithubSyncService(
      db,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    queue = { getJob: jest.fn().mockResolvedValue(undefined), add: jest.fn() };
    const env = {
      getGithubWebhookSecret: () => WEBHOOK_SECRET,
    } as any;

    controller = new GithubWebhookController(env, sync, db, queue as any);
    processor = new GithubProcessor(sync, db, queue as any);
  });

  afterAll(async () => {
    if (deliveries.length > 0) {
      await db
        .deleteFrom('githubWebhookEvents')
        .where('deliveryId', 'in', deliveries)
        .execute();
    }
    await db.destroy();
  });

  async function deliver(event: string, payload: unknown): Promise<string> {
    const deliveryId = `int-${uuidv7()}`;
    deliveries.push(deliveryId);

    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')}`;

    await controller.handleWebhook(
      { rawBody, body: payload } as any,
      signature,
      event,
      deliveryId,
    );

    return deliveryId;
  }

  async function row(deliveryId: string) {
    return db
      .selectFrom('githubWebhookEvents')
      .select(['processed', 'ok', 'error'])
      .where('deliveryId', '=', deliveryId)
      .executeTakeFirst();
  }

  async function backdate(deliveryId: string, days: number) {
    await db
      .updateTable('githubWebhookEvents')
      .set({ createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
      .where('deliveryId', '=', deliveryId)
      .execute();
  }

  it('closes out an event it will never act on, so retention can reclaim it', async () => {
    const deliveryId = await deliver('installation', {
      action: 'created',
      installation: { id: 1 },
    });

    const recorded = await row(deliveryId);
    expect(recorded.processed).toBe(true);
    expect(recorded.ok).toBe(true);
    expect(recorded.error).toBe('ignored: installation');
    expect(queue.add).not.toHaveBeenCalled();

    await backdate(deliveryId, 40);
    await processor.pruneOldDeliveries();

    expect(await row(deliveryId)).toBeUndefined();
  });

  /**
   * The other half of the rule: an unprocessed push is the replay sweep's only
   * record that work was lost, so retention must not be the thing that removes
   * it — however old it is.
   */
  it('keeps an unprocessed push out of the retention sweep', async () => {
    const deliveryId = await deliver('push', {
      ref: 'refs/heads/main',
      before: '1'.repeat(40),
      after: '2'.repeat(40),
      repository: { full_name: 'acme/docs' },
    });

    const recorded = await row(deliveryId);
    expect(recorded.processed).toBe(false);
    expect(queue.add).toHaveBeenCalledTimes(1);

    await backdate(deliveryId, 400);
    await processor.pruneOldDeliveries();

    expect((await row(deliveryId)).processed).toBe(false);
  });

  it('reclaims a push once it has actually been processed', async () => {
    const deliveryId = await deliver('push', {
      ref: 'refs/heads/main',
      before: '3'.repeat(40),
      after: '4'.repeat(40),
      repository: { full_name: 'acme/docs' },
    });

    await db
      .updateTable('githubWebhookEvents')
      .set({ processed: true, processedAt: new Date(), ok: true })
      .where('deliveryId', '=', deliveryId)
      .execute();

    await backdate(deliveryId, 40);
    await processor.pruneOldDeliveries();

    expect(await row(deliveryId)).toBeUndefined();
  });

  it('rejects a body whose signature does not match', async () => {
    const deliveryId = `int-${uuidv7()}`;
    deliveries.push(deliveryId);

    await expect(
      controller.handleWebhook(
        { rawBody: Buffer.from('{}'), body: {} } as any,
        'sha256=deadbeef',
        'push',
        deliveryId,
      ),
    ).rejects.toThrow('invalid_signature');

    expect(await row(deliveryId)).toBeUndefined();
  });
});

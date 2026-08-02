import { fullSyncJobId } from './github.controller';
import { pushJobId } from './github-webhook.controller';

/**
 * BullMQ rejects a custom job id containing ':' unless it splits into exactly
 * three parts (classes/job.js). Both of ours used to be `prefix:uuid`, which
 * splits into two — so every enqueue threw and the whole sync was dead. No
 * unit test caught it because none exercised BullMQ's own validation, so the
 * rule is asserted directly here.
 */
function bullmqRejects(jobId: string): boolean {
  return jobId.includes(':') && jobId.split(':').length !== 3;
}

describe('BullMQ job id compatibility', () => {
  const sourceId = '018f0000-0000-7000-8000-000000000000';
  const deliveryId = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

  it('accepts the full-sync job id', () => {
    expect(bullmqRejects(fullSyncJobId(sourceId))).toBe(false);
  });

  it('accepts the push job id', () => {
    expect(bullmqRejects(pushJobId(deliveryId))).toBe(false);
  });

  it('still distinguishes different sources and deliveries', () => {
    expect(fullSyncJobId('a')).not.toBe(fullSyncJobId('b'));
    expect(pushJobId('a')).not.toBe(pushJobId('b'));
  });

  it('proves the guard catches the shape that used to be shipped', () => {
    expect(bullmqRejects(`github-full-sync:${sourceId}`)).toBe(true);
  });
});

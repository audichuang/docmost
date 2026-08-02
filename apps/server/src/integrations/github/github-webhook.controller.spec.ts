import { pushJobId, shouldReplayDelivery } from './github-webhook.controller';

describe('pushJobId', () => {
  it('is deterministic per delivery', () => {
    expect(pushJobId('11111111-1111-1111-1111-111111111111')).toBe(
      pushJobId('11111111-1111-1111-1111-111111111111'),
    );
  });

  it('differs across deliveries', () => {
    expect(pushJobId('delivery-a')).not.toBe(pushJobId('delivery-b'));
  });
});

describe('shouldReplayDelivery', () => {
  /**
   * B3: recordDelivery() returning false only proves the row already
   * exists — it says nothing about whether the push it recorded ever made
   * it onto the queue. A row still `processed = false` must be replayed.
   */
  it('replays a delivery that was recorded but never processed', () => {
    expect(shouldReplayDelivery({ processed: false, ok: null })).toBe(true);
  });

  it('does not replay a delivery that already succeeded', () => {
    expect(shouldReplayDelivery({ processed: true, ok: true })).toBe(false);
  });

  /**
   * finishDelivery() marks a failed run processed=true, ok=false. Keying
   * only on `processed` would make GitHub's redelivery — the one bounded
   * retry that case has left — a silent no-op.
   */
  it('replays a delivery that was processed but failed', () => {
    expect(shouldReplayDelivery({ processed: true, ok: false })).toBe(true);
  });

  /**
   * Defensive: recordDelivery() returning false guarantees the row exists,
   * so this shouldn't happen in practice, but a lookup race should fail
   * open (replay) rather than silently swallow a possibly-lost event.
   */
  it('replays when the row cannot be found at all', () => {
    expect(shouldReplayDelivery(undefined)).toBe(true);
  });
});

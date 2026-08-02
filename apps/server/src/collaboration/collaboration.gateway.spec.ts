import { CollaborationGateway } from './collaboration.gateway';

/**
 * A1: handleYjsEvent must never silently no-op. Previously it was
 * `return this.redisSync?.handleEvent(...)`, which resolved to `undefined`
 * with no write at all whenever redisSync was null (COLLAB_DISABLE_REDIS=
 * true, single-node mode) — the caller had no way to tell a write didn't
 * happen. It must now either perform the write (locally, since there's no
 * other node to proxy to) or throw.
 *
 * `isCollabDisableRedis` is stubbed to return `true` so the gateway's
 * constructor never builds a real ioredis client / RedisSyncExtension —
 * these tests never touch the network.
 */
describe('CollaborationGateway.handleYjsEvent (A1)', () => {
  function buildGateway() {
    const environmentService = {
      getRedisUrl: () => 'redis://127.0.0.1:6379',
      isCollabDisableRedis: () => true,
    };

    const collabEventsService = {
      getHandlers: jest.fn(),
    };

    const gateway = new CollaborationGateway(
      {} as any, // AuthenticationExtension
      {} as any, // PersistenceExtension
      {} as any, // LoggerExtension
      environmentService as any,
      collabEventsService as any,
    );

    return { gateway, collabEventsService };
  }

  it('applies the event locally against this node\'s own hocuspocus instance when there is no redisSync', async () => {
    const { gateway, collabEventsService } = buildGateway();
    const updatePageContent = jest.fn().mockResolvedValue(undefined);
    collabEventsService.getHandlers.mockReturnValue({ updatePageContent });

    const payload = { operation: 'replace', prosemirrorJson: {}, user: {} };
    await gateway.handleYjsEvent(
      'updatePageContent' as any,
      'page.1',
      payload as any,
    );

    expect(updatePageContent).toHaveBeenCalledWith('page.1', payload);
  });

  it('throws instead of silently resolving when there is no redisSync and no matching handler', async () => {
    const { gateway, collabEventsService } = buildGateway();
    collabEventsService.getHandlers.mockReturnValue({});

    await expect(
      gateway.handleYjsEvent('updatePageContent' as any, 'page.1', {} as any),
    ).rejects.toThrow(/Invalid eventName/);
  });

  it('delegates to redisSync.handleEvent instead of the local fallback when Redis sync is configured', async () => {
    const { gateway } = buildGateway();
    const handleEvent = jest.fn().mockResolvedValue('ok');
    (gateway as any).redisSync = { handleEvent };

    const payload = { foo: 'bar' };
    const result = await gateway.handleYjsEvent(
      'updatePageContent' as any,
      'page.1',
      payload as any,
    );

    expect(handleEvent).toHaveBeenCalledWith(
      'updatePageContent',
      'page.1',
      payload,
    );
    expect(result).toBe('ok');
  });
});

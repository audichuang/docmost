import {
  RedisSyncExtension,
  RENEW_LOCK_SCRIPT,
  RELEASE_LOCK_SCRIPT,
} from './redis-sync.extension';

/**
 * C1: renewLock/releaseLock must be compare-and-set/delete against the
 * serverId that currently owns the key, so a node that lost the lock (e.g.
 * it paused past the TTL and another node claimed it) cannot renew or
 * delete a lock it no longer owns.
 *
 * A real Redis is not available in this test environment, so these fakes
 * implement just enough of ioredis's surface (get/set/del/eval, plus the
 * no-op pub/sub calls RedisSyncExtension's constructor makes) to run the
 * extension's real production code — including the two Lua scripts it
 * ships — against a shared in-memory store representing one Redis
 * deployment. `eval` is matched by script *reference* (not re-implementing
 * a Lua interpreter), so this also proves the extension actually calls the
 * exported CAS scripts rather than falling back to something unconditional.
 */
class FakeRedisServer {
  store = new Map<string, string>();
}

class FakeRedisClient {
  constructor(private readonly server: FakeRedisServer) {}

  duplicate() {
    return new FakeRedisClient(this.server);
  }

  on() {
    return this;
  }

  subscribe(..._channels: string[]) {
    return Promise.resolve(0);
  }

  publish(_channel: string, _message: unknown) {
    return Promise.resolve(0);
  }

  disconnect() {}

  async get(key: string): Promise<string | null> {
    return this.server.store.has(key) ? this.server.store.get(key)! : null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    const flags = args.map((a) => String(a).toUpperCase());
    const nx = flags.includes('NX');
    const getOld = flags.includes('GET');
    const old = this.server.store.has(key) ? this.server.store.get(key)! : null;

    if (nx && old !== null) {
      return getOld ? old : null;
    }
    this.server.store.set(key, value);
    return getOld ? old : 'OK';
  }

  async del(key: string) {
    return this.server.store.delete(key) ? 1 : 0;
  }

  async eval(script: string, _numKeys: number, key: string, ...args: unknown[]) {
    const current = this.server.store.has(key)
      ? this.server.store.get(key)!
      : null;
    const owner = String(args[0]);

    if (script === RENEW_LOCK_SCRIPT) {
      if (current !== owner) return 0;
      this.server.store.set(key, owner);
      return 'OK';
    }
    if (script === RELEASE_LOCK_SCRIPT) {
      if (current !== owner) return 0;
      this.server.store.delete(key);
      return 1;
    }
    throw new Error(`FakeRedisClient: unexpected eval script:\n${script}`);
  }
}

function buildExtension(serverId: string, server: FakeRedisServer) {
  return new RedisSyncExtension<any>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redis: new FakeRedisClient(server) as any,
    serverId,
    prefix: 'test',
    lockTTL: 50,
    pack: ((m: unknown) => m) as any,
    unpack: ((m: unknown) => m) as any,
    customEvents: {},
  });
}

describe('RedisSyncExtension lock ownership (C1)', () => {
  const documentName = 'page.1';

  // getOrClaimLock schedules a short internal cleanup setTimeout that isn't
  // relevant to what's under test here; fake timers keep it from becoming a
  // real, unref'd Node timer that outlives the test.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lets the current owner renew and release its own lock', async () => {
    const server = new FakeRedisServer();
    const nodeA = buildExtension('node-A', server);

    await (nodeA as any).getOrClaimLock(documentName);
    expect([...server.store.values()]).toEqual(['node-A']);

    await expect(nodeA.renewLock(documentName)).resolves.toBe(true);
    expect([...server.store.values()]).toEqual(['node-A']);

    await expect(nodeA.releaseLock(documentName)).resolves.toBe(true);
    expect(server.store.size).toBe(0);
  });

  it('does not let a former owner renew or release a lock another node has since claimed', async () => {
    const server = new FakeRedisServer();
    const nodeA = buildExtension('node-A', server);
    const nodeB = buildExtension('node-B', server);

    // Node A claims the lock first.
    await (nodeA as any).getOrClaimLock(documentName);
    expect([...server.store.values()]).toEqual(['node-A']);

    // Simulate node A pausing past the TTL: Redis expires the key on its own.
    const key = (nodeA as any).getKey(documentName);
    server.store.delete(key);

    // Node B legitimately claims the now-free lock.
    await (nodeB as any).getOrClaimLock(documentName);
    expect(server.store.get(key)).toBe('node-B');

    // Node A resumes and its stale renewal timer fires. Before C1 this was
    // an unconditional SET that would have overwritten node B's ownership.
    await expect(nodeA.renewLock(documentName)).resolves.toBe(false);
    expect(server.store.get(key)).toBe('node-B');

    // Node A's document eventually unloads and calls releaseLock. Before
    // C1 this was an unconditional DEL that would have erased node B's lock.
    await expect(nodeA.releaseLock(documentName)).resolves.toBe(false);
    expect(server.store.get(key)).toBe('node-B');

    // Node B, the real owner, can still renew and release normally.
    await expect(nodeB.renewLock(documentName)).resolves.toBe(true);
    await expect(nodeB.releaseLock(documentName)).resolves.toBe(true);
    expect(server.store.size).toBe(0);
  });
});

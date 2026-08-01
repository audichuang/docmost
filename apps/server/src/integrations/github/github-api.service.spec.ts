import { GithubApiService } from './github-api.service';
import { EnvironmentService } from '../environment/environment.service';
import { KyselyDB } from '@docmost/db/types/kysely.types';

const env = {
  getGithubApiBase: () => 'https://api.github.com',
  getGithubApiVersion: () => '2022-11-28',
} as unknown as EnvironmentService;

describe('GithubApiService.getBlob', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /**
   * Regression: decoding a blob with res.text() replaces every non-UTF-8 byte
   * with U+FFFD, silently corrupting every imported image.
   */
  it('returns image bytes unchanged', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xfe, 0x00,
    ]);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    }) as unknown as typeof fetch;

    const service = new GithubApiService(env, {} as KyselyDB);
    const result = await service.getBlob('o', 'r', 'sha', 'token');

    expect(result.equals(png)).toBe(true);
  });

  it('asks GitHub for the raw media type', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new GithubApiService(env, {} as KyselyDB);
    await service.getBlob('o', 'r', 'sha', 'token');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/git/blobs/sha');
    expect(init.headers.Accept).toBe('application/vnd.github.raw');
  });

  it('surfaces a non-200 as a gateway error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    const service = new GithubApiService(env, {} as KyselyDB);
    await expect(service.getBlob('o', 'r', 'sha', 'token')).rejects.toThrow(
      'github_blob_failed',
    );
  });
});

import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EnvironmentService } from '../environment/environment.service';
import { assertRepoCoordinates } from './github.utils';

export type GithubTreeEntry = {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
};

export type GithubCompareFile = {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'changed' | 'copied';
  previous_filename?: string;
  sha?: string;
};

type CachedInstallationToken = { token: string; expiresAt: number };

/**
 * Thin GitHub REST client scoped to what the sync needs.
 * Auth is GitHub App style: app JWT -> installation access token.
 */
@Injectable()
export class GithubApiService {
  private readonly logger = new Logger(GithubApiService.name);
  private readonly tokenCache = new Map<string, CachedInstallationToken>();

  constructor(
    private readonly env: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.env.getGithubAppId() && this.env.getGithubPrivateKey());
  }

  private get apiBase(): string {
    return this.env.getGithubApiBase();
  }

  private getAppJwt(): string {
    const appId = this.env.getGithubAppId();
    // PEM pasted into a single-line env var arrives with literal \n
    const privateKey = this.env.getGithubPrivateKey()?.replace(/\\n/g, '\n');

    if (!appId || !privateKey) {
      throw new InternalServerErrorException('missing_github_app_credentials');
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      // iat backdated 60s to tolerate clock skew; GitHub caps exp at 10 minutes
      return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: appId }, privateKey, {
        algorithm: 'RS256',
      });
    } catch {
      this.logger.error(
        'Failed to sign GitHub App JWT — check GITHUB_APP_PRIVATE_KEY newline format',
      );
      throw new InternalServerErrorException('invalid_github_private_key_format');
    }
  }

  private headers(token: string, extra?: Record<string, string>) {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.env.getGithubApiVersion(),
      'User-Agent': 'Docmost',
      Authorization: `Bearer ${token}`,
      ...extra,
    };
  }

  private async request(
    path: string,
    opts: {
      token: string;
      method?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<{ status: number; json: any; headers: Headers; body?: Response }> {
    const { token, method = 'GET', timeoutMs = 15000, retries = 2 } = opts;
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: this.headers(token, opts.headers),
          signal: controller.signal,
        });

        // 304 carries no body; callers treat it as "unchanged"
        if (res.status === 304) return { status: 304, json: null, headers: res.headers };

        if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
          const reset = res.headers.get('x-ratelimit-reset');
          throw new BadGatewayException(
            `github_rate_limited${reset ? `_until_${reset}` : ''}`,
          );
        }

        // 5xx and 429 are worth another go; 4xx is not
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastError = new Error(`github_http_${res.status}`);
          await this.backoff(attempt);
          continue;
        }

        const text = await res.text();
        return {
          status: res.status,
          json: text ? safeJsonParse(text) : null,
          headers: res.headers,
        };
      } catch (err) {
        lastError = err;
        if (err instanceof BadGatewayException) throw err;
        if (attempt >= retries) break;
        await this.backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BadGatewayException(
      `github_request_failed: ${lastError instanceof Error ? lastError.message : 'unknown'}`,
    );
  }

  private backoff(attempt: number): Promise<void> {
    return new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }

  /**
   * Byte-preserving fetch. `request()` decodes the body as UTF-8, which
   * destroys every non-ASCII byte of an image — this must be used for blobs.
   */
  private async requestBytes(
    path: string,
    opts: { token: string; accept: string; timeoutMs?: number },
  ): Promise<{ status: number; buffer: Buffer | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);

    try {
      const res = await fetch(`${this.apiBase}${path}`, {
        headers: this.headers(opts.token, { Accept: opts.accept }),
        signal: controller.signal,
      });

      if (!res.ok) return { status: res.status, buffer: null };

      return {
        status: res.status,
        buffer: Buffer.from(await res.arrayBuffer()),
      };
    } catch (err) {
      throw new BadGatewayException(
        `github_request_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Installation tokens are valid for an hour; cache them so a large sync
   * does not mint one per file.
   */
  async getInstallationToken(installationRowId: string): Promise<string> {
    const cached = this.tokenCache.get(installationRowId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

    const installation = await this.db
      .selectFrom('githubInstallations')
      .select(['installationId'])
      .where('id', '=', installationRowId)
      .executeTakeFirst();

    if (!installation) throw new NotFoundException('github_installation_not_found');

    const res = await this.request(
      `/app/installations/${installation.installationId}/access_tokens`,
      { token: this.getAppJwt(), method: 'POST' },
    );

    if (res.status !== 201 || !res.json?.token) {
      throw new BadGatewayException('github_installation_token_failed');
    }

    this.tokenCache.set(installationRowId, {
      token: res.json.token,
      expiresAt: new Date(res.json.expires_at).getTime(),
    });

    return res.json.token;
  }

  invalidateToken(installationRowId: string) {
    this.tokenCache.delete(installationRowId);
  }

  async getInstallationInfo(installationId: string) {
    const res = await this.request(`/app/installations/${installationId}`, {
      token: this.getAppJwt(),
    });
    return res.status === 200 ? res.json : null;
  }

  async listRepos(installationRowId: string) {
    const token = await this.getInstallationToken(installationRowId);
    const repos: any[] = [];

    for (let page = 1; page <= 10; page++) {
      const res = await this.request(
        `/installation/repositories?per_page=100&page=${page}`,
        { token },
      );
      if (res.status !== 200) break;
      const batch = res.json?.repositories ?? [];
      repos.push(...batch);
      if (batch.length < 100) break;
    }

    return repos.map((r) => ({
      owner: r.owner?.login,
      repo: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
    }));
  }

  async listRefs(installationRowId: string, owner: string, repo: string) {
    assertRepoCoordinates(owner, repo);
    const token = await this.getInstallationToken(installationRowId);

    const fetchPaged = async (kind: 'branches' | 'tags') => {
      const items: any[] = [];
      for (let page = 1; page <= 5; page++) {
        const res = await this.request(
          `/repos/${owner}/${repo}/${kind}?per_page=100&page=${page}`,
          { token },
        );
        if (res.status !== 200) break;
        const batch = res.json ?? [];
        items.push(...batch);
        if (batch.length < 100) break;
      }
      return items;
    };

    const [branches, tags] = await Promise.all([
      fetchPaged('branches'),
      fetchPaged('tags'),
    ]);

    return [
      ...branches.map((b) => ({ name: b?.name, type: 'branch' as const })),
      ...tags.map((t) => ({ name: t?.name, type: 'tag' as const })),
    ].filter((r) => r.name);
  }

  async getTree(
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ): Promise<{ entries: GithubTreeEntry[]; truncated: boolean }> {
    assertRepoCoordinates(owner, repo);
    const res = await this.request(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { token, timeoutMs: 30000 },
    );
    if (res.status !== 200) throw new BadGatewayException('github_tree_failed');

    return {
      entries: (res.json?.tree ?? []) as GithubTreeEntry[],
      truncated: Boolean(res.json?.truncated),
    };
  }

  /** Raw file bytes via the blob SHA — avoids the 1MB contents-API ceiling. */
  async getBlob(
    owner: string,
    repo: string,
    sha: string,
    token: string,
  ): Promise<Buffer> {
    assertRepoCoordinates(owner, repo);

    const res = await this.requestBytes(
      `/repos/${owner}/${repo}/git/blobs/${sha}`,
      { token, accept: 'application/vnd.github.raw' },
    );

    if (res.status !== 200 || !res.buffer) {
      throw new BadGatewayException('github_blob_failed');
    }

    return res.buffer;
  }

  /** Fetch by path when the SHA is unknown (webhook payloads only give paths). */
  async getContentByPath(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    token: string,
  ): Promise<{ status: number; buffer?: Buffer; sha?: string }> {
    assertRepoCoordinates(owner, repo);

    const res = await this.request(
      `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
      { token, timeoutMs: 30000 },
    );

    if (res.status !== 200) return { status: res.status };
    if (res.json?.content) {
      return {
        status: 200,
        buffer: Buffer.from(res.json.content, res.json.encoding ?? 'base64'),
        sha: res.json.sha,
      };
    }
    // file larger than 1MB — contents API omits the body, fall back to the blob
    if (res.json?.sha) {
      return {
        status: 200,
        buffer: await this.getBlob(owner, repo, res.json.sha, token),
        sha: res.json.sha,
      };
    }
    return { status: 404 };
  }

  async compare(
    owner: string,
    repo: string,
    base: string,
    head: string,
    token: string,
  ): Promise<GithubCompareFile[]> {
    assertRepoCoordinates(owner, repo);

    const res = await this.request(
      `/repos/${owner}/${repo}/compare/${base}...${head}`,
      { token, timeoutMs: 30000 },
    );
    if (res.status !== 200) throw new BadGatewayException('github_compare_failed');
    return (res.json?.files ?? []) as GithubCompareFile[];
  }

  async getCommitSha(
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ): Promise<string | null> {
    assertRepoCoordinates(owner, repo);

    const res = await this.request(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      { token },
    );
    return res.status === 200 ? (res.json?.sha ?? null) : null;
  }

  /** Reconcile the local installation rows with what GitHub actually reports. */
  async syncInstallationsFromGitHub(workspaceId: string) {
    const rows = await this.db
      .selectFrom('githubInstallations')
      .select(['id', 'installationId'])
      .where('workspaceId', '=', workspaceId)
      .execute();

    for (const row of rows) {
      const info = await this.getInstallationInfo(row.installationId);
      if (!info) {
        // uninstalled on the GitHub side
        await this.db
          .deleteFrom('githubInstallations')
          .where('id', '=', row.id)
          .execute();
        this.tokenCache.delete(row.id);
        continue;
      }

      await this.db
        .updateTable('githubInstallations')
        .set({
          accountLogin: info.account?.login,
          accountType: info.account?.type,
          updatedAt: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
    }

    return this.db
      .selectFrom('githubInstallations')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
  }
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

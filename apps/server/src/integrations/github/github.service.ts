import { Injectable, Logger, NotFoundException, ForbiddenException, BadGatewayException, InternalServerErrorException } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private apiBase: string;
  private apiVersion: string;

  constructor(
    private readonly env: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {
    this.apiBase = this.env.getGithubApiBase();
    this.apiVersion = this.env.getGithubApiVersion();
  }

  private getAppJwt(): string {
    const appId = this.env.getGithubAppId();
    const privateKey = this.env.getGithubPrivateKey()?.replace(/\\n/g, '\n');
    if (!appId || !privateKey) {
      throw new InternalServerErrorException('missing_github_app_credentials');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
    try {
      return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
    } catch (err) {
      this.logger.error('Failed to sign GitHub App JWT. Check GITHUB_APP_PRIVATE_KEY format (PEM newlines).');
      throw new InternalServerErrorException('invalid_github_private_key_format');
    }
  }

  private headers(token?: string) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.apiVersion,
      'User-Agent': 'Docmost-Server',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async fetchJson(
    url: string,
    init?: RequestInit & { timeoutMs?: number; retries?: number },
  ) {
    const { timeoutMs = this.env.getGithubFetchTimeoutMs(), retries = this.env.getGithubFetchRetries(), ...rest } = init || {};
    const attempt = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 15000);
      try {
        const res = await fetch(url, { ...rest, signal: controller.signal } as RequestInit);
        const text = await res.text();
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        return { res, json } as const;
      } finally {
        clearTimeout(timeout);
      }
    };

    let last: { res: Response; json: any } | null = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const out = await attempt();
        last = out;
        const status = out.res.status;
        if (status === 429 || status >= 500) {
          if (i < retries) {
            const base = this.env.getGithubFetchBackoffBaseMs();
            await new Promise((r) => setTimeout(r, base * Math.pow(2, i)));
            continue;
          }
        }
        return out;
      } catch (err) {
        if (i < retries) {
          const base = this.env.getGithubFetchBackoffBaseMs();
          await new Promise((r) => setTimeout(r, base * Math.pow(2, i)));
          continue;
        }
        throw err;
      }
    }
    return last as any;
  }

  async getInstallationToken(githubInstallationRowId: string): Promise<string> {
    const row = await this.db
      .selectFrom('githubInstallations')
      .select(['installationId'])
      .where('id', '=', githubInstallationRowId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('installation not found');

    const appJwt = this.getAppJwt();
    const url = `${this.apiBase}/app/installations/${row.installationId}/access_tokens`;
    const { res, json } = await this.fetchJson(url, {
      method: 'POST',
      headers: this.headers(appJwt),
    });
    if (!res.ok) {
      this.logger.error(`Failed to get installation token: ${res.status} ${res.statusText} ${JSON.stringify(json)}`);
      throw new BadGatewayException('installation_token_error');
    }
    return json.token as string;
  }

  async listInstallations(workspaceId: string) {
    return this.db
      .selectFrom('githubInstallations')
      .select([ 'id','installationId','accountLogin','accountType','createdAt' ])
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async listRepos(workspaceId: string, githubInstallationRowId: string) {
    const inst = await this.db
      .selectFrom('githubInstallations')
      .select(['id', 'workspaceId'])
      .where('id', '=', githubInstallationRowId)
      .executeTakeFirst();
    if (!inst) throw new NotFoundException('installation not found');
    if (inst.workspaceId !== workspaceId) throw new ForbiddenException();

    const token = await this.getInstallationToken(githubInstallationRowId);

    // Pagination: GitHub defaults to 30 items/page. Fetch all pages to avoid missing repos.
    const perPage = 100;
    let page = 1;
    let repositories: any[] = [];
    let total = 0;
    while (true) {
      const url = `${this.apiBase}/installation/repositories?per_page=${perPage}&page=${page}`;
      const { res, json } = await this.fetchJson(url, {
        headers: this.headers(token),
      });
      if (!res.ok) {
        this.logger.error(`listRepos error: ${res.status} ${res.statusText}`);
        throw new BadGatewayException('list_repos_error');
      }
      const reposPage: any[] = json?.repositories || [];
      total = json?.total_count ?? total;
      repositories.push(...reposPage);
      if (reposPage.length < perPage) break; // last page
      page += 1;
      if (page > 50) break; // safety cap to avoid accidental infinite loops
    }
    return { total_count: total || repositories.length, repositories };
  }

  async getTree(owner: string, repo: string, ref: string, token: string) {
    const url = `${this.apiBase}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const { res, json } = await this.fetchJson(url, {
      headers: this.headers(token),
    });
    if (!res.ok) throw new BadGatewayException('get_tree_error');
    return json;
  }

  async getContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    token: string,
    etag?: string,
  ) {
    const url = `${this.apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
    const headers = this.headers(token);
    if (etag) headers['If-None-Match'] = etag;
    const { res, json } = await this.fetchJson(url, { headers });
    const newEtag = res.headers.get('etag') || undefined;
    return { status: res.status, body: json, etag: newEtag } as const;
  }

  async compare(owner: string, repo: string, before: string, after: string, token: string) {
    const url = `${this.apiBase}/repos/${owner}/${repo}/compare/${encodeURIComponent(before)}...${encodeURIComponent(after)}`;
    const { res, json } = await this.fetchJson(url, { headers: this.headers(token) });
    if (!res.ok) throw new BadGatewayException('compare_error');
    return json;
  }

  /** Returns commit SHA for a ref (branch/tag/sha). */
  async getCommitSha(owner: string, repo: string, ref: string, token: string): Promise<string> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
    const { res, json } = await this.fetchJson(url, { headers: this.headers(token) });
    if (!res.ok) throw new BadGatewayException('get_commit_error');
    return json?.sha as string;
  }

  async listRefs(
    workspaceId: string,
    githubInstallationRowId: string,
    owner: string,
    repo: string,
  ) {
    const inst = await this.db
      .selectFrom('githubInstallations')
      .select(['id', 'workspaceId'])
      .where('id', '=', githubInstallationRowId)
      .executeTakeFirst();
    if (!inst) throw new NotFoundException('installation not found');
    if (inst.workspaceId !== workspaceId) throw new ForbiddenException();

    const token = await this.getInstallationToken(githubInstallationRowId);

    const perPage = 100;
    const fetchPaged = async (path: string) => {
      let page = 1;
      const items: any[] = [];
      while (true) {
        const url = `${this.apiBase}${path}?per_page=${perPage}&page=${page}`;
        const { res, json } = await this.fetchJson(url, {
          headers: this.headers(token),
        });
        if (!res.ok) break;
        const list = Array.isArray(json) ? json : [];
        items.push(...list);
        if (list.length < perPage) break;
        page += 1;
        if (page > 100) break;
      }
      return items;
    };

    const branches = await fetchPaged(`/repos/${owner}/${repo}/branches`);
    const tags = await fetchPaged(`/repos/${owner}/${repo}/tags`);

    const branchItems = branches.map((b: any) => ({ name: b?.name, type: 'branch' }));
    const tagItems = tags.map((t: any) => ({ name: t?.name, type: 'tag' }));
    return { items: [...branchItems, ...tagItems] };
  }
}

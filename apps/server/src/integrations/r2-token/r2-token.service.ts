import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';

type CachedToken = { token: string; expiresAt: number };

/**
 * Mints short-lived access tokens for images served from a token-protected
 * Cloudflare R2 domain.
 *
 * The token is handed to the browser and appended at render time — it is
 * deliberately never written into page content, because tokens expire and
 * document content is persisted.
 *
 * ponytail: per-process cache. A miss costs one HTTP call every few minutes
 * per node; move it to Redis only if that ever shows up in the Worker's logs.
 */
@Injectable()
export class R2TokenService {
  private readonly logger = new Logger(R2TokenService.name);
  private cached: CachedToken | null = null;
  private inFlight: Promise<CachedToken> | null = null;

  private static readonly REFRESH_MARGIN_MS = 30_000;

  constructor(private readonly env: EnvironmentService) {}

  isEnabled(): boolean {
    return Boolean(this.env.getR2ImageDomain() && this.env.getR2TokenSecret());
  }

  async getToken(): Promise<CachedToken> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('r2_token_not_configured');
    }

    if (
      this.cached &&
      this.cached.expiresAt - Date.now() > R2TokenService.REFRESH_MARGIN_MS
    ) {
      return this.cached;
    }

    // collapse concurrent refreshes into one upstream call
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async fetchToken(): Promise<CachedToken> {
    const domain = this.env.getR2ImageDomain();
    const secret = this.env.getR2TokenSecret();
    const validitySeconds = this.env.getR2TokenValiditySeconds();

    const url = new URL(`https://${domain}/api/generate-token`);
    // the Worker's existing contract expects the secret as a query param
    url.searchParams.set('secret', secret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Docmost' },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`token endpoint returned ${res.status}`);
      }

      const body = (await res.json()) as { success?: boolean; token?: string };
      if (!body?.success || !body.token || !body.token.includes('.')) {
        throw new Error('token endpoint returned an unusable payload');
      }

      this.cached = {
        token: body.token,
        expiresAt: Date.now() + validitySeconds * 1000,
      };

      this.logger.debug(`Minted R2 token, valid ${validitySeconds}s`);
      return this.cached;
    } catch (err) {
      this.logger.error(
        `Failed to mint R2 token: ${err instanceof Error ? err.message : err}`,
      );
      throw new ServiceUnavailableException('r2_token_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}

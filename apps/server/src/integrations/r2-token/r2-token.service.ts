import { Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import axios from 'axios';

interface TokenResponse {
  success: boolean;
  token: string;
  expiresIn: string;
  timestamp: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

@Injectable()
export class R2TokenService {
  private readonly logger = new Logger(R2TokenService.name);
  private cachedToken: CachedToken | null = null;
  private readonly REFRESH_THRESHOLD_SECONDS = 30; // Refresh token 30 seconds before expiry

  constructor(private readonly environmentService: EnvironmentService) {}

  /**
   * Get or generate a valid token for R2 image access
   * Fetches token from external API
   */
  async getOrGenerateToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.cachedToken && !this.isTokenExpiringSoon(this.cachedToken)) {
      this.logger.log('[R2 Token] Using cached token');
      return this.cachedToken.token;
    }

    // Fetch new token from external API
    this.logger.log('[R2 Token] Fetching new token from external API');
    const token = await this.fetchTokenFromApi();

    // Cache token (default 5 minutes)
    const validitySeconds =
      this.environmentService.getR2TokenValiditySeconds();
    this.cachedToken = {
      token,
      expiresAt: Date.now() + validitySeconds * 1000,
    };

    this.logger.log(
      `[R2 Token] Token cached, expires in ${validitySeconds} seconds`,
    );

    return token;
  }

  /**
   * Fetch token from external API
   */
  private async fetchTokenFromApi(): Promise<string> {
    const r2Domain = this.environmentService.getR2ImageDomain();
    const secret = this.environmentService.getR2TokenSecret();

    if (!r2Domain) {
      throw new Error('R2_IMAGE_DOMAIN is not configured');
    }

    if (!secret) {
      throw new Error('R2_TOKEN_SECRET is not configured');
    }

    const apiUrl = `https://${r2Domain}/api/generate-token?secret=${secret}`;

    // Log API call (hide secret)
    this.logger.log(
      `[R2 Token] Calling API: https://${r2Domain}/api/generate-token?secret=***`,
    );

    try {
      const response = await axios.get<TokenResponse>(apiUrl, {
        timeout: 10000, // 10 second timeout
        headers: {
          'User-Agent': 'Docmost-Server',
        },
      });

      if (!response.data.success || !response.data.token) {
        this.logger.error(
          `[R2 Token] Invalid API response`,
          JSON.stringify(response.data),
        );
        throw new Error('Invalid API response: missing token');
      }

      const { token, timestamp, expiresIn } = response.data;

      // Log success details (without exposing token)
      this.logger.log(`[R2 Token] ✅ API Response Success`);
      this.logger.log(`[R2 Token] Timestamp: ${timestamp}`);
      this.logger.log(`[R2 Token] Expires In: ${expiresIn}`);
      this.logger.log(`[R2 Token] Token Length: ${token.length} characters`);

      // Parse token parts for validation
      const [timestampPart, signaturePart] = token.split('.');
      if (!timestampPart || !signaturePart) {
        throw new Error('Invalid token format from API');
      }

      this.logger.log(`[R2 Token] Token format validated successfully`);

      return token;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (axios.isAxiosError(error)) {
        this.logger.error(
          `[R2 Token] ❌ HTTP Error: ${error.response?.status} ${error.response?.statusText}`,
        );
        this.logger.error(
          `[R2 Token] Response Data:`,
          JSON.stringify(error.response?.data),
        );
      } else {
        this.logger.error(`[R2 Token] ❌ Error: ${errorMessage}`);
      }
      throw new Error(`Failed to fetch R2 token: ${errorMessage}`);
    }
  }

  /**
   * Check if the cached token is expiring soon
   */
  private isTokenExpiringSoon(cachedToken: CachedToken): boolean {
    const now = Date.now();
    const timeUntilExpiry = cachedToken.expiresAt - now;
    const thresholdMs = this.REFRESH_THRESHOLD_SECONDS * 1000;

    const isExpiringSoon = timeUntilExpiry <= thresholdMs;

    if (isExpiringSoon) {
      this.logger.log(
        `[R2 Token] Token expiring soon (${Math.floor(timeUntilExpiry / 1000)}s remaining)`,
      );
    }

    return isExpiringSoon;
  }

  /**
   * Clear the cached token (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cachedToken = null;
    this.logger.log('[R2 Token] Cache cleared');
  }
}

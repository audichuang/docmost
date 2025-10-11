import { Controller, Get, Logger } from '@nestjs/common';
import { R2TokenService } from './r2-token.service';
import { EnvironmentService } from '../environment/environment.service';

@Controller('api/r2-token')
export class R2TokenController {
  private readonly logger = new Logger(R2TokenController.name);

  constructor(
    private readonly r2TokenService: R2TokenService,
    private readonly environmentService: EnvironmentService,
  ) {}

  /**
   * Test endpoint to verify R2 token generation and configuration
   * GET /api/r2-token/test
   */
  @Get('/test')
  async testToken() {
    this.logger.log('[Test] R2 Token test endpoint called');

    try {
      // Fetch token
      const token = await this.r2TokenService.getOrGenerateToken();
      const [timestampPart, signaturePart] = token.split('.');

      // Get configuration
      const r2Domain = this.environmentService.getR2ImageDomain();
      const validitySeconds =
        this.environmentService.getR2TokenValiditySeconds();

      // Calculate token timing
      const now = Date.now();
      const tokenTime = parseInt(timestampPart);
      const expiresAt = tokenTime + validitySeconds * 1000;
      const isExpired = now > expiresAt;
      const timeUntilExpiry = expiresAt - now;

      this.logger.log('[Test] ✅ Token test successful');

      // Only expose full token in development mode
      const isDevelopment = process.env.NODE_ENV === 'development';
      const safeToken = isDevelopment ? token : `${token.substring(0, 20)}...[REDACTED]`;

      // Build test URL (use safe token in production)
      const testImageUrl = `https://${r2Domain}/docmost/test-image.png?token=${safeToken}`;

      return {
        success: true,
        token: safeToken,
        tokenParts: {
          timestamp: timestampPart,
          signature: isDevelopment ? signaturePart.substring(0, 32) + '...' : '[REDACTED]',
        },
        config: {
          r2Domain,
          validitySeconds,
          apiEndpoint: `https://${r2Domain}/api/generate-token`,
        },
        validation: {
          isExpired,
          timeUntilExpiry: `${Math.floor(timeUntilExpiry / 1000)} seconds`,
          timeUntilExpiryMs: timeUntilExpiry,
        },
        times: {
          now: new Date(now).toISOString(),
          tokenGenerated: new Date(tokenTime).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
        },
        testUrl: testImageUrl,
        usage: {
          curl: `curl -I "${testImageUrl}"`,
          browser: testImageUrl,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[Test] ❌ Token test failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
        config: {
          r2Domain: this.environmentService.getR2ImageDomain(),
          hasSecret: !!this.environmentService.getR2TokenSecret(),
        },
        troubleshooting: {
          checkR2Domain: 'Ensure R2_IMAGE_DOMAIN is set in .env',
          checkSecret: 'Ensure R2_TOKEN_SECRET or APP_SECRET is set',
          checkApi: 'Verify the API endpoint is accessible',
          testApiManually: `curl "https://${this.environmentService.getR2ImageDomain()}/api/generate-token?secret=YOUR_SECRET"`,
        },
      };
    }
  }

  /**
   * Clear cached token (for testing)
   * GET /api/r2-token/clear-cache
   */
  @Get('/clear-cache')
  clearCache() {
    this.r2TokenService.clearCache();
    this.logger.log('[Test] Token cache cleared');

    return {
      success: true,
      message: 'Token cache cleared successfully',
    };
  }
}

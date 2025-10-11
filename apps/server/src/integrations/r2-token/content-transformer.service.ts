import { Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import { R2TokenService } from './r2-token.service';

@Injectable()
export class ContentTransformerService {
  private readonly logger = new Logger(ContentTransformerService.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly r2TokenService: R2TokenService,
  ) {}

  /**
   * Transform content by adding token parameter to R2 image URLs
   * Handles HTML, Markdown, and JSON formats
   */
  async transformContent(content: string): Promise<string> {
    if (!content) {
      return content;
    }

    const r2Domain = this.environmentService.getR2ImageDomain();
    this.logger.log(`[R2 Transform] R2 Domain: ${r2Domain}`);

    if (!r2Domain) {
      this.logger.warn(
        `[R2 Transform] R2_IMAGE_DOMAIN not configured, skipping transformation`,
      );
      return content;
    }

    // Quick check: does content contain the R2 domain?
    const hasR2Urls = content.includes(r2Domain);
    this.logger.log(`[R2 Transform] Content contains R2 URLs: ${hasR2Urls}`);
    this.logger.log(
      `[R2 Transform] Content length: ${content.length} characters`,
    );

    if (!hasR2Urls) {
      return content;
    }

    // Get or generate token
    const token = await this.r2TokenService.getOrGenerateToken();
    const tokenPrefix = token.substring(0, 10);
    this.logger.log(
      `[R2 Transform] Using Token: ${tokenPrefix}... (${token.length} chars)`,
    );

    // Transform URLs
    const transformedContent = this.appendTokenToUrls(content, r2Domain, token);

    this.logger.log(`[R2 Transform] Transformation completed successfully`);
    return transformedContent;
  }

  /**
   * Append token parameter to all R2 image URLs in the content
   * Supports various formats:
   * - HTML: <img src="https://domain/path/image.png">
   * - Markdown: ![alt](https://domain/path/image.png)
   * - JSON: "src": "https://domain/path/image.png"
   * - Plain URLs: https://domain/path/image.png
   */
  private appendTokenToUrls(
    content: string,
    r2Domain: string,
    token: string,
  ): string {
    // Escape special regex characters in domain
    const escapedDomain = r2Domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match URLs with the R2 domain
    // Pattern: https?://domain/path (with optional existing query params)
    const urlPattern = new RegExp(
      `(https?://${escapedDomain}/[^\\s"'\\)>]+?)(?=["'\\s>\\)])`,
      'gi',
    );

    return content.replace(urlPattern, (match) => {
      // Check if token already exists in the URL
      if (match.includes('token=')) {
        // Remove existing token parameter
        match = match.replace(/[?&]token=[^&"'\s)>]+/gi, '');
      }

      // Append new token
      const separator = match.includes('?') ? '&' : '?';
      return `${match}${separator}token=${token}`;
    });
  }

  /**
   * Check if content contains R2 image URLs
   * Useful for optimization to skip transformation when not needed
   */
  hasR2ImageUrls(content: string): boolean {
    const r2Domain = this.environmentService.getR2ImageDomain();
    if (!r2Domain || !content) {
      return false;
    }
    return content.includes(r2Domain);
  }
}

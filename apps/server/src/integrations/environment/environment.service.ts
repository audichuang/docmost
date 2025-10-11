import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ms, { StringValue } from 'ms';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class EnvironmentService {
  private projectRoot: string;

  constructor(private configService: ConfigService) {
    this.projectRoot = this.findProjectRoot();
  }

  private findProjectRoot(): string {
    let currentDir = __dirname;

    while (currentDir !== path.parse(currentDir).root) {
      const pkgPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.workspaces) {
            return currentDir;
          }
        } catch {
          // Ignore invalid package.json
        }
      }
      currentDir = path.dirname(currentDir);
    }

    // Fallback to process.cwd() if monorepo root not found
    return process.cwd();
  }

  getNodeEnv(): string {
    return this.configService.get<string>('NODE_ENV', 'development');
  }

  getAppUrl(): string {
    const rawUrl =
      this.configService.get<string>('APP_URL') ||
      `http://localhost:${this.getPort()}`;

    const { origin } = new URL(rawUrl);
    return origin;
  }

  isHttps(): boolean {
    const appUrl = this.configService.get<string>('APP_URL');
    try {
      const url = new URL(appUrl);
      return url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  }

  getSubdomainHost(): string {
    return this.configService.get<string>('SUBDOMAIN_HOST');
  }

  getPort(): number {
    return parseInt(this.configService.get<string>('PORT', '3000'));
  }

  getAppSecret(): string {
    return this.configService.get<string>('APP_SECRET');
  }

  getDatabaseURL(): string {
    return this.configService.get<string>('DATABASE_URL');
  }

  getDatabaseMaxPool(): number {
    return parseInt(this.configService.get<string>('DATABASE_MAX_POOL', '10'));
  }

  getRedisUrl(): string {
    return this.configService.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
  }

  getJwtTokenExpiresIn(): string {
    return this.configService.get<string>('JWT_TOKEN_EXPIRES_IN', '90d');
  }

  getCookieExpiresIn(): Date {
    const expiresInStr = this.getJwtTokenExpiresIn();
    let msUntilExpiry: number;
    try {
      msUntilExpiry = ms(expiresInStr as StringValue);
    } catch (err) {
      msUntilExpiry = ms('90d');
    }
    return new Date(Date.now() + msUntilExpiry);
  }

  getStorageDriver(): string {
    return this.configService.get<string>('STORAGE_DRIVER', 'local');
  }

  getFileUploadSizeLimit(): string {
    return this.configService.get<string>('FILE_UPLOAD_SIZE_LIMIT', '50mb');
  }

  getFileImportSizeLimit(): string {
    return this.configService.get<string>('FILE_IMPORT_SIZE_LIMIT', '200mb');
  }

  getAwsS3AccessKeyId(): string {
    return this.configService.get<string>('AWS_S3_ACCESS_KEY_ID');
  }

  getAwsS3SecretAccessKey(): string {
    return this.configService.get<string>('AWS_S3_SECRET_ACCESS_KEY');
  }

  getAwsS3Region(): string {
    return this.configService.get<string>('AWS_S3_REGION');
  }

  getAwsS3Bucket(): string {
    return this.configService.get<string>('AWS_S3_BUCKET');
  }

  getAwsS3Endpoint(): string {
    return this.configService.get<string>('AWS_S3_ENDPOINT');
  }

  getAwsS3ForcePathStyle(): boolean {
    return this.configService.get<boolean>('AWS_S3_FORCE_PATH_STYLE');
  }

  getAwsS3Url(): string {
    return this.configService.get<string>('AWS_S3_URL');
  }

  getMailDriver(): string {
    return this.configService.get<string>('MAIL_DRIVER', 'log');
  }

  getMailFromAddress(): string {
    return this.configService.get<string>('MAIL_FROM_ADDRESS');
  }

  getMailFromName(): string {
    return this.configService.get<string>('MAIL_FROM_NAME', 'Docmost');
  }

  getSmtpHost(): string {
    return this.configService.get<string>('SMTP_HOST');
  }

  getSmtpPort(): number {
    return parseInt(this.configService.get<string>('SMTP_PORT'));
  }

  getSmtpSecure(): boolean {
    const secure = this.configService
      .get<string>('SMTP_SECURE', 'false')
      .toLowerCase();
    return secure === 'true';
  }

  getSmtpIgnoreTLS(): boolean {
    const ignoretls = this.configService
      .get<string>('SMTP_IGNORETLS', 'false')
      .toLowerCase();
    return ignoretls === 'true';
  }

  getSmtpUsername(): string {
    return this.configService.get<string>('SMTP_USERNAME');
  }

  getSmtpPassword(): string {
    return this.configService.get<string>('SMTP_PASSWORD');
  }

  getPostmarkToken(): string {
    return this.configService.get<string>('POSTMARK_TOKEN');
  }

  getDrawioUrl(): string {
    return this.configService.get<string>('DRAWIO_URL');
  }

  isCloud(): boolean {
    const cloudConfig = this.configService
      .get<string>('CLOUD', 'false')
      .toLowerCase();
    return cloudConfig === 'true';
  }

  isSelfHosted(): boolean {
    return !this.isCloud();
  }

  getStripePublishableKey(): string {
    return this.configService.get<string>('STRIPE_PUBLISHABLE_KEY');
  }

  getStripeSecretKey(): string {
    return this.configService.get<string>('STRIPE_SECRET_KEY');
  }

  getStripeWebhookSecret(): string {
    return this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  getBillingTrialDays(): number {
    return parseInt(this.configService.get<string>('BILLING_TRIAL_DAYS', '14'));
  }

  getCollabUrl(): string {
    return this.configService.get<string>('COLLAB_URL');
  }

  isCollabDisableRedis(): boolean {
    const isStandalone = this.configService
      .get<string>('COLLAB_DISABLE_REDIS', 'false')
      .toLowerCase();
    return isStandalone === 'true';
  }

  isDisableTelemetry(): boolean {
    const disable = this.configService
      .get<string>('DISABLE_TELEMETRY', 'false')
      .toLowerCase();
    return disable === 'true';
  }

  getPostHogHost(): string {
    return this.configService.get<string>('POSTHOG_HOST');
  }

  getPostHogKey(): string {
    return this.configService.get<string>('POSTHOG_KEY');
  }

  // GitHub App integration
  getGithubAppId(): string {
    return this.configService.get<string>('GITHUB_APP_ID');
  }

  getGithubAppSlug(): string {
    return this.configService.get<string>('GITHUB_APP_SLUG');
  }

  getGithubClientId(): string {
    return this.configService.get<string>('GITHUB_APP_CLIENT_ID');
  }

  getGithubPrivateKey(): string {
    const keyPath = this.configService.get<string>(
      'GITHUB_APP_PRIVATE_KEY_PATH',
    );

    if (keyPath) {
      try {
        const absolutePath = path.isAbsolute(keyPath)
          ? keyPath
          : path.join(this.projectRoot, keyPath);

        if (fs.existsSync(absolutePath)) {
          return fs.readFileSync(absolutePath, 'utf8');
        }
      } catch (err) {
        console.error('Failed to read GitHub private key from file:', err);
      }
    }

    // Fallback to direct env var (legacy method)
    return this.configService.get<string>('GITHUB_APP_PRIVATE_KEY');
  }

  getGithubWebhookSecret(): string {
    return this.configService.get<string>('GITHUB_APP_WEBHOOK_SECRET');
  }

  getGithubApiBase(): string {
    return (
      this.configService.get<string>('GITHUB_API_BASE') ||
      'https://api.github.com'
    );
  }

  getGithubApiVersion(): string {
    return this.configService.get<string>('GITHUB_API_VERSION', '2022-11-28');
  }

  getGithubFetchRetries(): number {
    return parseInt(
      this.configService.get<string>('GITHUB_FETCH_RETRIES', '2'),
    );
  }

  getGithubFetchBackoffBaseMs(): number {
    return parseInt(
      this.configService.get<string>('GITHUB_FETCH_BACKOFF_BASE_MS', '500'),
    );
  }

  getGithubFetchTimeoutMs(): number {
    return parseInt(
      this.configService.get<string>('GITHUB_FETCH_TIMEOUT_MS', '15000'),
    );
  }

  // R2 Image Token Protection
  getR2ImageDomain(): string {
    return this.configService.get<string>('R2_IMAGE_DOMAIN');
  }

  getR2TokenSecret(): string {
    // Use APP_SECRET as fallback if R2_TOKEN_SECRET is not set
    return (
      this.configService.get<string>('R2_TOKEN_SECRET') || this.getAppSecret()
    );
  }

  getR2TokenValiditySeconds(): number {
    return parseInt(
      this.configService.get<string>('R2_TOKEN_VALIDITY_SECONDS', '300'),
    );
  }
}

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import { QueueJob, QueueName } from '../queue/constants';
import { EnvironmentService } from '../environment/environment.service';
import { GithubApiService } from './github-api.service';
import { GithubSyncService } from './github-sync.service';
import {
  CreateSourceDto,
  ListRefsQueryDto,
  ListReposQueryDto,
  UpdateSourceDto,
} from './github.dto';
import { signInstallState, verifyInstallState } from './github.utils';

export type InstallationOwnershipResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | 'installation_ownership_not_configured'
        | 'missing_oauth_code'
        | 'oauth_verification_failed'
        | 'installation_not_owned';
    };

/**
 * B1: pure decision at the heart of the callback fix — do we have proof the
 * calling user controls `installationId`? Kept side-effect free so every
 * branch (operator hasn't configured OAuth, GitHub sent no code, the token
 * exchange/listing failed, or the installation just isn't theirs) is a plain
 * unit test instead of something that needs a live GitHub API to exercise.
 */
export function evaluateInstallationOwnership(args: {
  clientSecretConfigured: boolean;
  code: string | null | undefined;
  installationId: string;
  userInstallationIds: string[] | null;
}): InstallationOwnershipResult {
  if (!args.clientSecretConfigured) {
    // refuse to link rather than silently trust a guessable installation_id
    return { ok: false, error: 'installation_ownership_not_configured' };
  }
  if (!args.code) {
    return { ok: false, error: 'missing_oauth_code' };
  }
  if (args.userInstallationIds === null) {
    return { ok: false, error: 'oauth_verification_failed' };
  }
  if (!args.userInstallationIds.includes(String(args.installationId))) {
    return { ok: false, error: 'installation_not_owned' };
  }
  return { ok: true };
}

export type FullSyncJobState =
  | 'waiting'
  | 'active'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children'
  | 'completed'
  | 'failed'
  | 'unknown';

export function fullSyncJobId(sourceId: string): string {
  return `github-full-sync-${sourceId}`;
}

/**
 * A6: whether an existing full-sync job for a source is still on its way to
 * running. While true, a fresh trigger (rescan click, another push falling
 * back to a full sync) should ride along with that job instead of queuing a
 * second scan of the same ref — running both is exactly what lets a scan
 * write stale content after a newer push already synced it.
 */
export function isFullSyncInFlight(state: FullSyncJobState): boolean {
  return state !== 'completed' && state !== 'failed' && state !== 'unknown';
}

@UseGuards(JwtAuthGuard)
@Controller('integrations/github')
export class GithubController {
  constructor(
    private readonly githubApi: GithubApiService,
    private readonly sync: GithubSyncService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly env: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.GITHUB_QUEUE) private readonly githubQueue: Queue,
  ) {}

  @Get('config')
  config() {
    return { configured: this.githubApi.isConfigured() };
  }

  // ------------------------------------------------------- installations

  @Get('installations')
  async listInstallations(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    this.assertWorkspaceAdmin(user, workspace);

    return this.db
      .selectFrom('githubInstallations')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  @HttpCode(200)
  @Post('installations/sync')
  async syncInstallations(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    this.assertWorkspaceAdmin(user, workspace);
    return this.githubApi.syncInstallationsFromGitHub(workspace.id);
  }

  @Get('installations/auth-url')
  async getAuthUrl(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    this.assertWorkspaceAdmin(user, workspace);

    const appSlug = this.env.getGithubAppSlug();
    if (!appSlug) throw new NotFoundException('github_app_not_configured');

    const state = signInstallState(workspace.id, this.env.getAppSecret());

    return {
      url: `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`,
    };
  }

  @Public()
  @SkipTransform()
  @Get('callback')
  async handleCallback(
    @Query('installation_id') installationId: string,
    @Query('state') state: string,
    @Query('code') code: string,
    @Res() res: FastifyReply,
  ) {
    const settingsUrl = `${this.env.getAppUrl()}/settings/integrations/github`;
    const fail = (errorCode: string) =>
      res.status(302).redirect(`${settingsUrl}?error=${errorCode}`);

    if (!installationId || !state) return fail('missing_params');

    // an unsigned state would let anyone link their own installation into
    // someone else's workspace through this public endpoint
    const verified = verifyInstallState(state, this.env.getAppSecret());
    if (!verified) return fail('invalid_state');
    const { workspaceId } = verified;

    // B1: a signed state only proves *we* started this flow for this
    // workspace — it says nothing about who controls the numeric
    // installation_id GitHub handed back, and that id is guessable. Without
    // this check, an attacker can request their own valid state, then replay
    // the callback with a victim's installation_id and bind it to their own
    // workspace. Require proof, via the installing user's own OAuth token,
    // that they can actually see this installation before we ever link it.
    const clientSecretConfigured = Boolean(this.env.getGithubAppClientSecret());
    let userInstallationIds: string[] | null = null;
    if (clientSecretConfigured && code) {
      const userToken = await this.exchangeUserCode(code);
      userInstallationIds = userToken
        ? await this.listUserInstallationIds(userToken)
        : null;
    }

    const ownership = evaluateInstallationOwnership({
      clientSecretConfigured,
      code,
      installationId,
      userInstallationIds,
    });
    // `ownership.ok === false` (not `!ownership.ok`) — this repo builds with
    // strictNullChecks off, under which TS won't narrow a discriminated
    // union through a negated boolean check, only an explicit comparison
    if (ownership.ok === false) return fail(ownership.error);

    const info = await this.githubApi.getInstallationInfo(installationId);
    if (!info?.account?.login || !info?.account?.type) {
      return fail('installation_not_found');
    }

    await this.sync.linkInstallation(workspaceId, {
      installationId: String(info.id),
      accountLogin: info.account.login,
      accountType: info.account.type,
      appId: String(info.app_id ?? this.env.getGithubAppId()),
    });

    return res.status(302).redirect(`${settingsUrl}?success=true`);
  }

  /**
   * User-to-server OAuth (distinct from the app-level JWT installation
   * tokens GithubApiService mints) — this is what lets us ask GitHub which
   * installations the *human on the other end* can actually see.
   * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
   */
  private async exchangeUserCode(code: string): Promise<string | null> {
    const clientId = this.env.getGithubAppClientId();
    const clientSecret = this.env.getGithubAppClientSecret();
    if (!clientId || !clientSecret) return null;

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json', // GitHub form-encodes the response otherwise
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    if (!res.ok) return null;

    const json = await res.json().catch(() => null);
    return typeof json?.access_token === 'string' ? json.access_token : null;
  }

  /**
   * https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
   */
  private async listUserInstallationIds(userToken: string): Promise<string[] | null> {
    const ids: string[] = [];

    for (let page = 1; page <= 5; page++) {
      const res = await fetch(
        `${this.env.getGithubApiBase()}/user/installations?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': this.env.getGithubApiVersion(),
          },
        },
      );
      if (!res.ok) return null;

      const json = await res.json().catch(() => null);
      if (!Array.isArray(json?.installations)) return null;

      ids.push(...json.installations.map((i: any) => String(i.id)));
      if (json.installations.length < 100) break;
    }

    return ids;
  }

  @Delete('installations/:id')
  async deleteInstallation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    this.assertWorkspaceAdmin(user, workspace);

    await this.db
      .deleteFrom('githubInstallations')
      .where('id', '=', id)
      .where('workspaceId', '=', workspace.id)
      .execute();
    return { ok: true };
  }

  // --------------------------------------------------------------- repos

  @Get('repos')
  async listRepos(
    @Query() q: ListReposQueryDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertInstallation(q.githubInstallationId, workspace.id);
    return this.githubApi.listRepos(q.githubInstallationId);
  }

  @Get('refs')
  async listRefs(
    @Query() q: ListRefsQueryDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.assertInstallation(q.githubInstallationId, workspace.id);
    return this.githubApi.listRefs(q.githubInstallationId, q.owner, q.repo);
  }

  // ------------------------------------------------------------- sources

  @Get('sources')
  async listSources(@AuthWorkspace() workspace: Workspace) {
    return this.sync.listSources(workspace.id);
  }

  @Post('sources')
  async createSource(
    @Body() dto: CreateSourceDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    await this.assertCanEditSpace(user, dto.spaceId);
    await this.assertCanMountUnder(user, dto.rootPageId, dto.spaceId);

    const source = await this.sync.createSource(workspace.id, user.id, dto);
    const job = await this.enqueueFullSync(source.id, false);

    return { source, jobId: job.id };
  }

  @HttpCode(200)
  @Post('sources/:id/rescan')
  async rescan(
    @Param('id', new ParseUUIDPipe()) sourceId: string,
    @Query('force') force: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    const source = await this.assertSourceAccess(sourceId, workspace.id, user);
    const job = await this.enqueueFullSync(
      source.id,
      force === '1' || force === 'true',
    );

    return { jobId: job.id };
  }

  /**
   * A6: a deterministic per-source jobId coalesces redundant triggers (rapid
   * rescan clicks, a rescan racing an in-flight sync) into the single job
   * already headed toward the current ref, instead of running each one and
   * letting an older scan's write land after a newer one's. Once that job
   * has actually finished, the id is free again for a fresh scan.
   */
  private async enqueueFullSync(sourceId: string, force: boolean) {
    const jobId = fullSyncJobId(sourceId);
    const existing = await this.githubQueue.getJob(jobId);

    if (existing) {
      const state = (await existing.getState()) as FullSyncJobState;
      if (isFullSyncInFlight(state)) return existing;
      await existing.remove().catch(() => undefined);
    }

    return this.githubQueue.add(
      QueueJob.GITHUB_FULL_SYNC,
      { sourceId, force },
      { jobId },
    );
  }

  /** Sync progress lives on the BullMQ job, so any node can serve this. */
  @Get('sources/jobs/:jobId')
  async jobStatus(
    @Param('jobId') jobId: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const job = await this.githubQueue.getJob(jobId);
    if (!job) return { state: 'unknown', progress: null };

    // job ids are guessable, so never expose another tenant's repo paths
    const source = await this.db
      .selectFrom('githubSources')
      .select(['id'])
      .where('id', '=', job.data?.sourceId ?? '')
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();

    if (!source) return { state: 'unknown', progress: null };

    return {
      state: await job.getState(),
      progress: job.progress ?? null,
      failedReason: job.failedReason ?? null,
    };
  }

  @Patch('sources/:id')
  async updateSource(
    @Param('id', new ParseUUIDPipe()) sourceId: string,
    @Body() dto: UpdateSourceDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    await this.assertSourceAccess(sourceId, workspace.id, user);
    const changed = await this.sync.updateSourceActive(
      workspace.id,
      sourceId,
      dto.active,
    );
    return { ok: true, changed };
  }

  @Delete('sources/:id')
  async deleteSource(
    @Param('id', new ParseUUIDPipe()) sourceId: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    await this.assertSourceAccess(sourceId, workspace.id, user);
    await this.sync.deleteSource(workspace.id, sourceId);
    return { ok: true };
  }

  // ------------------------------------------------------------- guards

  /** Connecting or removing a GitHub account is a workspace-level setting. */
  private assertWorkspaceAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  private async assertInstallation(installationId: string, workspaceId: string) {
    const row = await this.db
      .selectFrom('githubInstallations')
      .select(['id'])
      .where('id', '=', installationId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (!row) throw new NotFoundException('github_installation_not_found');
  }

  private async assertCanEditSpace(user: User, spaceId: string) {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  /**
   * A repo-root README is written straight onto the mount page, so mounting
   * requires edit rights on that page — space-level rights are not enough
   * when the page carries its own restrictions.
   */
  private async assertCanMountUnder(
    user: User,
    rootPageId: string | undefined,
    spaceId: string,
  ) {
    if (!rootPageId) return;

    const page = await this.pageRepo.findById(rootPageId);
    if (!page || page.deletedAt || page.spaceId !== spaceId) {
      throw new NotFoundException('root_page_not_found');
    }

    const { hasAnyRestriction, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, rootPageId);

    if (hasAnyRestriction && !canEdit) throw new ForbiddenException();
  }

  private async assertSourceAccess(
    sourceId: string,
    workspaceId: string,
    user: User,
  ) {
    const source = await this.db
      .selectFrom('githubSources')
      .select(['id', 'spaceId'])
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();

    if (!source) throw new NotFoundException('github_source_not_found');
    await this.assertCanEditSpace(user, source.spaceId);
    return source;
  }
}

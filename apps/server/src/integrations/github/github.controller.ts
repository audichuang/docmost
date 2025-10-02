import { Body, Controller, Get, Post, Query, UseGuards, Param, HttpCode, ParseUUIDPipe, ForbiddenException, Patch, Delete, Res, Req, Sse } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, map } from 'rxjs';
import { GithubService } from './github.service';
import { GithubSyncService } from './github.sync.service';
import { GithubSyncProgressService } from './github-sync-progress.service';
import { CreateSourceDto, ListReposQueryDto, UpdateSourceDto, LinkInstallationDto } from './github.types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../core/casl/interfaces/space-ability.type';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EnvironmentService } from '../environment/environment.service';

@UseGuards(JwtAuthGuard)
@Controller('integrations/github')
export class GithubController {
  constructor(
    private readonly gh: GithubService,
    private readonly sync: GithubSyncService,
    private readonly progress: GithubSyncProgressService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly env: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  @Get('installations')
  async listInstallations(@AuthWorkspace() workspace: Workspace) {
    return this.gh.listInstallations(workspace.id);
  }

  @HttpCode(200)
  @Post('installations/sync')
  async syncInstallations(@AuthWorkspace() workspace: Workspace) {
    return this.gh.syncInstallationsFromGitHub(workspace.id);
  }

  @Get('installations/auth-url')
  async getAuthUrl(@AuthWorkspace() workspace: Workspace, @Req() req: FastifyRequest) {
    const appSlug = this.env.getGithubAppSlug();
    const callbackUrl = `${this.env.getAppUrl()}/api/integrations/github/callback`;

    // Store workspace ID in session or use state parameter
    const state = Buffer.from(JSON.stringify({
      workspaceId: workspace.id
    })).toString('base64');

    // Use GitHub App installation flow
    // User will be redirected to choose which account to install on
    const authUrl = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;

    return { url: authUrl };
  }

  @Public()
  @SkipTransform()
  @Get('callback')
  async handleCallback(
    @Query('installation_id') installationId: string,
    @Query('setup_action') setupAction: string,
    @Query('state') state: string,
    @Res() res: FastifyReply,
  ) {
    const frontendUrl = this.env.getAppUrl();

    try {
      if (!installationId || !state) {
        console.error('GitHub callback missing params:', { installationId, state });
        return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?error=missing_params`);
      }

      // Decode workspace ID from state
      let workspaceId: string;
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
        workspaceId = decoded.workspaceId;
      } catch (err) {
        console.error('Failed to decode state:', err);
        return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?error=invalid_state`);
      }

      if (!workspaceId) {
        return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?error=invalid_state`);
      }

      // Get installation info from GitHub
      const installationInfo = await this.gh.getInstallationInfo(installationId);
      console.log('Installation info from GitHub:', installationInfo?.json);

      if (!installationInfo?.json || !installationInfo.json.account) {
        console.error('Installation info invalid:', installationInfo);
        return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?error=installation_not_found`);
      }

      const accountLogin = installationInfo.json.account.login;
      const accountType = installationInfo.json.account.type;

      if (!accountLogin || !accountType) {
        console.error('Installation account info missing:', { accountLogin, accountType });
        return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?error=installation_not_found`);
      }

      // Link installation to workspace
      await this.sync.linkInstallation(workspaceId, {
        installationId: String(installationInfo.json.id),
        accountLogin,
        accountType,
      });

      console.log(`Successfully linked installation ${installationId} to workspace ${workspaceId}`);
      return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?success=true`);
    } catch (err) {
      console.error('GitHub OAuth callback error:', err);
      return res.status(302).redirect(`${frontendUrl}/settings/integrations/github?error=server_error`);
    }
  }

  @Delete('installations/:id')
  async deleteInstallation(
    @Param('id', new ParseUUIDPipe()) installationId: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.db
      .deleteFrom('githubInstallations')
      .where('id', '=', installationId)
      .where('workspaceId', '=', workspace.id)
      .execute();
    return { ok: true };
  }

  @Post('installations/link')
  async linkInstallation(
    @Body() dto: LinkInstallationDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.sync.linkInstallation(workspace.id, dto);
  }

  @Get('repos')
  async listRepos(@Query() q: ListReposQueryDto, @AuthWorkspace() workspace: Workspace) {
    return this.gh.listRepos(workspace.id, q.githubInstallationId);
  }

  @Get('refs')
  async listRefs(
    @Query('githubInstallationId') githubInstallationId: string,
    @Query('owner') owner: string,
    @Query('repo') repo: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.gh.listRefs(workspace.id, githubInstallationId, owner, repo);
  }

  @Post('sources')
  async createSource(
    @Body() dto: CreateSourceDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    const ability = await this.spaceAbility.createForUser(user, dto.spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
    // Generate a unique job ID for progress tracking
    const jobId = `sync-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Start sync in background and return jobId immediately
    setImmediate(() => {
      this.sync.createSourceAndStartFullSync(workspace.id, dto, jobId);
    });

    return { jobId };
  }

  @Sse('sources/progress/:jobId')
  syncProgress(@Param('jobId') jobId: string): Observable<any> {
    return this.progress.getProgressStream(jobId).pipe(
      map((event) => ({ data: event })),
    );
  }

  @Get('sources')
  async listSources(@AuthWorkspace() workspace: Workspace) {
    return this.sync.listSources(workspace.id);
  }

  @HttpCode(200)
  @Post('sources/:id/rescan')
  async rescan(
    @Param('id', new ParseUUIDPipe()) sourceId: string,
    @Query('force') force: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    // Load the source to check space access
    const src = await this.db
      .selectFrom('githubSources')
      .select(['spaceId'])
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (src) {
      const ability = await this.spaceAbility.createForUser(user, src.spaceId);
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }
    await this.sync.fullSync(workspace.id, sourceId, { force: force === '1' || force === 'true' });
    return { ok: true };
  }

  @Patch('sources/:id')
  async updateSource(
    @Param('id', new ParseUUIDPipe()) sourceId: string,
    @Body() dto: UpdateSourceDto,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    const src = await this.db
      .selectFrom('githubSources')
      .select(['spaceId'])
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (src) {
      const ability = await this.spaceAbility.createForUser(user, src.spaceId);
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }
    const changed = await this.sync.updateSourceActive(workspace.id, sourceId, dto.active);
    return { ok: true, changed };
  }

  @Delete('sources/:id')
  async deleteSource(
    @Param('id', new ParseUUIDPipe()) sourceId: string,
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
  ) {
    const src = await this.db
      .selectFrom('githubSources')
      .select(['spaceId'])
      .where('id', '=', sourceId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
    if (src) {
      const ability = await this.spaceAbility.createForUser(user, src.spaceId);
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }
    await this.sync.deleteSource(workspace.id, sourceId);
    return { ok: true };
  }
}

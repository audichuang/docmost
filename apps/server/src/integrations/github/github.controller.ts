import { Body, Controller, Get, Post, Query, UseGuards, Param, HttpCode, ParseUUIDPipe, ForbiddenException, Patch, Delete } from '@nestjs/common';
import { GithubService } from './github.service';
import { GithubSyncService } from './github.sync.service';
import { CreateSourceDto, ListReposQueryDto, UpdateSourceDto, LinkInstallationDto } from './github.types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { SpaceCaslAction, SpaceCaslSubject } from '../../core/casl/interfaces/space-ability.type';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@UseGuards(JwtAuthGuard)
@Controller('integrations/github')
export class GithubController {
  constructor(
    private readonly gh: GithubService,
    private readonly sync: GithubSyncService,
    private readonly spaceAbility: SpaceAbilityFactory,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  @Get('installations')
  async listInstallations(@AuthWorkspace() workspace: Workspace) {
    return this.gh.listInstallations(workspace.id);
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
    // TODO: persist into github_sources and enqueue full sync
    return this.sync.createSourceAndStartFullSync(workspace.id, dto);
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

import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateSourceDto {
  @IsUUID()
  githubInstallationId: string;

  @IsString()
  owner: string;

  @IsString()
  repo: string;

  /** branch, tag or sha */
  @IsString()
  ref: string;

  /** only sync this subdirectory of the repo */
  @IsString()
  @IsOptional()
  rootDir?: string;

  @IsUUID()
  spaceId: string;

  /** mount the synced tree under this page instead of the space root */
  @IsUUID()
  @IsOptional()
  rootPageId?: string;
}

export class UpdateSourceDto {
  @IsBoolean()
  active: boolean;
}

export class ListReposQueryDto {
  @IsUUID()
  githubInstallationId: string;
}

export class ListRefsQueryDto {
  @IsUUID()
  githubInstallationId: string;

  @IsString()
  owner: string;

  @IsString()
  repo: string;
}

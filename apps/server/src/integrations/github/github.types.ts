import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateSourceDto {
  @IsUUID()
  githubInstallationId: string;

  @IsString()
  owner: string;

  @IsString()
  repo: string;

  @IsString()
  ref: string; // branch/tag/sha

  @IsString()
  @IsOptional()
  rootDir?: string;

  @IsString()
  @IsOptional()
  targetPath?: string;

  @IsUUID()
  spaceId: string;

  @IsUUID()
  @IsOptional()
  rootPageId?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class ListReposQueryDto {
  @IsUUID()
  githubInstallationId: string;
}

export type GithubCompareFile = {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  previous_filename?: string;
};

export class UpdateSourceDto {
  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class LinkInstallationDto {
  @IsString()
  installationId: string; // numeric string from GitHub

  @IsString()
  accountLogin: string; // user/org login

  @IsString()
  accountType: 'User' | 'Organization';
}

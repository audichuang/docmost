import { IsBoolean, IsOptional, IsUUID, Matches } from 'class-validator';

// GitHub's own naming rules. These values are interpolated into API URL paths,
// where a slash would let a crafted value escape to a different endpoint, so
// they are constrained at the trust boundary rather than escaped downstream.
export const GITHUB_OWNER_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// '.' and '..' are URL dot-segments and would be normalised out of the path
export const GITHUB_REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
// Git allows almost anything in a ref; only traversal and the characters
// git itself forbids are excluded, so branches like 'release/v1.2+hotfix' or
// non-ASCII names still work. The value is percent-encoded before use.
export const GITHUB_REF_RE =
  /^(?!.*\.\.)(?!\/)(?!.*\/$)[^\s~^:?*\[\]\\]{1,255}$/;
// matched against repo paths only, never sent to GitHub — the one thing
// that must not get through is traversal
export const REPO_SUBDIR_RE = /^(?!.*\.\.)[^\s\\]{0,255}$|^$/;

export class CreateSourceDto {
  @IsUUID()
  githubInstallationId: string;

  @Matches(GITHUB_OWNER_RE, { message: 'invalid github owner' })
  owner: string;

  @Matches(GITHUB_REPO_RE, { message: 'invalid github repo' })
  repo: string;

  /** branch, tag or sha */
  @Matches(GITHUB_REF_RE, { message: 'invalid git ref' })
  ref: string;

  /** only sync this subdirectory of the repo */
  @IsOptional()
  @Matches(REPO_SUBDIR_RE, { message: 'invalid subdirectory' })
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

  @Matches(GITHUB_OWNER_RE, { message: 'invalid github owner' })
  owner: string;

  @Matches(GITHUB_REPO_RE, { message: 'invalid github repo' })
  repo: string;
}

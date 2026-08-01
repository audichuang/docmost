export interface IGithubInstallation {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  createdAt: string;
}

export interface IGithubRepo {
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface IGithubRef {
  name: string;
  type: "branch" | "tag";
}

export interface IGithubSource {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  rootDir: string;
  spaceId: string;
  spaceName: string;
  accountLogin: string;
  active: boolean;
  lastFullScanSha: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface ICreateGithubSource {
  githubInstallationId: string;
  owner: string;
  repo: string;
  ref: string;
  rootDir?: string;
  spaceId: string;
  rootPageId?: string;
}

export interface IGithubSyncJob {
  state: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown";
  progress: {
    phase?: string;
    current?: number;
    total?: number;
    truncated?: boolean;
  } | null;
  failedReason: string | null;
}

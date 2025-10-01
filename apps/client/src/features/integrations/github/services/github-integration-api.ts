import api from '@/lib/api-client';

export type GithubInstallation = {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  createdAt: string;
};

export type GithubSource = {
  id: string;
  spaceId: string;
  owner: string;
  repo: string;
  ref: string;
  rootDir: string;
  rootPageId?: string | null;
  active: boolean;
  updatedAt: string;
  lastEventOk?: boolean | null;
  lastEventProcessedAt?: string | null;
};

export async function listInstallations(): Promise<GithubInstallation[]> {
  const req = await api.get('/integrations/github/installations');
  return req.data;
}

export async function listRepos(githubInstallationId: string): Promise<{ total_count: number; repositories: any[] }> {
  const req = await api.get('/integrations/github/repos', { params: { githubInstallationId } });
  return req.data;
}

export async function listSources(): Promise<GithubSource[]> {
  const req = await api.get('/integrations/github/sources');
  return req.data;
}

export async function createSource(payload: {
  githubInstallationId: string;
  owner: string;
  repo: string;
  ref: string;
  rootDir?: string;
  spaceId: string;
  rootPageId?: string;
  active?: boolean;
}) {
  const req = await api.post('/integrations/github/sources', payload);
  return req.data;
}

export async function rescanSource(id: string, opts?: { force?: boolean }) {
  const params = opts?.force ? { force: '1' } : undefined;
  const req = await api.post(`/integrations/github/sources/${id}/rescan`, undefined, { params });
  return req.data;
}

export async function patchSourceActive(id: string, active: boolean) {
  const req = await api.patch(`/integrations/github/sources/${id}`, { active });
  return req.data;
}

export async function deleteSourceApi(id: string) {
  const req = await api.delete(`/integrations/github/sources/${id}`);
  return req.data;
}

export async function listRefs(params: { githubInstallationId: string; owner: string; repo: string }): Promise<{ items: { name: string; type: 'branch' | 'tag' }[] }> {
  const req = await api.get('/integrations/github/refs', { params });
  return req.data;
}

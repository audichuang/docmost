import api from "@/lib/api-client";
import {
  ICreateGithubSource,
  IGithubInstallation,
  IGithubRef,
  IGithubRepo,
  IGithubSource,
  IGithubSyncJob,
} from "@/features/integrations/github/types/github.types.ts";

const BASE = "/integrations/github";

export async function getGithubConfig(): Promise<{ configured: boolean }> {
  const req = await api.get(`${BASE}/config`);
  return req.data;
}

export async function getInstallations(): Promise<IGithubInstallation[]> {
  const req = await api.get(`${BASE}/installations`);
  return req.data;
}

export async function refreshInstallations(): Promise<IGithubInstallation[]> {
  const req = await api.post(`${BASE}/installations/sync`);
  return req.data;
}

export async function getInstallAuthUrl(): Promise<{ url: string }> {
  const req = await api.get(`${BASE}/installations/auth-url`);
  return req.data;
}

export async function deleteInstallation(id: string): Promise<void> {
  await api.delete(`${BASE}/installations/${id}`);
}

export async function getRepos(
  githubInstallationId: string,
): Promise<IGithubRepo[]> {
  const req = await api.get(`${BASE}/repos`, {
    params: { githubInstallationId },
  });
  return req.data;
}

export async function getRefs(
  githubInstallationId: string,
  owner: string,
  repo: string,
): Promise<IGithubRef[]> {
  const req = await api.get(`${BASE}/refs`, {
    params: { githubInstallationId, owner, repo },
  });
  return req.data;
}

export async function getSources(): Promise<IGithubSource[]> {
  const req = await api.get(`${BASE}/sources`);
  return req.data;
}

export async function createSource(
  data: ICreateGithubSource,
): Promise<{ source: IGithubSource; jobId: string }> {
  const req = await api.post(`${BASE}/sources`, data);
  return req.data;
}

export async function rescanSource(
  sourceId: string,
  force = false,
): Promise<{ jobId: string }> {
  const req = await api.post(
    `${BASE}/sources/${sourceId}/rescan`,
    {},
    { params: force ? { force: "1" } : {} },
  );
  return req.data;
}

export async function updateSource(
  sourceId: string,
  active: boolean,
): Promise<void> {
  await api.patch(`${BASE}/sources/${sourceId}`, { active });
}

export async function deleteSource(sourceId: string): Promise<void> {
  await api.delete(`${BASE}/sources/${sourceId}`);
}

export async function getSyncJob(jobId: string): Promise<IGithubSyncJob> {
  const req = await api.get(`${BASE}/sources/jobs/${jobId}`);
  return req.data;
}

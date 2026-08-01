import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  createSource,
  deleteInstallation,
  deleteSource,
  getGithubConfig,
  getInstallations,
  getRefs,
  getRepos,
  getSources,
  getSyncJob,
  refreshInstallations,
  rescanSource,
  updateSource,
} from "@/features/integrations/github/services/github-service.ts";
import {
  ICreateGithubSource,
  IGithubInstallation,
  IGithubRef,
  IGithubRepo,
  IGithubSource,
  IGithubSyncJob,
} from "@/features/integrations/github/types/github.types.ts";

const SOURCES_KEY = ["github-sources"];
const INSTALLATIONS_KEY = ["github-installations"];

export function useGithubConfigQuery(): UseQueryResult<
  { configured: boolean },
  Error
> {
  return useQuery({
    queryKey: ["github-config"],
    queryFn: getGithubConfig,
    staleTime: 5 * 60 * 1000,
  });
}

export function useGithubInstallationsQuery(): UseQueryResult<
  IGithubInstallation[],
  Error
> {
  return useQuery({ queryKey: INSTALLATIONS_KEY, queryFn: getInstallations });
}

export function useGithubReposQuery(
  installationId: string | null,
): UseQueryResult<IGithubRepo[], Error> {
  return useQuery({
    queryKey: ["github-repos", installationId],
    queryFn: () => getRepos(installationId),
    enabled: Boolean(installationId),
  });
}

export function useGithubRefsQuery(
  installationId: string | null,
  owner: string | null,
  repo: string | null,
): UseQueryResult<IGithubRef[], Error> {
  return useQuery({
    queryKey: ["github-refs", installationId, owner, repo],
    queryFn: () => getRefs(installationId, owner, repo),
    enabled: Boolean(installationId && owner && repo),
  });
}

export function useGithubSourcesQuery(): UseQueryResult<IGithubSource[], Error> {
  return useQuery({ queryKey: SOURCES_KEY, queryFn: getSources });
}

/**
 * Progress lives on the BullMQ job, so this polls rather than holding a stream
 * open — a sync started on one node stays readable from any other.
 */
export function useGithubSyncJobQuery(
  jobId: string | null,
): UseQueryResult<IGithubSyncJob, Error> {
  return useQuery({
    queryKey: ["github-sync-job", jobId],
    queryFn: () => getSyncJob(jobId),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed" ? false : 1500;
    },
  });
}

export function useRefreshInstallationsMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: refreshInstallations,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INSTALLATIONS_KEY });
    },
    onError: (err: Error) => {
      notifications.show({
        message: err.message || t("Failed to refresh installations"),
        color: "red",
      });
    },
  });
}

export function useDeleteInstallationMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteInstallation,
    onSuccess: () => {
      notifications.show({ message: t("GitHub installation disconnected") });
      queryClient.invalidateQueries({ queryKey: INSTALLATIONS_KEY });
      queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

export function useCreateGithubSourceMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: ICreateGithubSource) => createSource(data),
    onSuccess: () => {
      notifications.show({ message: t("Sync started") });
      queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
    onError: (err: Error) => {
      notifications.show({
        message: err.message || t("Failed to create source"),
        color: "red",
      });
    },
  });
}

export function useRescanSourceMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sourceId, force }: { sourceId: string; force?: boolean }) =>
      rescanSource(sourceId, force),
    onSuccess: () => {
      notifications.show({ message: t("Sync started") });
      queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

export function useUpdateGithubSourceMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sourceId, active }: { sourceId: string; active: boolean }) =>
      updateSource(sourceId, active),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

export function useDeleteGithubSourceMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteSource,
    onSuccess: () => {
      notifications.show({ message: t("Source removed") });
      queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
}

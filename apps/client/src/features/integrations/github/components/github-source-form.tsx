import { useState } from "react";
import { Button, Card, Group, Select, Text, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import {
  useCreateGithubSourceMutation,
  useGithubInstallationsQuery,
  useGithubRefsQuery,
  useGithubReposQuery,
} from "@/features/integrations/github/queries/github-query.ts";
import { useGetSpacesQuery } from "@/features/space/queries/space-query.ts";

type Props = {
  onSyncStarted: (jobId: string) => void;
};

export default function GithubSourceForm({ onSyncStarted }: Props) {
  const { t } = useTranslation();

  const [installationId, setInstallationId] = useState<string | null>(null);
  const [repoKey, setRepoKey] = useState<string | null>(null);
  const [gitRef, setGitRef] = useState<string | null>(null);
  const [rootDir, setRootDir] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(null);

  const { data: installations } = useGithubInstallationsQuery();
  const { data: repos, isLoading: reposLoading } =
    useGithubReposQuery(installationId);
  const [owner, repo] = repoKey?.split("/") ?? [null, null];
  const { data: refs, isLoading: refsLoading } = useGithubRefsQuery(
    installationId,
    owner,
    repo,
  );
  const { data: spaces } = useGetSpacesQuery({ limit: 100 });
  const createMutation = useCreateGithubSourceMutation();

  const canSubmit = installationId && owner && repo && gitRef && spaceId;

  const submit = async () => {
    if (!canSubmit) return;
    const result = await createMutation.mutateAsync({
      githubInstallationId: installationId,
      owner,
      repo,
      ref: gitRef,
      rootDir: rootDir.trim() || undefined,
      spaceId,
    });
    onSyncStarted(result.jobId);
    setRepoKey(null);
    setGitRef(null);
    setRootDir("");
  };

  return (
    <Card withBorder radius="md" p="md">
      <Text fw={500} mb="sm">
        {t("Add a sync source")}
      </Text>

      <Select
        label={t("GitHub account")}
        placeholder={t("Select an account")}
        data={(installations ?? []).map((i) => ({
          value: i.id,
          label: i.accountLogin,
        }))}
        value={installationId}
        onChange={(value) => {
          setInstallationId(value);
          setRepoKey(null);
          setGitRef(null);
        }}
        mb="sm"
        searchable
      />

      <Select
        label={t("Repository")}
        placeholder={
          reposLoading ? t("Loading...") : t("Select a repository")
        }
        data={(repos ?? []).map((r) => ({
          value: `${r.owner}/${r.repo}`,
          label: r.fullName,
        }))}
        value={repoKey}
        onChange={(value) => {
          setRepoKey(value);
          setGitRef(null);
        }}
        disabled={!installationId}
        mb="sm"
        searchable
      />

      <Select
        label={t("Branch or tag")}
        placeholder={refsLoading ? t("Loading...") : t("Select a ref")}
        data={(refs ?? []).map((r) => ({
          value: r.name,
          label: r.type === "tag" ? `${r.name} (tag)` : r.name,
        }))}
        value={gitRef}
        onChange={(value) => setGitRef(value as string)}
        disabled={!repoKey}
        mb="sm"
        searchable
      />

      <TextInput
        label={t("Subdirectory")}
        description={t("Optional. Only sync files under this path, e.g. docs")}
        placeholder="docs"
        value={rootDir}
        onChange={(e) => setRootDir(e.currentTarget.value)}
        mb="sm"
      />

      <Select
        label={t("Target space")}
        placeholder={t("Select a space")}
        data={(spaces?.items ?? []).map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        value={spaceId}
        onChange={(value) => setSpaceId(value as string)}
        mb="md"
        searchable
      />

      <Group justify="flex-end">
        <Button
          onClick={submit}
          disabled={!canSubmit}
          loading={createMutation.isPending}
        >
          {t("Create source and sync")}
        </Button>
      </Group>
    </Card>
  );
}

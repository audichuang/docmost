import { useEffect, useState } from "react";
import {
  Group,
  Select,
  SelectProps,
  TextInput,
  Button,
  Stack,
  Text,
} from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import {
  listRepos,
  createSource,
  listRefs,
} from "../services/github-integration-api";
import SyncProgressModal from "./SyncProgressModal";

export default function RepoSelector({
  installations,
  spaces,
  onCreated,
}: {
  installations: { id: string; accountLogin: string }[];
  spaces: { id: string; name: string }[];
  onCreated?: () => void;
}) {
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [repos, setRepos] = useState<
    { full_name: string; default_branch: string }[]
  >([]);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [refOptions, setRefOptions] = useState<
    { name: string; type: "branch" | "tag" }[]
  >([]);
  const [rootDir, setRootDir] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [creating, setCreating] = useState(false);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [progressModalOpened, setProgressModalOpened] = useState(false);

  const renderRepoOption: SelectProps["renderOption"] = ({ option }) => (
    <Group gap="sm" wrap="nowrap">
      <IconBrandGithub size={18} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" lineClamp={1}>
          {option.value.split("/")[1]}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {option.value.split("/")[0]}
        </Text>
      </div>
    </Group>
  );

  useEffect(() => {
    (async () => {
      if (!installationId) return;
      setLoadingRepos(true);
      try {
        const res = await listRepos(installationId);
        setRepos(
          res?.repositories?.map((r: any) => ({
            full_name: r.full_name,
            default_branch: r.default_branch,
          })) || [],
        );
      } finally {
        setLoadingRepos(false);
      }
    })();
  }, [installationId]);

  const onSelectRepo = (fullName: string) => {
    const [o, r] = fullName.split("/");
    setOwner(o);
    setRepo(r);
    const d = repos.find((x) => x.full_name === fullName)?.default_branch || "";
    setRef(d);
    // Load branches/tags for autocomplete
    if (installationId && o && r) {
      listRefs({ githubInstallationId: installationId, owner: o, repo: r })
        .then((res) => {
          const items = (res?.items || []) as {
            name: string;
            type: "branch" | "tag";
          }[];
          setRefOptions(items);
        })
        .catch(() => setRefOptions([]));
    }
  };

  const onCreate = async () => {
    if (!installationId || !owner || !repo || !ref || !spaceId) return;
    setCreating(true);
    try {
      const result = await createSource({
        githubInstallationId: installationId,
        owner,
        repo,
        ref,
        rootDir: rootDir || "",
        targetPath: targetPath || "",
        spaceId,
      });

      console.log("[RepoSelector] Got jobId:", result.jobId);

      // Open progress modal with jobId
      setSyncJobId(result.jobId);
      setProgressModalOpened(true);

      console.log("[RepoSelector] Modal opened with jobId:", result.jobId);
    } catch (err) {
      console.error("[RepoSelector] Create source failed:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleProgressModalClose = () => {
    setProgressModalOpened(false);
    setSyncJobId(null);
    onCreated?.();
  };

  return (
    <>
      <SyncProgressModal
        opened={progressModalOpened}
        onClose={handleProgressModalClose}
        jobId={syncJobId}
      />
      <Stack gap="md">
        <Group grow>
          <Select
            label="Installation"
            placeholder="Select installation"
            data={installations.map((i) => ({
              value: i.id,
              label: i.accountLogin,
            }))}
            value={installationId}
            onChange={setInstallationId}
            required
            withAsterisk
          />
          <Select
            label="Repository"
            placeholder={loadingRepos ? "Loading..." : "owner/repo"}
            searchable
            data={repos.map((r) => ({
              value: r.full_name,
              label: r.full_name,
            }))}
            renderOption={renderRepoOption}
            onChange={(v) => v && onSelectRepo(v)}
            disabled={!installationId}
            required
            withAsterisk
            maxDropdownHeight={400}
          />
        </Group>
        <Group grow>
          <Select
            label="Branch/Ref"
            placeholder={
              refOptions.length === 0
                ? "Select a repository first"
                : "Search branches/tags"
            }
            searchable
            nothingFoundMessage="No matches"
            data={refOptions.map((i) => ({
              value: i.name,
              label: i.type === "tag" ? `${i.name} (tag)` : i.name,
            }))}
            value={ref}
            onChange={(v) => setRef(v || "")}
            disabled={!owner || !repo}
            required
            withAsterisk
          />
          <TextInput
            label="Root directory"
            placeholder="e.g. docs (optional)"
            value={rootDir}
            onChange={(e) => setRootDir(e.currentTarget.value)}
            description="Sync only this subdirectory from the repo"
          />
        </Group>
        <Group grow>
          <Select
            label="Space"
            placeholder="Select space"
            key={spaces.length}
            data={spaces.map((s) => ({ value: s.id, label: s.name }))}
            value={spaceId}
            onChange={setSpaceId}
            required
            withAsterisk
            searchable
          />
          <TextInput
            label="Target path in Space"
            placeholder="e.g. SAA or AWS/SAA (optional)"
            value={targetPath}
            onChange={(e) => setTargetPath(e.currentTarget.value)}
            description="Create this folder structure and place content inside"
          />
        </Group>
        <Group justify="flex-end" mt="xs">
          <Button
            onClick={onCreate}
            loading={creating}
            disabled={!installationId || !owner || !repo || !ref || !spaceId}
            variant="filled"
          >
            Create source
          </Button>
        </Group>
      </Stack>
    </>
  );
}

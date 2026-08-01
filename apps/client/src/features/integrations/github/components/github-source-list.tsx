import {
  ActionIcon,
  Badge,
  Card,
  Group,
  Menu,
  Progress,
  Switch,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  IconAlertTriangle,
  IconDots,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatDistanceToNow } from "date-fns";
import {
  useDeleteGithubSourceMutation,
  useGithubSourcesQuery,
  useGithubSyncJobQuery,
  useRescanSourceMutation,
  useUpdateGithubSourceMutation,
} from "@/features/integrations/github/queries/github-query.ts";
import { IGithubSource } from "@/features/integrations/github/types/github.types.ts";

type Props = {
  activeJobId: string | null;
  onSyncStarted: (jobId: string) => void;
};

export default function GithubSourceList({ activeJobId, onSyncStarted }: Props) {
  const { t } = useTranslation();
  const { data: sources, isLoading } = useGithubSourcesQuery();
  const rescanMutation = useRescanSourceMutation();
  const updateMutation = useUpdateGithubSourceMutation();
  const deleteMutation = useDeleteGithubSourceMutation();

  const confirmDelete = (source: IGithubSource) =>
    modals.openConfirmModal({
      title: t("Remove source"),
      children: (
        <Text size="sm">
          {t(
            "This stops syncing {{repo}}. Pages already synced into the space are kept.",
            { repo: `${source.owner}/${source.repo}` },
          )}
        </Text>
      ),
      labels: { confirm: t("Remove"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(source.id),
    });

  const rescan = async (sourceId: string, force: boolean) => {
    const { jobId } = await rescanMutation.mutateAsync({ sourceId, force });
    onSyncStarted(jobId);
  };

  if (!isLoading && sources?.length === 0) return null;

  return (
    <Card withBorder radius="md" p="md">
      <Text fw={500} mb="sm">
        {t("Sync sources")}
      </Text>

      <SyncProgress jobId={activeJobId} />

      <Table.ScrollContainer minWidth={700}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("Repository")}</Table.Th>
              <Table.Th>{t("Space")}</Table.Th>
              <Table.Th>{t("Last sync")}</Table.Th>
              <Table.Th>{t("Active")}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sources?.map((source) => (
              <Table.Tr key={source.id}>
                <Table.Td>
                  <Text size="sm">
                    {source.owner}/{source.repo}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {source.ref}
                    {source.rootDir ? ` · /${source.rootDir}` : ""}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{source.spaceName}</Text>
                </Table.Td>
                <Table.Td>
                  {source.lastSyncError ? (
                    <Tooltip label={source.lastSyncError} withArrow multiline w={300}>
                      <Badge
                        color="red"
                        variant="light"
                        leftSection={<IconAlertTriangle size={12} />}
                      >
                        {t("Failed")}
                      </Badge>
                    </Tooltip>
                  ) : source.lastSyncedAt ? (
                    <Text size="sm" c="dimmed">
                      {formatDistanceToNow(new Date(source.lastSyncedAt), {
                        addSuffix: true,
                      })}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {t("Never")}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Switch
                    size="sm"
                    checked={source.active}
                    onChange={(e) =>
                      updateMutation.mutate({
                        sourceId: source.id,
                        active: e.currentTarget.checked,
                      })
                    }
                  />
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    <Tooltip label={t("Sync now")} withArrow>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => rescan(source.id, false)}
                      >
                        <IconRefresh size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Menu position="bottom-end" withArrow>
                      <Menu.Target>
                        <ActionIcon variant="subtle">
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconRefresh size={14} />}
                          onClick={() => rescan(source.id, true)}
                        >
                          {t("Force full re-sync")}
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => confirmDelete(source)}
                        >
                          {t("Remove source")}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function SyncProgress({ jobId }: { jobId: string | null }) {
  const { t } = useTranslation();
  const { data: job } = useGithubSyncJobQuery(jobId);

  if (!jobId || !job || job.state === "unknown") return null;
  if (job.state === "completed") return null;

  if (job.state === "failed") {
    return (
      <Text size="sm" c="red" mb="sm">
        {t("Sync failed")}: {job.failedReason}
      </Text>
    );
  }

  const total = job.progress?.total ?? 0;
  const current = job.progress?.current ?? 0;

  return (
    <>
      <Text size="sm" c="dimmed" mb={4}>
        {total > 0
          ? t("Syncing {{current}} of {{total}} files", { current, total })
          : t("Syncing...")}
      </Text>
      <Progress
        value={total > 0 ? (current / total) * 100 : 100}
        animated={total === 0}
        mb="sm"
      />
    </>
  );
}

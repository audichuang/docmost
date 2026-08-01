import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconBrandGithub, IconInfoCircle, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import {
  useDeleteInstallationMutation,
  useGithubConfigQuery,
  useGithubInstallationsQuery,
  useRefreshInstallationsMutation,
} from "@/features/integrations/github/queries/github-query.ts";
import { getInstallAuthUrl } from "@/features/integrations/github/services/github-service.ts";

export default function GithubConnectCard() {
  const { t } = useTranslation();
  const { data: config } = useGithubConfigQuery();
  const { data: installations, isLoading } = useGithubInstallationsQuery();
  const refreshMutation = useRefreshInstallationsMutation();
  const deleteMutation = useDeleteInstallationMutation();

  const connect = async () => {
    try {
      const { url } = await getInstallAuthUrl();
      window.location.href = url;
    } catch (err: any) {
      notifications.show({
        message: err?.message || t("Could not start GitHub authorization"),
        color: "red",
      });
    }
  };

  const confirmDelete = (id: string, login: string) =>
    modals.openConfirmModal({
      title: t("Disconnect GitHub"),
      children: (
        <Text size="sm">
          {t(
            "Disconnecting {{login}} also removes its sync sources. Synced pages are kept.",
            { login },
          )}
        </Text>
      ),
      labels: { confirm: t("Disconnect"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteMutation.mutate(id),
    });

  if (config && !config.configured) {
    return (
      <Alert variant="light" color="yellow" icon={<IconInfoCircle />}>
        {t(
          "GitHub integration is not configured on this server. Set GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_PRIVATE_KEY to enable it.",
        )}
      </Alert>
    );
  }

  return (
    <Card withBorder radius="md" p="md">
      <Group justify="space-between" mb="sm">
        <Text fw={500}>{t("Connected accounts")}</Text>
        <Group gap="xs">
          <Tooltip label={t("Refresh from GitHub")} withArrow>
            <ActionIcon
              variant="default"
              onClick={() => refreshMutation.mutate()}
              loading={refreshMutation.isPending}
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Button
            leftSection={<IconBrandGithub size={16} />}
            onClick={connect}
            variant="default"
          >
            {t("Connect GitHub")}
          </Button>
        </Group>
      </Group>

      {!isLoading && installations?.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("No GitHub account connected yet.")}
        </Text>
      )}

      <Stack gap="xs">
        {installations?.map((installation) => (
          <Group key={installation.id} justify="space-between">
            <Group gap="xs">
              <IconBrandGithub size={16} />
              <Text size="sm">{installation.accountLogin}</Text>
              <Badge variant="light" size="sm">
                {installation.accountType}
              </Badge>
            </Group>
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() =>
                confirmDelete(installation.id, installation.accountLogin)
              }
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

import { Card, Group, Button, Text, Stack, Badge, Title, ActionIcon, Tooltip } from '@mantine/core';
import { GithubInstallation, syncInstallations, getAuthUrl, deleteInstallation } from '../services/github-integration-api';
import { IconBrandGithub, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import { modals } from '@mantine/modals';

export default function GithubInstallCard({
  installations = [] as GithubInstallation[],
  onRefresh
}: {
  installations?: GithubInstallation[];
  onRefresh?: () => void;
}) {
  const items = installations || [];
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const result = await getAuthUrl();
      window.location.href = result.url;
    } catch (err) {
      notifications.show({
        title: 'Failed to connect',
        message: 'Could not generate GitHub authorization URL',
        color: 'red',
      });
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncInstallations();
      notifications.show({
        title: 'Sync completed',
        message: `Synced ${result.synced} installation(s) from GitHub`,
        color: 'green',
      });
      onRefresh?.();
    } catch (err) {
      notifications.show({
        title: 'Sync failed',
        message: 'Failed to sync installations from GitHub',
        color: 'red',
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = (installation: GithubInstallation) => {
    modals.openConfirmModal({
      title: 'Delete Installation',
      children: (
        <Text size="sm">
          Are you sure you want to unlink <Text span fw={500}>{installation.accountLogin}</Text>?
          This will not uninstall the app from GitHub, only remove the connection from Docmost.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        setDeleting(installation.id);
        try {
          await deleteInstallation(installation.id);
          notifications.show({
            title: 'Installation deleted',
            message: `Unlinked ${installation.accountLogin} from workspace`,
            color: 'green',
          });
          onRefresh?.();
        } catch (err) {
          notifications.show({
            title: 'Delete failed',
            message: 'Failed to delete installation',
            color: 'red',
          });
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md">
        <Group gap="xs">
          <IconBrandGithub size={20} />
          <Title order={5}>GitHub App</Title>
        </Group>
        <Group gap="xs">
          <Button
            onClick={handleSync}
            loading={syncing}
            variant="subtle"
            size="sm"
            leftSection={<IconRefresh size={16} />}
            disabled={connecting}
          >
            Refresh
          </Button>
          <Button
            onClick={handleConnect}
            loading={connecting}
            variant="filled"
            size="sm"
            leftSection={<IconBrandGithub size={16} />}
          >
            Connect GitHub
          </Button>
        </Group>
      </Group>

      <Stack gap="sm">
        {!syncing && items.length === 0 && (
          <Text c="dimmed" size="sm">
            No GitHub App installations found. Click "Connect GitHub" to install the app.
          </Text>
        )}
        {items.map((it) => (
          <Card key={it.id} withBorder padding="sm" bg="gray.0" style={{ borderStyle: 'dashed' }}>
            <Group justify="space-between">
              <Group gap="xs">
                <Text fw={500}>{it.accountLogin}</Text>
                <Badge variant="light" size="sm">{it.accountType}</Badge>
                <Badge variant="outline" color="gray" size="sm">#{it.installationId}</Badge>
              </Group>
              <Tooltip label="Unlink installation">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => handleDelete(it)}
                  loading={deleting === it.id}
                  disabled={deleting !== null}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Card>
        ))}
      </Stack>
    </Card>
  );
}

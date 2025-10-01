import { Card, Group, Button, Text, Stack } from '@mantine/core';
import { GithubInstallation } from '../services/github-integration-api';
import { IconBrandGithub } from '@tabler/icons-react';

export default function GithubInstallCard({ installations = [] as GithubInstallation[] }: { installations?: GithubInstallation[] }) {
  const items = installations || [];
  const loading = false;

  return (
    <Card withBorder>
      <Group justify="space-between">
        <Group>
          <IconBrandGithub />
          <Text fw={500}>GitHub App</Text>
        </Group>
        <Button component="a" href="https://github.com/settings/installations" target="_blank" variant="light">
          Manage on GitHub
        </Button>
      </Group>

      <Stack mt="md" gap="xs">
        {loading && <Text c="dimmed">Loading installations...</Text>}
        {!loading && items.length === 0 && <Text c="dimmed">No installations.</Text>}
        {!loading && items.map((it) => (
          <Group key={it.id} justify="space-between">
            <Text>{it.accountLogin} ({it.accountType})</Text>
            <Text size="sm" c="dimmed">#{it.installationId}</Text>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

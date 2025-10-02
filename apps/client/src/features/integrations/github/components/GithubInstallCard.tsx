import { Card, Group, Button, Text, Stack, Badge, Title } from '@mantine/core';
import { GithubInstallation } from '../services/github-integration-api';
import { IconBrandGithub } from '@tabler/icons-react';

export default function GithubInstallCard({ installations = [] as GithubInstallation[] }: { installations?: GithubInstallation[] }) {
  const items = installations || [];
  const loading = false;

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md">
        <Group gap="xs">
          <IconBrandGithub size={20} />
          <Title order={5}>GitHub App</Title>
        </Group>
        <Button
          component="a"
          href="https://github.com/settings/installations"
          target="_blank"
          variant="light"
          size="sm"
        >
          Manage on GitHub
        </Button>
      </Group>

      <Stack gap="sm">
        {loading && <Text c="dimmed" size="sm">Loading installations...</Text>}
        {!loading && items.length === 0 && (
          <Text c="dimmed" size="sm">
            No GitHub App installations found. Click "Manage on GitHub" to install the app.
          </Text>
        )}
        {!loading && items.map((it) => (
          <Card key={it.id} withBorder padding="sm" bg="gray.0" style={{ borderStyle: 'dashed' }}>
            <Group justify="space-between">
              <Group gap="xs">
                <Text fw={500}>{it.accountLogin}</Text>
                <Badge variant="light" size="sm">{it.accountType}</Badge>
              </Group>
              <Badge variant="outline" color="gray" size="sm">#{it.installationId}</Badge>
            </Group>
          </Card>
        ))}
      </Stack>
    </Card>
  );
}

import { Helmet } from 'react-helmet-async';
import { getAppName } from '@/lib/config.ts';
import SettingsTitle from '@/components/settings/settings-title.tsx';
import { Grid, GridCol, Stack, Divider, Title, Card } from '@mantine/core';
import GithubInstallCard from '../components/GithubInstallCard';
import SourceTable from '../components/SourceTable';
import RepoSelector from '../components/RepoSelector';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getSpaces } from '@/features/space/services/space-service';
import { listInstallations } from '../services/github-integration-api';

export default function IntegrationsGithubPage() {
  const { data: installations } = useQuery({ queryKey: ['gh-installations'], queryFn: () => listInstallations() });
  const { data: spaces } = useQuery({ queryKey: ['spaces', { page: 1 }], queryFn: async () => (await getSpaces({ page: 1 })).items ?? [] });
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <>
      <Helmet>
        <title>GitHub Integration - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title={'GitHub Integration'} />

      <Grid>
        <GridCol span={{ base: 12, md: 6 }}>
          <Card withBorder style={{ height: '100%' }}>
            <GithubInstallCard installations={Array.isArray(installations) ? installations : []} />
          </Card>
        </GridCol>
        <GridCol span={{ base: 12, md: 6 }}>
          <Card withBorder style={{ height: '100%' }}>
            <Title order={5}>Add Source</Title>
            <RepoSelector
              installations={(Array.isArray(installations) ? installations : []).map((i: any) => ({ id: i.id, accountLogin: i.accountLogin }))}
              spaces={(Array.isArray(spaces) ? spaces : []).map((s: any) => ({ id: s.id, name: s.name }))}
              onCreated={() => setRefreshToken((t) => t + 1)}
            />
          </Card>
        </GridCol>
        <GridCol span={{ base: 12 }}>
          <Card withBorder>
            <Stack>
              <Divider my="xs" />
              <Title order={5}>Sources</Title>
              <SourceTable spaces={(Array.isArray(spaces) ? spaces : []).map((s: any) => ({ id: s.id, name: s.name }))} refreshToken={refreshToken} />
            </Stack>
          </Card>
        </GridCol>
      </Grid>
    </>
  );
}

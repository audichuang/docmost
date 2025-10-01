import { useEffect, useState } from 'react';
import { Group, Select, TextInput, Button, Stack } from '@mantine/core';
import { listRepos, createSource, listRefs } from '../services/github-integration-api';

export default function RepoSelector({ installations, spaces, onCreated }: { installations: { id: string; accountLogin: string }[], spaces: { id: string; name: string }[], onCreated?: () => void }) {
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [repos, setRepos] = useState<{ full_name: string; default_branch: string }[]>([]);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [refOptions, setRefOptions] = useState<{ name: string; type: 'branch' | 'tag' }[]>([]);
  const [rootDir, setRootDir] = useState('');
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      if (!installationId) return;
      setLoadingRepos(true);
      try {
        const res = await listRepos(installationId);
        setRepos(res?.repositories?.map((r: any) => ({ full_name: r.full_name, default_branch: r.default_branch })) || []);
      } finally {
        setLoadingRepos(false);
      }
    })();
  }, [installationId]);

  const onSelectRepo = (fullName: string) => {
    const [o, r] = fullName.split('/');
    setOwner(o);
    setRepo(r);
    const d = repos.find((x) => x.full_name === fullName)?.default_branch || '';
    setRef(d);
    // Load branches/tags for autocomplete
    if (installationId && o && r) {
      listRefs({ githubInstallationId: installationId, owner: o, repo: r })
        .then((res) => {
          const items = (res?.items || []) as { name: string; type: 'branch' | 'tag' }[];
          setRefOptions(items);
        })
        .catch(() => setRefOptions([]));
    }
  };

  const onCreate = async () => {
    if (!installationId || !owner || !repo || !ref || !spaceId) return;
    setCreating(true);
    try {
      await createSource({ githubInstallationId: installationId, owner, repo, ref, rootDir: rootDir || '', spaceId });
      onCreated?.();
    } finally {
      setCreating(false);
    }
  };

  return (
    <Stack>
      <Group grow>
        <Select label="Installation" placeholder="Select installation" data={installations.map((i) => ({ value: i.id, label: i.accountLogin }))} value={installationId} onChange={setInstallationId} />
        <Select label="Repository" placeholder={loadingRepos ? 'Loading...' : 'owner/repo'} searchable data={repos.map((r) => ({ value: r.full_name, label: r.full_name }))} onChange={(v) => v && onSelectRepo(v)} />
      </Group>
      <Group grow>
        <Select
          label="Branch/Ref"
          placeholder={refOptions.length === 0 ? 'Select a repository first' : 'Search branches/tags'}
          searchable
          nothingFoundMessage="No matches"
          data={refOptions.map((i) => ({ value: i.name, label: i.type === 'tag' ? `${i.name} (tag)` : i.name }))}
          value={ref}
          onChange={(v) => setRef(v || '')}
        />
        <TextInput label="Root directory (optional)" placeholder="e.g. docs" value={rootDir} onChange={(e) => setRootDir(e.currentTarget.value)} />
      </Group>
      <Group grow>
        <Select label="Space" placeholder="Select space" data={spaces.map((s) => ({ value: s.id, label: s.name }))} value={spaceId} onChange={setSpaceId} />
      </Group>
      <Group justify="flex-end">
        <Button onClick={onCreate} loading={creating} disabled={!installationId || !owner || !repo || !ref || !spaceId}>Create source</Button>
      </Group>
    </Stack>
  );
}

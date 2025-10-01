import { useEffect, useState } from 'react';
import { Table, Button, Group, Text, ScrollArea } from '@mantine/core';
import { modals } from '@mantine/modals';
import { listSources, rescanSource, GithubSource, patchSourceActive, deleteSourceApi } from '../services/github-integration-api';
import SyncStatusTag from './SyncStatusTag';

export default function SourceTable({ spaces = [], refreshToken }: { spaces?: { id: string; name: string }[]; refreshToken?: number }) {
  const [sources, setSources] = useState<GithubSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [rescanMap, setRescanMap] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await listSources();
      setSources(res || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const onRescan = async (id: string) => {
    setRescanMap((m) => ({ ...m, [id]: true }));
    try {
      await rescanSource(id, { force: true });
      await load();
    } finally {
      setRescanMap((m) => ({ ...m, [id]: false }));
    }
  };

  if (loading) return <Text c="dimmed">Loading sources...</Text>;

  return (
    <ScrollArea type="auto" offsetScrollbars>
    <Table miw={1000} stickyHeader>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Space</Table.Th>
          <Table.Th>Repository</Table.Th>
          <Table.Th>Ref</Table.Th>
          <Table.Th>Root</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Last Event</Table.Th>
          <Table.Th>Updated</Table.Th>
          <Table.Th></Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {sources.map((s) => (
          <Table.Tr key={s.id}>
            <Table.Td>{spaces.find((sp) => sp.id === s.spaceId)?.name || s.spaceId}</Table.Td>
            <Table.Td>{s.owner}/{s.repo}</Table.Td>
            <Table.Td>{s.ref}</Table.Td>
            <Table.Td>{s.rootDir || '/'}</Table.Td>
            <Table.Td>
              <SyncStatusTag status={s.lastEventOk === true ? 'ok' : s.lastEventOk === false ? 'error' : 'idle'} />
            </Table.Td>
            <Table.Td>{s.lastEventProcessedAt ? new Date(s.lastEventProcessedAt).toLocaleString() : '-'}</Table.Td>
            <Table.Td>{new Date(s.updatedAt).toLocaleString()}</Table.Td>
            <Table.Td>
              <Group justify="right">
                <Button size="xs" variant="light" onClick={() => onRescan(s.id)} loading={!!rescanMap[s.id]}>Rescan</Button>
                <Button size="xs" variant={s.active ? 'default' : 'light'} onClick={async () => { await patchSourceActive(s.id, !s.active); await load(); }}>{s.active ? 'Disable' : 'Enable'}</Button>
                <Button size="xs" color="red" variant="light" onClick={() => {
                  modals.openConfirmModal({
                    title: 'Delete source',
                    children: 'Are you sure you want to delete this source? This will remove the mapping but not pages.',
                    labels: { confirm: 'Delete', cancel: "Don't" },
                    confirmProps: { color: 'red' },
                    onConfirm: async () => { await deleteSourceApi(s.id); await load(); },
                  });
                }}>Delete</Button>
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
    </ScrollArea>
  );
}

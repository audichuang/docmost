import { Badge } from '@mantine/core';

export default function SyncStatusTag({ status }: { status?: 'idle' | 'syncing' | 'ok' | 'error' }) {
  const color = status === 'syncing' ? 'blue' : status === 'ok' ? 'green' : status === 'error' ? 'red' : 'gray';
  const label = status === 'syncing' ? 'Syncing' : status === 'ok' ? 'Synced' : status === 'error' ? 'Error' : 'Idle';
  return <Badge color={color}>{label}</Badge>;
}


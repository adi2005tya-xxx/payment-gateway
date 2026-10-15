'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Notice, useAction, useApi } from '@/components/ui';
import { api, when } from '@/lib/api';

export default function Reconciliation() {
  const runs = useApi<any[]>('/admin/reconciliation/runs');
  const [last, setLast] = useState<any>(null);
  const act = useAction();
  return (
    <>
      <PageHeader title="Reconciliation" subtitle="Compares our ledger with the provider's/bank's records. A clean run is required before outbound money is released after a restore." actions={
        <Button busy={act.busy} onClick={async () => { const r = await act.run(() => api.post('/admin/reconciliation/run')); if (r) { setLast(r); void runs.reload(); } }}>Run reconciliation now</Button>
      } />
      <ErrorBanner error={runs.error ?? act.error} />
      {last && (
        last.discrepancies === 0
          ? <Notice tone="green">Clean: {last.checked} records checked, no discrepancies.</Notice>
          : <Card title={`${last.discrepancies} discrepancies found`} className="mb-6">
              <DataTable rows={last.items.filter((i: any) => !i.resolved)} rowKey={(i: any) => `${i.kind}${i.subject}`} columns={[
                { header: 'Kind', cell: (i: any) => <Badge tone="red">{i.kind}</Badge> },
                { header: 'Subject', cell: (i: any) => <code className="text-xs">{i.subject}</code> },
                { header: 'Detail', cell: (i: any) => <code className="text-xs text-slate-600">{JSON.stringify(i.detail)}</code> },
              ]} />
            </Card>
      )}
      <Card title="Past runs">
        <DataTable rows={runs.data} rowKey={(r) => r.id} columns={[
          { header: 'When', cell: (r) => when(r.created_at) },
          { header: 'Checked', cell: (r) => r.items_checked },
          { header: 'Discrepancies', cell: (r) => (r.discrepancies ? <Badge tone="red">{String(r.discrepancies)}</Badge> : <Badge tone="green">0</Badge>) },
        ]} />
      </Card>
    </>
  );
}

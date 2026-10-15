'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Notice, Select, useAction, useApi } from '@/components/ui';
import { api, when } from '@/lib/api';

export default function Destinations() {
  const [status, setStatus] = useState('PENDING');
  const list = useApi<any[]>(`/admin/destinations${status ? `?status=${status}` : ''}`);
  const act = useAction();

  const verify = (d: any) => {
    const risky = d.nameMatches === false || d.open_review;
    if (risky && !confirm(`${d.nameMatches === false ? `The bank returned "${d.beneficiary_name}", which does not match "${d.legal_name}". ` : ''}${d.open_review ? 'The same UPI ID is registered by another merchant. ' : ''}Verify anyway? This is recorded against your name.`)) return;
    void act.run(async () => { await api.post(`/admin/destinations/${d.id}/verify`, { confirmReview: risky || undefined }); await list.reload(); });
  };

  return (
    <>
      <PageHeader title="Settlement destinations" subtitle="A payout can only go to a destination you have verified. Compare the bank-returned name with the registered business." actions={
        <Select className="w-48" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="PENDING">Pending</option><option value="VERIFIED">Verified</option><option value="DISABLED">Retired</option><option value="">All</option>
        </Select>
      } />
      <ErrorBanner error={list.error ?? act.error} />
      <Notice tone="amber">Verifying a new destination retires the merchant's current one. Do this only after confirming the change really came from the merchant.</Notice>
      <Card>
        <DataTable rows={list.data} rowKey={(r) => r.id} empty="No destinations in this state." columns={[
          { header: 'Merchant (registered name)', cell: (r) => r.legal_name },
          { header: 'UPI ID (masked)', cell: (r) => <code className="text-xs">{r.masked_account}</code> },
          { header: 'Bank-returned name', cell: (r) => r.beneficiary_name ?? '—' },
          { header: 'Name check', cell: (r) => r.nameMatches === null ? '—' : r.nameMatches ? <Badge tone="green">MATCH</Badge> : <Badge tone="red">MISMATCH</Badge> },
          { header: 'Flags', cell: (r) => (r.open_review ? <Badge tone="red">SAME UPI ID, OTHER MERCHANT</Badge> : '') },
          { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
          { header: 'Added', cell: (r) => when(r.created_at) },
          { header: '', cell: (r) => r.status === 'PENDING' && <Button busy={act.busy} onClick={() => verify(r)}>Verify</Button> },
        ]} />
      </Card>
    </>
  );
}

'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Notice, Select, TextPrompt, useAction, useApi } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

export default function AdminPayouts() {
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useApi<any[]>(`/admin/payouts?limit=25&offset=${offset}${status ? `&status=${status}` : ''}`);
  const [reject, setReject] = useState<any>(null);
  const act = useAction();

  return (
    <>
      <PageHeader title="Payouts" subtitle="Held payouts need a second administrator: you cannot approve a payout you requested." actions={
        <Select className="w-48" aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All</option>
          {['UNDER_REVIEW', 'QUEUED', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'RETURNED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </Select>
      } />
      <ErrorBanner error={list.error ?? act.error} />
      <Notice tone="amber">Never retry a payout by creating a new one. Use <strong>Retry</strong>: it looks the payout up at the provider first, so a transfer that already happened is adopted, not repeated.</Notice>
      <Card>
        <DataTable rows={list.data} rowKey={(r) => r.id} columns={[
          { header: 'Requested', cell: (r) => when(r.created_at) },
          { header: 'Amount', cell: (r) => inr(r.amount_minor), className: 'tabular-nums' },
          { header: 'Status', cell: (r) => <div><Badge>{r.status}</Badge>{r.outcome_unknown && <div className="mt-1"><Badge tone="red">OUTCOME UNKNOWN</Badge></div>}</div> },
          { header: 'Group', cell: (r) => (r.payout_group ? <code className="text-xs">{String(r.payout_group).slice(0, 8)}</code> : '—') },
          { header: 'Provider ref', cell: (r) => <code className="text-xs">{r.provider_payout_id ?? '—'}</code> },
          { header: 'Failure', cell: (r) => <span className="text-xs">{r.failure_reason}</span> },
          { header: '', cell: (r) => r.status === 'UNDER_REVIEW' && (
            <div className="flex gap-1">
              {!r.outcome_unknown ? (
                <Button busy={act.busy} onClick={() => { if (confirm(`Approve payout of ${inr(r.amount_minor)}${r.payout_group ? ' (all parts of this split payout)' : ''}?`)) void act.run(async () => { await api.post(`/admin/payouts/${r.id}/approve`); await list.reload(); }); }}>Approve</Button>
              ) : (
                <Button variant="secondary" busy={act.busy} onClick={() => { if (confirm('Re-drive this payout? The provider is queried first; nothing is sent twice.')) void act.run(async () => { await api.post(`/admin/payouts/${r.id}/retry`); await list.reload(); }); }}>Retry</Button>
              )}
              <Button variant="danger" onClick={() => setReject(r)}>Reject</Button>
            </div>
          ) },
        ]} />
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
          <Button variant="secondary" disabled={!list.data || list.data.length < 25} onClick={() => setOffset(offset + 25)}>Next</Button>
        </div>
      </Card>
      {reject && <TextPrompt title="Reject payout" label="Reason" minLength={3} danger confirmLabel="Reject and release funds" hint="The reserved amount returns to the merchant's balance." onSubmit={async (reason) => { await api.post(`/admin/payouts/${reject.id}/reject`, { reason }); await list.reload(); return true; }} onClose={() => setReject(null)} />}
    </>
  );
}

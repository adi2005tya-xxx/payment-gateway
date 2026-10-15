'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, TextPrompt, useApi } from '@/components/ui';
import { api, when } from '@/lib/api';

type Prompt = { kind: 'decide'; id: string; decision: 'APPROVED' | 'REJECTED'; name: string } | { kind: 'status'; id: string; status: 'ACTIVE' | 'SUSPENDED'; name: string } | null;

export default function AdminMerchants() {
  const cases = useApi<any[]>('/admin/verification-cases');
  const merchants = useApi<any[]>('/admin/merchants?limit=100');
  const [prompt, setPrompt] = useState<Prompt>(null);
  const reload = () => { void cases.reload(); void merchants.reload(); };

  return (
    <>
      <PageHeader title="Merchants" subtitle="Review onboarding, suspend or reinstate accounts. These actions need a fresh authenticator code." />
      <ErrorBanner error={cases.error ?? merchants.error} />
      <div className="space-y-6">
        <Card title="Verification cases">
          <DataTable rows={cases.data} rowKey={(r) => r.id} empty="No cases." columns={[
            { header: 'Business', cell: (r) => r.legal_name },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'Submitted', cell: (r) => when(r.created_at) },
            { header: 'Notes', cell: (r) => <span className="text-xs text-slate-600">{r.notes}</span> },
            { header: '', cell: (r) => ['SUBMITTED', 'INFO_REQUIRED'].includes(r.status) && (
              <div className="flex gap-1">
                <Button variant="secondary" onClick={() => setPrompt({ kind: 'decide', id: r.id, decision: 'APPROVED', name: r.legal_name })}>Approve</Button>
                <Button variant="danger" onClick={() => setPrompt({ kind: 'decide', id: r.id, decision: 'REJECTED', name: r.legal_name })}>Reject</Button>
              </div>
            ) },
          ]} />
          <p className="mt-3 text-xs text-slate-500">Only approve after your own KYC/KYB checks outside this tool. Merchant onboarding is not a legal identity verification by itself.</p>
        </Card>
        <Card title="All merchants">
          <DataTable rows={merchants.data} rowKey={(r) => r.id} columns={[
            { header: 'Business', cell: (r) => <div>{r.legal_name}<div className="text-xs text-slate-500">{r.display_name}</div></div> },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'Fee', cell: (r) => `${(r.fee_bps / 100).toFixed(2)}%` },
            { header: 'Since', cell: (r) => when(r.created_at) },
            { header: '', cell: (r) => r.status === 'ACTIVE' ? <Button variant="danger" onClick={() => setPrompt({ kind: 'status', id: r.id, status: 'SUSPENDED', name: r.legal_name })}>Suspend</Button> : r.status === 'SUSPENDED' ? <Button variant="secondary" onClick={() => setPrompt({ kind: 'status', id: r.id, status: 'ACTIVE', name: r.legal_name })}>Reinstate</Button> : null },
          ]} />
        </Card>
      </div>
      {prompt?.kind === 'decide' && (
        <TextPrompt title={`${prompt.decision === 'APPROVED' ? 'Approve' : 'Reject'} ${prompt.name}`} label="Notes (kept with the case)" minLength={prompt.decision === 'REJECTED' ? 5 : 0} danger={prompt.decision === 'REJECTED'} confirmLabel={prompt.decision === 'APPROVED' ? 'Approve' : 'Reject'}
          onSubmit={async (notes) => { await api.post(`/admin/verification-cases/${prompt.id}/decision`, { decision: prompt.decision, notes: notes || undefined }); reload(); return true; }} onClose={() => setPrompt(null)} />
      )}
      {prompt?.kind === 'status' && (
        <TextPrompt title={`${prompt.status === 'SUSPENDED' ? 'Suspend' : 'Reinstate'} ${prompt.name}`} label="Reason" minLength={5} danger={prompt.status === 'SUSPENDED'} confirmLabel={prompt.status === 'SUSPENDED' ? 'Suspend' : 'Reinstate'}
          hint={prompt.status === 'SUSPENDED' ? 'Suspended merchants cannot create payment requests or request payouts.' : undefined}
          onSubmit={async (reason) => { await api.post(`/admin/merchants/${prompt.id}/status`, { status: prompt.status, reason }); reload(); return true; }} onClose={() => setPrompt(null)} />
      )}
    </>
  );
}

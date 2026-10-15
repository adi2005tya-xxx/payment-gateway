'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { MfaSetup } from '@/components/mfa-setup';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Notice, useAction, useApi } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

export default function Account() {
  const me = useApi('/merchant/me');
  const bal = useApi('/merchant/balance');
  const [vpa, setVpa] = useState('');
  const [added, setAdded] = useState<any>(null);
  const { busy, error, run } = useAction();
  const m = me.data;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/merchant/destinations/upi', { vpa: vpa.trim() }));
    if (r) {
      setAdded(r);
      setVpa('');
      void me.reload();
    }
  };

  return (
    <>
      <PageHeader title="Account & security" />
      <ErrorBanner error={me.error} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Business profile">
          {!m ? <p className="text-sm text-slate-500">Loading…</p> : (
            <dl className="grid grid-cols-3 gap-y-2 text-sm">
              <dt className="text-slate-500">Display name</dt><dd className="col-span-2">{m.displayName}</dd>
              <dt className="text-slate-500">Registered name</dt><dd className="col-span-2">{m.legalName}</dd>
              <dt className="text-slate-500">Account status</dt><dd className="col-span-2"><Badge>{m.status}</Badge></dd>
              <dt className="text-slate-500">Verification</dt><dd className="col-span-2">{m.verification ? <><Badge>{m.verification.status}</Badge>{m.verification.notes && <span className="ml-2 text-slate-600">{m.verification.notes}</span>}</> : '—'}</dd>
              <dt className="text-slate-500">Platform fee</dt><dd className="col-span-2">{(m.feeBps / 100).toFixed(2)}% per payment</dd>
              <dt className="text-slate-500">Available balance</dt><dd className="col-span-2">{bal.data ? inr(bal.data.availableMinor) : '…'}</dd>
            </dl>
          )}
        </Card>

        <MfaSetup />

        <Card title="Settlement destinations (UPI)" className="lg:col-span-2">
          <ErrorBanner error={error} />
          <DataTable rows={m ? m.destinations : null} rowKey={(d: any) => d.id} empty="No UPI ID added yet." columns={[
            { header: 'UPI ID', cell: (d: any) => <code className="text-xs">{d.masked_account}</code> },
            { header: 'Status', cell: (d: any) => <Badge>{d.status}</Badge> },
            { header: 'Added', cell: (d: any) => when(d.created_at) },
          ]} />
          <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
            <Field label="Add your UPI ID" hint="e.g. name@okhdfc. Only a masked form is ever shown or stored.">{(id) => <Input id={id} required autoComplete="off" value={vpa} onChange={(e) => setVpa(e.target.value)} />}</Field>
            <Button type="submit" busy={busy} disabled={!vpa.trim()}>Validate and add</Button>
          </form>
          {added && (
            <div className="mt-3">
              <Notice tone="green">Added <strong>{added.maskedVpa}</strong>. The bank returned the account holder name <strong>{added.beneficiaryName}</strong>. An administrator must verify it (they compare this name with your registered business name) before payouts can use it.</Notice>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">Changing your settlement destination is audited, needs administrator verification, and replaces the current one once verified.</p>
        </Card>
      </div>
    </>
  );
}

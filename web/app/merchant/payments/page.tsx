'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Modal, Select, useAction, useApi } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

const PAGE = 25;

export default function MerchantPayments() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(status && { status }), ...(q && { search: q }) });
  const list = useApi<any[]>(`/merchant/payments?${qs}`);
  const [open, setOpen] = useState<string | null>(null);
  const dl = useAction();

  return (
    <>
      <PageHeader title="Payments" subtitle="Every payment the platform has verified, held or failed." actions={<Button variant="secondary" busy={dl.busy} onClick={() => dl.run(() => api.download('/merchant/payments.csv', 'payments.csv'))}>Download CSV</Button>} />
      <ErrorBanner error={list.error ?? dl.error} />
      <Card>
        <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setOffset(0); setQ(search.trim()); }}>
          <Field label="Search">{(id) => <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order reference or provider id" />}</Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
                <option value="">All</option>
                {['SUCCEEDED', 'UNDER_REVIEW', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </Select>
            )}
          </Field>
          <Button type="submit">Search</Button>
        </form>
        <DataTable rows={list.data} rowKey={(r) => r.id} empty="No payments match." columns={[
          { header: 'Order', cell: (r) => r.order_reference ?? '—' },
          { header: 'Amount', cell: (r) => inr(r.amount_minor), className: 'tabular-nums' },
          { header: 'Fee', cell: (r) => inr(r.fee_minor), className: 'tabular-nums' },
          { header: 'You receive', cell: (r) => inr(r.net_minor), className: 'tabular-nums' },
          { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
          { header: 'Verification', cell: (r) => <span className="text-xs text-slate-600">{r.verification_result}</span> },
          { header: 'Refunded', cell: (r) => (Number(r.refunded_minor) ? inr(r.refunded_minor) : '—'), className: 'tabular-nums' },
          { header: 'Provider ref', cell: (r) => <code className="text-xs">{r.provider_payment_id}</code> },
          { header: 'Created', cell: (r) => when(r.created_at) },
          { header: '', cell: (r) => <Button variant="ghost" onClick={() => setOpen(r.id)}>Details</Button> },
        ]} />
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
          <span className="text-slate-500">Showing {list.data?.length ? `${offset + 1}–${offset + list.data.length}` : 0}</span>
          <Button variant="secondary" disabled={!list.data || list.data.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Next</Button>
        </div>
      </Card>
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/merchant/payments/${id}`);
  const p = d.data;
  return (
    <Modal title="Payment details" onClose={onClose}>
      <ErrorBanner error={d.error} />
      {!p ? <p className="text-sm text-slate-500">Loading…</p> : (
        <dl className="grid grid-cols-3 gap-y-2 text-sm">
          <dt className="text-slate-500">Status</dt><dd className="col-span-2"><Badge>{p.status}</Badge>{p.is_sandbox && <span className="ml-2"><Badge tone="amber">SANDBOX</Badge></span>}</dd>
          <dt className="text-slate-500">Amount</dt><dd className="col-span-2">{inr(p.amount_minor)} (fee {inr(p.fee_minor)}, you receive {inr(p.net_minor)})</dd>
          <dt className="text-slate-500">Provider ref</dt><dd className="col-span-2 break-all"><code className="text-xs">{p.provider_payment_id}</code></dd>
          <dt className="text-slate-500">Verification</dt><dd className="col-span-2">{p.verification_result}</dd>
          <dt className="text-slate-500">Created</dt><dd className="col-span-2">{when(p.created_at)}</dd>
          <dt className="text-slate-500">Refunds</dt>
          <dd className="col-span-2">{p.refunds?.length ? p.refunds.map((r: any) => <div key={r.id}>{inr(r.amount_minor)} <Badge>{r.status}</Badge></div>) : 'None'}</dd>
        </dl>
      )}
      <div className="mt-5 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Modal>
  );
}

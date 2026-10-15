'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Modal, Notice, Select, useAction, useApi } from '@/components/ui';
import { api, idempotencyKey, inr, toMinor, when } from '@/lib/api';

function Inner() {
  const [status, setStatus] = useState(useSearchParams().get('status') ?? '');
  const [offset, setOffset] = useState(0);
  const list = useApi<any[]>(`/admin/payments?limit=25&offset=${offset}${status ? `&status=${status}` : ''}`);
  const [refund, setRefund] = useState<any>(null);
  const act = useAction();

  return (
    <>
      <PageHeader title="Payments" subtitle="Payments held in suspense were captured but could not be matched with certainty; approve them to the merchant or refund them." actions={
        <Select className="w-48" aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All</option>
          {['SUCCEEDED', 'UNDER_REVIEW', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </Select>
      } />
      <ErrorBanner error={list.error ?? act.error} />
      <Card>
        <DataTable rows={list.data} rowKey={(r) => r.id} columns={[
          { header: 'Provider ref', cell: (r) => <code className="text-xs">{r.provider_payment_id}</code> },
          { header: 'Amount', cell: (r) => inr(r.amount_minor), className: 'tabular-nums' },
          { header: 'Fee', cell: (r) => inr(r.fee_minor), className: 'tabular-nums' },
          { header: 'Refunded', cell: (r) => (Number(r.refunded_minor) ? inr(r.refunded_minor) : '—'), className: 'tabular-nums' },
          { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
          { header: 'Verification', cell: (r) => <span className="text-xs">{r.verification_result}</span> },
          { header: 'Created', cell: (r) => when(r.created_at) },
          { header: '', cell: (r) => (
            <div className="flex gap-1">
              {r.status === 'UNDER_REVIEW' && r.merchant_id && r.payment_request_id && (
                <Button variant="secondary" busy={act.busy} onClick={() => { if (confirm('Credit this payment to the merchant named on the request? It is released from suspense and the platform fee is taken.')) void act.run(async () => { await api.post(`/admin/payments/${r.id}/approve-review`); await list.reload(); }); }}>Approve to merchant</Button>
              )}
              {['SUCCEEDED', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW'].includes(r.status) && <Button variant="ghost" onClick={() => setRefund(r)}>Refund…</Button>}
            </div>
          ) },
        ]} />
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</Button>
          <Button variant="secondary" disabled={!list.data || list.data.length < 25} onClick={() => setOffset(offset + 25)}>Next</Button>
        </div>
      </Card>
      {refund && <RefundModal payment={refund} onClose={() => setRefund(null)} onDone={() => list.reload()} />}
    </>
  );
}

function RefundModal({ payment, onClose, onDone }: { payment: any; onClose: () => void; onDone: () => void }) {
  const remaining = Number(payment.amount_minor) - Number(payment.refunded_minor);
  const full = payment.status === 'UNDER_REVIEW';
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [key] = useState(() => idempotencyKey()); // double-click safe
  const { busy, error, run } = useAction();
  const minor = toMinor(amount);
  const bad = minor === null || minor <= 0 || minor > remaining || (full && minor !== remaining);
  return (
    <Modal title="Refund payment" onClose={onClose}>
      <ErrorBanner error={error} />
      {full && <Notice>Payments held for review can only be refunded in full.</Notice>}
      <form onSubmit={async (e) => { e.preventDefault(); if (minor === null) return; if (await run(() => api.post(`/admin/payments/${payment.id}/refund`, { amountMinor: minor, idempotencyKey: key, reason: reason || undefined }))) { onDone(); onClose(); } }} className="space-y-3">
        <Field label={`Amount (₹), up to ${inr(remaining)}`} error={amount && bad ? 'Invalid amount' : undefined}>{(id) => <Input id={id} inputMode="decimal" value={amount} disabled={full} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Reason">{(id) => <Input id={id} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" busy={busy} disabled={bad}>Refund</Button></div>
      </form>
    </Modal>
  );
}

export default function AdminPayments() {
  return <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}><Inner /></Suspense>;
}

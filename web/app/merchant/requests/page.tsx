'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Modal, Notice, useAction, useApi } from '@/components/ui';
import { api, inr, toMinor, when } from '@/lib/api';

export default function PaymentRequests() {
  const list = useApi<any[]>('/merchant/payment-requests?limit=50');
  const [f, setF] = useState({ orderReference: '', amount: '', description: '', expiresInMinutes: '' });
  const [shown, setShown] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const cancel = useAction();
  const minor = toMinor(f.amount);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (minor === null) return;
    const r = await run(() => api.post('/merchant/payment-requests', { orderReference: f.orderReference.trim(), amountMinor: minor, description: f.description.trim() || undefined, expiresInMinutes: f.expiresInMinutes ? Number(f.expiresInMinutes) : undefined }));
    if (r) {
      setF({ orderReference: '', amount: '', description: '', expiresInMinutes: '' });
      setShown(r.publicToken);
      void list.reload();
    }
  };

  return (
    <>
      <PageHeader title="Payment requests" subtitle="Create a payment link and QR for one customer, order or invoice." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="New request" className="lg:col-span-1">
          <ErrorBanner error={error} />
          <form onSubmit={create} className="space-y-3">
            <Field label="Order / invoice reference" hint="Must be unique for your account">{(id) => <Input id={id} required maxLength={100} value={f.orderReference} onChange={(e) => setF({ ...f, orderReference: e.target.value })} />}</Field>
            <Field label="Amount (₹)" error={f.amount && minor === null ? 'Enter an amount like 1250 or 1250.50' : undefined}>{(id) => <Input id={id} required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1250.00" />}</Field>
            <Field label="Description">{(id) => <Input id={id} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
            <Field label="Expires after (minutes)" hint="Optional">{(id) => <Input id={id} inputMode="numeric" value={f.expiresInMinutes} onChange={(e) => setF({ ...f, expiresInMinutes: e.target.value.replace(/\D/g, '') })} />}</Field>
            <Button type="submit" busy={busy} disabled={minor === null || !f.orderReference.trim()} className="w-full">Create payment link</Button>
          </form>
        </Card>
        <Card title="Your requests" className="lg:col-span-2">
          <ErrorBanner error={list.error ?? cancel.error} />
          <DataTable rows={list.data} rowKey={(r) => r.id} empty="No payment requests yet." columns={[
            { header: 'Order', cell: (r) => <div>{r.order_reference}<div className="text-xs text-slate-500">{r.description}</div></div> },
            { header: 'Amount', cell: (r) => inr(r.amount_minor), className: 'tabular-nums' },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'Expires', cell: (r) => when(r.expires_at) },
            { header: '', cell: (r) => (
              <div className="flex gap-1">
                {r.status === 'PENDING' && <Button variant="ghost" onClick={() => setShown(r.public_token)}>Link / QR</Button>}
                {r.status === 'PENDING' && <Button variant="ghost" busy={cancel.busy} onClick={() => { if (confirm('Cancel this request? A customer who pays it later will be flagged for review.')) void cancel.run(async () => { await api.post(`/merchant/payment-requests/${r.id}/cancel`); await list.reload(); }); }}>Cancel</Button>}
              </div>
            ) },
          ]} />
        </Card>
      </div>
      {shown && <LinkModal token={shown} onClose={() => setShown(null)} />}
    </>
  );
}

function LinkModal({ token, onClose }: { token: string; onClose: () => void }) {
  const v = useApi<any>(`/public/pay/${encodeURIComponent(token)}`);
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/pay/${token}`;
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Share this payment link" onClose={onClose}>
      <ErrorBanner error={v.error} />
      {v.data?.sandbox && <Notice tone="amber">Sandbox request: the QR leads to a simulated payment page.</Notice>}
      {v.data?.qrImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={v.data.qrImage} alt="Payment QR code" className="mx-auto h-48 w-48" />
      )}
      {v.data && <p className="mt-2 text-center text-sm text-slate-600">{inr(v.data.amountMinor)} for {v.data.merchantName}</p>}
      <div className="mt-4 flex gap-2">
        <Input readOnly value={link} aria-label="Payment link" onFocus={(e) => e.currentTarget.select()} />
        <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* user can copy manually */ } }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <p className="mt-3 text-xs text-slate-500">The request is marked paid only after the platform verifies the money arrived; the customer's own success screen does not count.</p>
      <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Modal>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Modal, Notice, Select, Stat, TextPrompt, useAction, useApi } from '@/components/ui';
import { api, inr, toMinor, when } from '@/lib/api';

type Tab = 'PENDING' | 'PAID' | 'EXPIRED' | 'UNMATCHED' | 'UNDER_REVIEW';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'PENDING', label: 'Pending' },
  { id: 'PAID', label: 'Paid' },
  { id: 'EXPIRED', label: 'Expired' },
  { id: 'UNMATCHED', label: 'Unmatched transactions' },
  { id: 'UNDER_REVIEW', label: 'Needs review' },
];
const PAYEE_KEY = 'gw.payeeVpa';

export default function Collections() {
  const dash = useApi('/admin/collections/dashboard');
  const [tab, setTab] = useState<Tab>('PENDING');
  const orders = useApi<any[]>(tab === 'UNMATCHED' ? null : `/admin/collections/orders?status=${tab}`);
  const credits = useApi<any[]>(tab === 'UNMATCHED' ? '/admin/collections/credits' : null);
  const attest = useApi<any[]>('/admin/collections/attestations');
  const mailbox = useApi('/admin/mailbox/status');
  const [created, setCreated] = useState<any>(null);
  const [attestFor, setAttestFor] = useState<any>(null);
  const [assign, setAssign] = useState<any>(null);
  const [dismiss, setDismiss] = useState<any>(null);
  const act = useAction();

  // The dashboard refreshes itself: confirmations arrive by email, not by a click.
  useEffect(() => {
    const t = setInterval(() => { void dash.reload(); void orders.reload(); void credits.reload(); }, 15000);
    return () => clearInterval(t);
  }, [dash, orders, credits]);
  const reloadAll = () => { void dash.reload(); void orders.reload(); void credits.reload(); void attest.reload(); };
  const d = dash.data;
  const unmatchedRows = (credits.data ?? []).filter((c) => ['UNMATCHED', 'AMBIGUOUS', 'REVIEW'].includes(c.status));
  const connected = mailbox.data?.connection?.status === 'CONNECTED' || mailbox.data?.folderSource;

  return (
    <>
      <PageHeader title="UPI collections" subtitle="Create a UPI QR for an exact amount. An order becomes Paid only when an authenticated bank credit alert matches it." />
      <ErrorBanner error={dash.error ?? act.error} />
      {mailbox.data && !connected && <Notice tone="amber">No bank mailbox is connected, so nothing can be confirmed automatically yet. Orders will stay Pending. Set it up under <a className="underline" href="/admin/mailbox">Bank mailbox</a>.</Notice>}
      <Notice>This confirms that a <strong>signed bank email says money arrived</strong>. It is not a bank API and not a statement reconciliation: check your bank statement for anything important. Payouts and merchant settlement are disabled in this mode.</Notice>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Pending" value={d ? d.pending.count : '…'} hint={d ? inr(d.pending.amountMinor) : undefined} />
        <Stat label="Paid" value={d ? d.paid.count : '…'} tone="good" hint={d ? inr(d.paid.amountMinor) : undefined} />
        <Stat label="Expired" value={d ? d.expired.count : '…'} hint={d ? inr(d.expired.amountMinor) : undefined} />
        <Stat label="Unmatched" value={d ? d.unmatched.count : '…'} tone={d?.unmatched.count ? 'warn' : undefined} hint={d ? inr(d.unmatched.amountMinor) : undefined} />
        <Stat label="Needs review" value={d ? d.underReview.count : '…'} tone={d?.underReview.count ? 'warn' : undefined} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <NewOrder onCreated={(o) => { setCreated(o); reloadAll(); }} />
        <Card title="Orders and transactions" className="lg:col-span-2">
          <div role="tablist" aria-label="Collections" className="mb-4 flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t.id ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}>{t.label}</button>
            ))}
          </div>
          <ErrorBanner error={orders.error ?? credits.error} />
          {tab === 'UNMATCHED' ? (
            <>
              <p className="mb-3 text-sm text-slate-600">Genuine bank credits the system would not attach to an order by itself. The money is held in suspense. Assign it only when the amount equals the order exactly.</p>
              <DataTable rows={credits.data ? unmatchedRows : null} rowKey={(c) => c.id} empty="No unmatched transactions." columns={[
                { header: 'Bank reference', cell: (c) => <code className="text-xs">{c.reference}</code> },
                { header: 'Amount', cell: (c) => inr(c.amount_minor), className: 'tabular-nums' },
                { header: 'Credited', cell: (c) => when(c.credited_at) },
                { header: 'Why held', cell: (c) => <div><Badge tone="amber">{c.status}</Badge><div className="mt-1 text-xs text-slate-600">{String(c.reason ?? '').replace(/_/g, ' ').toLowerCase()}</div></div> },
                { header: 'Payer', cell: (c) => <span className="text-xs">{c.payer_masked ?? '—'}</span> },
                { header: 'Evidence', cell: (c) => <span className="text-xs">{c.evidence === 'BANK_EMAIL' ? 'Bank email' : c.evidence === 'DEVICE_NOTIFICATION' ? 'Phone notification (unverified)' : 'Manual'}</span> },
                { header: '', cell: (c) => (
                  <div className="flex gap-1">
                    <Button variant="secondary" onClick={() => setAssign(c)}>Assign…</Button>
                    <Button variant="ghost" onClick={() => setDismiss(c)}>Dismiss…</Button>
                  </div>
                ) },
              ]} />
            </>
          ) : (
            <DataTable rows={orders.data} rowKey={(o) => o.id} empty={`No ${tab.toLowerCase().replace('_', ' ')} orders.`} columns={[
              { header: 'Order ID', cell: (o) => <code className="text-xs">{o.order_id}</code> },
              { header: 'Reference', cell: (o) => o.order_reference },
              { header: 'Amount', cell: (o) => inr(o.amount_minor), className: 'tabular-nums' },
              { header: 'Pay to', cell: (o) => <span className="text-xs">{o.payee_vpa}</span> },
              { header: 'Status', cell: (o) => <Badge>{o.status}</Badge> },
              { header: tab === 'PAID' ? 'Bank reference' : 'Expires', cell: (o) => (tab === 'PAID' ? <code className="text-xs">{o.paid_reference ?? '—'}</code> : when(o.expires_at)) },
              { header: 'Created', cell: (o) => when(o.created_at) },
              { header: '', cell: (o) => ['PENDING', 'EXPIRED'].includes(o.status) && <Button variant="ghost" onClick={() => setAttestFor(o)}>Alert missing?</Button> },
            ]} />
          )}
        </Card>
      </div>

      {(attest.data ?? []).some((a) => a.status === 'PROPOSED') && (
        <Card title="Manual attestations waiting for a second administrator" className="mt-6">
          <p className="mb-3 text-sm text-slate-600">For payments whose alert never came. These are human attestations, not bank-email evidence, and are labelled that way. You cannot approve your own.</p>
          <DataTable rows={(attest.data ?? []).filter((a) => a.status === 'PROPOSED')} rowKey={(a) => a.id} columns={[
            { header: 'Order', cell: (a) => a.order_reference },
            { header: 'Amount', cell: (a) => inr(a.amount_minor), className: 'tabular-nums' },
            { header: 'Bank reference', cell: (a) => <code className="text-xs">{a.reference}</code> },
            { header: 'Credited', cell: (a) => when(a.credited_at) },
            { header: 'Statement note', cell: (a) => <span className="text-xs">{a.note}</span> },
            { header: '', cell: (a) => (
              <div className="flex gap-1">
                <Button variant="secondary" busy={act.busy} onClick={() => { if (confirm('Approve this manual attestation? The order will be marked PAID on the strength of two administrators checking the bank statement.')) void act.run(async () => { await api.post(`/admin/collections/attestations/${a.id}/decision`, { decision: 'APPLY' }); reloadAll(); }); }}>Approve</Button>
                <Button variant="ghost" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/collections/attestations/${a.id}/decision`, { decision: 'REJECT' }); reloadAll(); })}>Reject</Button>
              </div>
            ) },
          ]} />
        </Card>
      )}

      {created && <CreatedModal order={created} onClose={() => setCreated(null)} />}
      {attestFor && <AttestModal order={attestFor} onClose={() => setAttestFor(null)} onDone={reloadAll} />}
      {assign && <AssignModal credit={assign} onClose={() => setAssign(null)} onDone={reloadAll} />}
      {dismiss && <TextPrompt title="Dismiss this credit" label="Why is it not for any order?" minLength={10} confirmLabel="Dismiss" hint="The money stays in suspense; refund or reclassify it outside this screen." onSubmit={async (note) => { await api.post(`/admin/collections/credits/${dismiss.id}/dismiss`, { note }); reloadAll(); return true; }} onClose={() => setDismiss(null)} />}
    </>
  );
}

function NewOrder({ onCreated }: { onCreated: (o: any) => void }) {
  const [f, setF] = useState({ payeeVpa: '', amount: '', description: '', expiresInMinutes: '60', unique: false });
  const { busy, error, run } = useAction();
  useEffect(() => {
    try { const v = localStorage.getItem(PAYEE_KEY); if (v) setF((x) => ({ ...x, payeeVpa: v })); } catch { /* storage unavailable */ }
  }, []);
  const minor = toMinor(f.amount);
  return (
    <Card title="New UPI payment request">
      <ErrorBanner error={error} />
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        if (minor === null) return;
        const r = await run(() => api.post('/admin/collections/orders', { payeeVpa: f.payeeVpa.trim(), amountMinor: minor, description: f.description.trim() || undefined, expiresInMinutes: Number(f.expiresInMinutes) || undefined, uniqueAmount: f.unique || undefined }));
        if (r) {
          try { localStorage.setItem(PAYEE_KEY, f.payeeVpa.trim()); } catch { /* ignore */ }
          setF({ ...f, amount: '', description: '' });
          onCreated(r);
        }
      }}>
        <Field label="Your UPI ID (who receives the money)" hint="Must belong to the bank account whose alert emails you connect.">{(id) => <Input id={id} required autoComplete="off" placeholder="name@bank" value={f.payeeVpa} onChange={(e) => setF({ ...f, payeeVpa: e.target.value })} />}</Field>
        <Field label="Amount (₹)" error={f.amount && minor === null ? 'Enter an amount like 1250 or 1250.50' : undefined}>{(id) => <Input id={id} required inputMode="decimal" placeholder="1250.00" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        <Field label="Description">{(id) => <Input id={id} maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Valid for (minutes)" hint="A short grace period follows so a delayed bank alert can still confirm it.">{(id) => <Input id={id} inputMode="numeric" value={f.expiresInMinutes} onChange={(e) => setF({ ...f, expiresInMinutes: e.target.value.replace(/\D/g, '') })} />}</Field>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={f.unique} onChange={(e) => setF({ ...f, unique: e.target.checked })} />
          <span>Unique amount (for phone-notification confirmation). A few paise are added so no other open order has the same amount, e.g. ₹10.00 becomes ₹10.01. The customer must pay exactly the amount shown.</span>
        </label>
        <Button type="submit" busy={busy} disabled={minor === null || !f.payeeVpa.trim()} className="w-full">Generate UPI QR</Button>
      </form>
    </Card>
  );
}

function CreatedModal({ order, onClose }: { order: any; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Scan to pay" onClose={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={order.qrImage} alt={`UPI QR for ${order.payeeVpa}`} className="mx-auto h-56 w-56" />
      <dl className="mt-3 grid grid-cols-3 gap-y-1 text-sm">
        {order.baseAmountMinor !== null && order.baseAmountMinor !== undefined && (<><dt className="text-slate-500">Customer pays</dt><dd className="col-span-2 font-semibold">{inr(order.amountMinor)} <span className="font-normal text-slate-500">(order was {inr(order.baseAmountMinor)})</span></dd></>)}
        <dt className="text-slate-500">Order ID</dt><dd className="col-span-2"><code className="text-xs">{order.orderId}</code></dd>
        <dt className="text-slate-500">Pay to</dt><dd className="col-span-2">{order.payeeVpa}</dd>
        <dt className="text-slate-500">Expires</dt><dd className="col-span-2">{when(order.expiresAt)}</dd>
      </dl>
      <Notice>The order id is inside the QR. The payment is confirmed only when your bank&apos;s alert email arrives and verifies; this screen will not change just because someone says they paid.</Notice>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(order.upiLink); setCopied(true); } catch { /* user can copy by hand */ } }}>{copied ? 'Copied' : 'Copy UPI link'}</Button>
        <Button className="ml-auto" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

function AttestModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ reference: '', at: '', note: '' });
  const { busy, error, run } = useAction();
  return (
    <Modal title="Alert missing: attest from the bank statement" onClose={onClose}>
      <Notice tone="amber">Use this only if your bank statement shows the credit but no alert arrived. A second administrator must approve. It is recorded as a manual attestation, not as bank-email evidence.</Notice>
      <ErrorBanner error={error} />
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.post('/admin/collections/attestations', { orderId: order.id, reference: f.reference.trim(), creditedAt: new Date(f.at).toISOString(), note: f.note.trim() }))) { onDone(); onClose(); }
      }}>
        <p className="text-sm text-slate-600">Order <code className="text-xs">{order.order_id}</code>, {inr(order.amount_minor)}</p>
        <Field label="Bank transaction reference (UTR), exactly as on the statement">{(id) => <Input id={id} required value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
        <Field label="Credit date and time on the statement">{(id) => <Input id={id} type="datetime-local" required value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} />}</Field>
        <Field label="Which statement line is this?" hint="Min 10 characters">{(id) => <Input id={id} required minLength={10} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy} disabled={!f.reference || !f.at || f.note.trim().length < 10}>Propose</Button></div>
      </form>
    </Modal>
  );
}

function AssignModal({ credit, onClose, onDone }: { credit: any; onClose: () => void; onDone: () => void }) {
  const orders = useApi<any[]>('/admin/collections/orders');
  const [orderId, setOrderId] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const candidates = (orders.data ?? []).filter((o) => ['PENDING', 'EXPIRED', 'UNDER_REVIEW'].includes(o.status) && Number(o.amount_minor) === Number(credit.amount_minor));
  return (
    <Modal title="Assign credit to an order" onClose={onClose}>
      <ErrorBanner error={error ?? orders.error} />
      <p className="mb-3 text-sm text-slate-600">Credit <code className="text-xs">{credit.reference}</code> for <strong>{inr(credit.amount_minor)}</strong>. Only orders with exactly this amount are listed: a different amount can never count as payment.</p>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/admin/collections/credits/${credit.id}/assign`, { orderId, note: note.trim() }))) { onDone(); onClose(); } }}>
        <Field label="Order">{(id) => (
          <Select id={id} required value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">{candidates.length ? 'Choose…' : 'No order with this exact amount'}</option>
            {candidates.map((o) => <option key={o.id} value={o.id}>{o.order_id} · {o.order_reference} · {o.status.toLowerCase()}</option>)}
          </Select>
        )}</Field>
        <Field label="Why does it belong to this order?" hint="Min 10 characters">{(id) => <Input id={id} required minLength={10} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy} disabled={!orderId || note.trim().length < 10}>Assign</Button></div>
      </form>
    </Modal>
  );
}

'use client';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Notice, Stat, useAction, useApi } from '@/components/ui';
import { api, idempotencyKey, inr, toMinor, when } from '@/lib/api';

export default function Settlements() {
  const bal = useApi('/merchant/balance');
  const me = useApi('/merchant/me');
  const payouts = useApi<any[]>('/merchant/payouts?limit=50');
  const [amount, setAmount] = useState('');
  // One key per form session: pressing the button twice (or a network retry) can never pay out twice.
  const [key, setKey] = useState(() => idempotencyKey());
  const [last, setLast] = useState<any>(null);
  const { busy, error, run } = useAction();
  const b = bal.data;
  const minor = amount.trim() ? toMinor(amount) : undefined;
  const verifiedDest = (me.data?.destinations ?? []).find((d: any) => d.status === 'VERIFIED');
  const bad = amount.trim() !== '' && minor === null;
  const tooMuch = !!b && typeof minor === 'number' && minor > b.availableMinor;
  const groups = useMemo(() => payouts.data ?? [], [payouts.data]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/merchant/payouts', { amountMinor: minor ?? undefined, idempotencyKey: key }));
    if (r) {
      setLast(r);
      setAmount('');
      setKey(idempotencyKey());
      void bal.reload();
      void payouts.reload();
    }
  };

  return (
    <>
      <PageHeader title="Settlements" subtitle="Your balance and payouts to your UPI ID." />
      <ErrorBanner error={bal.error ?? payouts.error ?? me.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Available to pay out" value={b ? inr(b.availableMinor) : '…'} tone="good" />
        <Stat label="In settlement hold" value={b ? inr(b.heldMinor) : '…'} hint="Released automatically" />
        <Stat label="Payouts in progress" value={b ? inr(b.payoutsInFlightMinor) : '…'} />
        <Stat label="Total settled" value={b ? inr(b.payoutsCompletedMinor) : '…'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Request a payout">
          {!verifiedDest ? (
            <Notice tone="amber">No verified UPI ID yet. Add one under Account; it is usable after an administrator verifies it.</Notice>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <p className="text-sm text-slate-600">To <strong>{verifiedDest.masked_account}</strong></p>
              <ErrorBanner error={error} />
              <Field label="Amount (₹)" hint="Leave empty to pay out everything available" error={bad ? 'Enter an amount like 500 or 500.50' : tooMuch ? 'More than your available balance' : undefined}>
                {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={b ? (b.availableMinor / 100).toFixed(2) : ''} />}
              </Field>
              <Button type="submit" busy={busy} disabled={bad || tooMuch || !b || b.availableMinor <= 0} className="w-full">Request payout</Button>
              <p className="text-xs text-slate-500">Large amounts may be split into several transfers and may need administrator approval.</p>
              {last && <Notice tone="green">Payout requested ({last.status === 'UNDER_REVIEW' ? 'held for administrator approval' : 'queued'}).</Notice>}
            </form>
          )}
        </Card>
        <Card title="Payout history" className="lg:col-span-2">
          <DataTable rows={payouts.data ? groups : null} rowKey={(r) => r.id} empty="No payouts yet." columns={[
            { header: 'Requested', cell: (r) => when(r.created_at) },
            { header: 'Amount', cell: (r) => inr(r.amount_minor), className: 'tabular-nums' },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'Reference', cell: (r) => <code className="text-xs">{r.provider_payout_id ?? '—'}</code> },
            { header: 'Note', cell: (r) => <span className="text-xs text-slate-600">{r.failure_reason ? `Returned to your balance: ${r.failure_reason}` : r.is_sandbox ? 'sandbox' : ''}</span> },
          ]} />
        </Card>
      </div>
    </>
  );
}

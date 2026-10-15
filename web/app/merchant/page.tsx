'use client';
import Link from 'next/link';
import { Badge, Card, DataTable, ErrorBanner, Notice, Stat, useApi } from '@/components/ui';
import { PageHeader } from '@/components/providers';
import { inr, when } from '@/lib/api';

export default function MerchantOverview() {
  const me = useApi('/merchant/me');
  const bal = useApi('/merchant/balance');
  const pays = useApi<any[]>('/merchant/payments?limit=100');
  const reqs = useApi<any[]>('/merchant/payment-requests?status=PENDING&limit=100');
  const payouts = useApi<any[]>('/merchant/payouts?limit=50');

  const today = new Date().toDateString();
  const todays = (pays.data ?? []).filter((p) => p.status === 'SUCCEEDED' && new Date(p.created_at).toDateString() === today);
  const attention = [
    ...(pays.data ?? []).filter((p) => ['FAILED', 'UNDER_REVIEW'].includes(p.status)).map((p) => ({ id: p.id, kind: 'Payment', status: p.status, detail: `${inr(p.amount_minor)} ${p.order_reference ?? ''}`, at: p.created_at })),
    ...(payouts.data ?? []).filter((p) => ['FAILED', 'RETURNED', 'UNDER_REVIEW'].includes(p.status)).map((p) => ({ id: p.id, kind: 'Payout', status: p.status, detail: `${inr(p.amount_minor)} ${p.failure_reason ?? ''}`, at: p.created_at })),
  ];
  const b = bal.data;
  const m = me.data;
  const hasVerifiedDest = (m?.destinations ?? []).some((d: any) => d.status === 'VERIFIED');

  return (
    <>
      <PageHeader title="Overview" subtitle={m ? `${m.displayName}` : undefined} />
      <ErrorBanner error={me.error ?? bal.error ?? pays.error} />
      {m?.status === 'PENDING_VERIFICATION' && <Notice tone="amber">Your business is awaiting verification. Payment requests and payouts unlock once an administrator approves it.</Notice>}
      {m?.status === 'SUSPENDED' && <Notice tone="amber">Your account is suspended. Contact support.</Notice>}
      {m?.status === 'ACTIVE' && !hasVerifiedDest && <Notice>Add your UPI ID under <Link className="underline" href="/merchant/account">Account</Link> to receive settlements. An administrator verifies it before payouts can use it.</Notice>}

      <h2 className="mb-2 text-sm font-semibold text-slate-700">Money, in the order it flows</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Verified collections (gross)" value={b ? inr(b.grossCollectionsMinor) : '…'} hint="Confirmed by the platform, before fees" />
        <Stat label="Platform fees" value={b ? inr(b.platformFeesMinor) : '…'} hint="Deducted from collections" />
        <Stat label="Payable to you" value={b ? inr(b.payableMinor) : '…'} hint="Your share not yet paid out" />
        <Stat label="Available to pay out" value={b ? inr(b.availableMinor) : '…'} tone="good" hint={b && b.heldMinor > 0 ? `${inr(b.heldMinor)} still in settlement hold` : 'Excludes any settlement hold'} />
        <Stat label="Payouts in progress" value={b ? inr(b.payoutsInFlightMinor) : '…'} />
        <Stat label="Settled to your bank" value={b ? inr(b.payoutsCompletedMinor) : '…'} />
        <Stat label="Successful payments today" value={pays.data ? todays.length : '…'} hint="Of your 100 most recent" />
        <Stat label="Unpaid payment requests" value={reqs.data ? reqs.data.length : '…'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Needs attention">
          <DataTable rows={pays.data && payouts.data ? attention : null} rowKey={(r) => r.id} empty="Nothing needs attention." columns={[
            { header: 'Type', cell: (r) => r.kind },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'Detail', cell: (r) => r.detail },
            { header: 'When', cell: (r) => when(r.at) },
          ]} />
        </Card>
        <Card title="Recent payments" actions={<Link className="text-sm text-brand-700 underline" href="/merchant/payments">All payments</Link>}>
          <DataTable rows={pays.data ? pays.data.slice(0, 8) : null} rowKey={(r) => r.id} columns={[
            { header: 'Order', cell: (r) => r.order_reference ?? '—' },
            { header: 'Amount', cell: (r) => inr(r.amount_minor), className: 'tabular-nums' },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'When', cell: (r) => when(r.created_at) },
          ]} />
        </Card>
      </div>
    </>
  );
}

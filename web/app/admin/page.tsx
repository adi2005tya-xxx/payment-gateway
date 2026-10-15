'use client';
import Link from 'next/link';
import { PageHeader } from '@/components/providers';
import { Badge, Card, ErrorBanner, Notice, Stat, useApi } from '@/components/ui';
import { inr } from '@/lib/api';

export default function AdminOverview() {
  const o = useApi('/admin/overview');
  const h = useApi('/admin/health');
  const d = o.data;
  const hd = h.data;
  const attention = d ? d.pendingVerificationCases + d.pendingDestinations + d.paymentsUnderReview + d.openRiskReviews : 0;

  return (
    <>
      <PageHeader title="Overview" subtitle="Operational state at a glance." />
      <ErrorBanner error={o.error ?? h.error} />
      {d?.recovery?.moneyOutFrozen && (
        <Notice tone="amber"><strong>Outbound money is frozen.</strong> {d.recovery.reason} <Link className="underline" href="/admin/recovery">Open recovery</Link></Notice>
      )}
      {hd && (hd.unbalancedJournals > 0 || !hd.auditChainValid || hd.deadJobs > 0) && (
        <Notice tone="amber">Integrity warnings: {hd.unbalancedJournals > 0 && `${hd.unbalancedJournals} unbalanced journal(s). `}{!hd.auditChainValid && 'Audit chain does not verify. '}{hd.deadJobs > 0 && `${hd.deadJobs} dead-lettered job(s).`}</Notice>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Verified payments today" value={d ? d.today.payments : '…'} hint={d ? `${inr(d.today.volumeMinor)} volume, ${inr(d.today.feesMinor)} fees` : undefined} />
        <Stat label="Payouts in flight" value={d ? d.payoutsInFlight.count : '…'} hint={d ? inr(d.payoutsInFlight.amountMinor) : undefined} />
        <Stat label="Needs your attention" value={d ? attention : '…'} tone={attention ? 'warn' : 'good'} hint="Verifications, destinations, held payments, risk reviews" />
        <Stat label="Alerts (24h)" value={d ? d.alertsLast24h : '…'} tone={d && d.alertsLast24h ? 'warn' : undefined} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Queues">
          <ul className="divide-y divide-slate-100 text-sm">
            <Row href="/admin/merchants" label="Merchant verification cases" n={d?.pendingVerificationCases} />
            <Row href="/admin/destinations" label="Settlement destinations to verify" n={d?.pendingDestinations} />
            <Row href="/admin/payments?status=UNDER_REVIEW" label="Payments held in suspense" n={d?.paymentsUnderReview} />
            <Row href="/admin/reviews" label="Open risk reviews" n={d?.openRiskReviews} />
          </ul>
        </Card>
        <Card title="System health">
          {!hd ? <p className="text-sm text-slate-500">Loading…</p> : (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Provider</dt><dd>{hd.provider} {hd.sandbox && <Badge tone="amber">SANDBOX</Badge>}</dd>
              <dt className="text-slate-500">Ledger balanced</dt><dd>{hd.unbalancedJournals === 0 ? <Badge tone="green">YES</Badge> : <Badge tone="red">NO</Badge>}</dd>
              <dt className="text-slate-500">Audit chain intact</dt><dd>{hd.auditChainValid ? <Badge tone="green">YES</Badge> : <Badge tone="red">NO</Badge>}</dd>
              <dt className="text-slate-500">Late jobs</dt><dd>{hd.lateJobs}</dd>
              <dt className="text-slate-500">Dead-lettered jobs</dt><dd>{hd.deadJobs}</dd>
              <dt className="text-slate-500">Merchants</dt><dd>{d ? Object.entries(d.merchantsByStatus).map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ') || '—' : '…'}</dd>
            </dl>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ href, label, n }: { href: string; label: string; n?: number }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between py-2 hover:text-brand-700">
        <span>{label}</span>
        <span className={n ? 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900' : 'text-xs text-slate-500'}>{n ?? '…'}</span>
      </Link>
    </li>
  );
}

'use client';
import Link from 'next/link';
import { PageHeader } from '@/components/providers';
import { Badge, Card, DataTable, ErrorBanner, useApi } from '@/components/ui';
import { when } from '@/lib/api';

const WHERE: Record<string, string> = { payment: '/admin/payments?status=UNDER_REVIEW', payout: '/admin/payouts?status=UNDER_REVIEW', destination: '/admin/destinations' };

export default function Reviews() {
  const list = useApi<any[]>('/admin/risk-reviews');
  return (
    <>
      <PageHeader title="Risk reviews" subtitle="Open items the system refused to decide on its own. Resolve each in its own screen." />
      <ErrorBanner error={list.error} />
      <Card>
        <DataTable rows={list.data} rowKey={(r) => r.id} empty="Nothing waiting for review." columns={[
          { header: 'Type', cell: (r) => <Badge tone="blue">{r.subject_type}</Badge> },
          { header: 'Reason', cell: (r) => <span className="text-xs font-medium">{String(r.reason).replace(/,/g, ', ').replace(/_/g, ' ')}</span> },
          { header: 'Detail', cell: (r) => <code className="text-xs text-slate-600">{JSON.stringify(r.detail)}</code> },
          { header: 'Opened', cell: (r) => when(r.created_at) },
          { header: '', cell: (r) => WHERE[r.subject_type] && <Link className="text-sm text-brand-700 underline" href={WHERE[r.subject_type]}>Open</Link> },
        ]} />
      </Card>
    </>
  );
}

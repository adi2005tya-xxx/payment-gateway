'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, useAction, useApi } from '@/components/ui';
import { api, when } from '@/lib/api';

const SEV: Record<string, 'red' | 'amber' | 'slate'> = { LEDGER_UNBALANCED: 'red', AUDIT_CHAIN_BROKEN: 'red', PAYOUT_UNKNOWN_OUTCOME: 'red', RECONCILIATION_DISCREPANCY: 'red', MONEY_OUT_FROZEN: 'red', JOB_DEAD_LETTER: 'red', PAYOUT_RETURNED: 'red', PROVIDER_BALANCE_LOW: 'amber', WEBHOOK_SIGNATURE_FAILURE: 'amber', MFA_LOCKOUT: 'amber', JOBS_LATE: 'amber', WEBHOOK_BACKLOG: 'amber', PAYOUTS_STUCK: 'amber' };

export default function AuditAndAlerts() {
  const [offset, setOffset] = useState(0);
  const audit = useApi<any[]>(`/admin/audit-logs?limit=50&offset=${offset}`);
  const alerts = useApi<any[]>('/admin/alerts');
  const dead = useApi<any[]>('/admin/jobs/dead');
  const act = useAction();
  return (
    <>
      <PageHeader title="Audit log & alerts" subtitle="The audit log is append-only and hash-chained. Alerts are routed to your configured channel; this is the record." />
      <ErrorBanner error={audit.error ?? alerts.error ?? dead.error ?? act.error} />
      <div className="space-y-6">
        <Card title="Recent alerts">
          <DataTable rows={alerts.data ? alerts.data.slice(0, 25) : null} rowKey={(a) => String(a.id)} empty="No alerts." columns={[
            { header: 'When', cell: (a) => when(a.created_at) },
            { header: 'Kind', cell: (a) => <Badge tone={SEV[a.kind] ?? 'slate'}>{a.kind}</Badge> },
            { header: 'Detail', cell: (a) => <code className="text-xs text-slate-600">{JSON.stringify(a.detail)}</code> },
            { header: 'Routed', cell: (a) => (a.routed_at ? 'yes' : 'no') },
          ]} />
        </Card>
        {dead.data && dead.data.length > 0 && (
          <Card title="Dead-lettered jobs">
            <DataTable rows={dead.data} rowKey={(j) => String(j.id)} columns={[
              { header: 'Job', cell: (j) => `${j.kind} #${j.id}` },
              { header: 'Error', cell: (j) => <span className="text-xs">{j.last_error}</span> },
              { header: '', cell: (j) => <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/jobs/${j.id}/replay`); await dead.reload(); })}>Replay</Button> },
            ]} />
          </Card>
        )}
        <Card title="Audit log">
          <DataTable rows={audit.data} rowKey={(a) => String(a.id)} columns={[
            { header: 'When', cell: (a) => when(a.created_at) },
            { header: 'Actor', cell: (a) => <span className="text-xs">{a.actor_role}{a.actor_id ? ` ${String(a.actor_id).slice(0, 8)}` : ''}</span> },
            { header: 'Action', cell: (a) => <code className="text-xs">{a.action}</code> },
            { header: 'Subject', cell: (a) => <span className="text-xs">{a.subject_type} {a.subject_id ? String(a.subject_id).slice(0, 12) : ''}</span> },
            { header: 'Detail', cell: (a) => <code className="text-xs text-slate-600">{JSON.stringify(a.detail)}</code> },
          ]} />
          <div className="mt-4 flex justify-between text-sm">
            <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button>
            <Button variant="secondary" disabled={!audit.data || audit.data.length < 50} onClick={() => setOffset(offset + 50)}>Older</Button>
          </div>
        </Card>
      </div>
    </>
  );
}

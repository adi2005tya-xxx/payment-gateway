'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Notice, Stat, TextPrompt, useAction, useApi } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

export default function Recovery() {
  const st = useApi('/admin/recovery/status');
  const held = useApi<any[]>('/admin/payouts?status=UNDER_REVIEW&limit=100');
  const adoptions = useApi<any[]>('/admin/recovery/adoptions');
  const mfaReqs = useApi<any[]>('/admin/mfa-recovery-requests');
  const act = useAction();
  const [prompt, setPrompt] = useState<null | { kind: 'freeze' } | { kind: 'resolve'; id: string } | { kind: 'mfa'; id: string; decision: 'approve' | 'reject' }>(null);
  const [f, setF] = useState({ providerPayoutId: '', merchantId: '', note: '' });
  const s = st.data;
  const reloadAll = () => { void st.reload(); void held.reload(); void adoptions.reload(); void mfaReqs.reload(); };
  const restoreHeld = (held.data ?? []).filter((p) => p.outcome_unknown);

  return (
    <>
      <PageHeader title="Recovery & restore" subtitle="Controls used after a database restore or failover. Every action here needs a fresh authenticator code and is audited." />
      <ErrorBanner error={st.error ?? act.error} />
      {s?.moneyOutFrozen ? (
        <Notice tone="amber"><strong>Outbound money is frozen</strong> since {when(s.frozenSince)}: {s.reason}. No new payouts or refunds can be requested and queued payouts are not sent.</Notice>
      ) : (
        <Notice tone="green">Outbound money is flowing normally.</Notice>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Payouts in flight" value={s ? s.payoutsInFlight : '…'} />
        <Stat label="Held for review" value={s ? s.payoutsHeldForReview : '…'} tone={s?.payoutsHeldForReview ? 'warn' : undefined} />
        <Stat label="Queued, not sent" value={s ? s.payoutsQueued : '…'} />
        <Stat label="Refunds pending" value={s ? s.refundsPending : '…'} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {s?.moneyOutFrozen ? (
          <Button busy={act.busy} onClick={() => { if (confirm('Release outbound money? This runs a fresh reconciliation first and refuses if anything is unresolved.')) void act.run(async () => { await api.post('/admin/recovery/unfreeze'); reloadAll(); }); }}>Release freeze (runs reconciliation)</Button>
        ) : (
          <Button variant="danger" onClick={() => setPrompt({ kind: 'freeze' })}>Freeze outbound money</Button>
        )}
      </div>

      <div className="mt-6 space-y-6">
        <Card title="Payouts held after a restore">
          <p className="mb-3 text-sm text-slate-600">The provider had no record, or could not be reached, when the system tried to confirm these. Resolve only from provider evidence.</p>
          <DataTable rows={held.data ? restoreHeld : null} rowKey={(p) => p.id} empty="None held." columns={[
            { header: 'Amount', cell: (p) => inr(p.amount_minor) },
            { header: 'Requested', cell: (p) => when(p.created_at) },
            { header: 'Payout', cell: (p) => <code className="text-xs">{String(p.id).slice(0, 8)}</code> },
            { header: '', cell: (p) => (
              <div className="flex gap-1">
                <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/recovery/payouts/${p.id}/resolve`, { outcome: 'sync', note: '' }); reloadAll(); })}>Provider has it: sync</Button>
                <Button variant="ghost" onClick={() => setPrompt({ kind: 'resolve', id: p.id })}>Not sent…</Button>
              </div>
            ) },
          ]} />
        </Card>

        <Card title="Adopt a provider payout the database has no record of">
          <p className="mb-3 text-sm text-slate-600">Appears as <code>ORPHAN_PROVIDER_PAYOUT</code> in reconciliation. One administrator proposes, a different one applies. The amount and status come from the provider, not from you.</p>
          <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api.post('/admin/recovery/adoptions', f))) { setF({ providerPayoutId: '', merchantId: '', note: '' }); reloadAll(); } }}>
            <Field label="Provider payout id">{(id) => <Input id={id} required value={f.providerPayoutId} onChange={(e) => setF({ ...f, providerPayoutId: e.target.value })} />}</Field>
            <Field label="Merchant id">{(id) => <Input id={id} required value={f.merchantId} onChange={(e) => setF({ ...f, merchantId: e.target.value })} />}</Field>
            <Field label="How it was matched" hint="Min 10 characters">{(id) => <Input id={id} required minLength={10} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
            <Button type="submit" busy={act.busy}>Propose</Button>
          </form>
          <div className="mt-4">
            <DataTable rows={adoptions.data} rowKey={(a) => a.id} empty="No adoptions." columns={[
              { header: 'Provider payout', cell: (a) => <code className="text-xs">{a.provider_payout_id}</code> },
              { header: 'Status', cell: (a) => <Badge>{a.status}</Badge> },
              { header: 'Note', cell: (a) => <span className="text-xs">{a.note}</span> },
              { header: 'Proposed', cell: (a) => when(a.created_at) },
              { header: '', cell: (a) => a.status === 'PROPOSED' && (
                <div className="flex gap-1">
                  <Button variant="secondary" busy={act.busy} onClick={() => { if (confirm('Apply this adoption? It posts ledger entries for the provider payout. You must not be the person who proposed it.')) void act.run(async () => { await api.post(`/admin/recovery/adoptions/${a.id}/decision`, { decision: 'APPLY' }); reloadAll(); }); }}>Apply</Button>
                  <Button variant="ghost" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/recovery/adoptions/${a.id}/decision`, { decision: 'REJECT' }); reloadAll(); })}>Reject</Button>
                </div>
              ) },
            ]} />
          </div>
        </Card>

        <Card title="Authenticator recovery requests">
          <p className="mb-3 text-sm text-slate-600">Verify the person outside this system (video call, in person) before approving. After approval a waiting period applies, and the owner signing in cancels the request.</p>
          <DataTable rows={mfaReqs.data} rowKey={(r) => r.id} empty="No requests." columns={[
            { header: 'Account', cell: (r) => r.email },
            { header: 'Status', cell: (r) => <Badge>{r.status}</Badge> },
            { header: 'Requested', cell: (r) => when(r.requested_at) },
            { header: 'Takes effect', cell: (r) => when(r.execute_after) },
            { header: '', cell: (r) => r.status === 'REQUESTED' && (
              <div className="flex gap-1">
                <Button variant="secondary" onClick={() => setPrompt({ kind: 'mfa', id: r.id, decision: 'approve' })}>Approve…</Button>
                <Button variant="danger" onClick={() => setPrompt({ kind: 'mfa', id: r.id, decision: 'reject' })}>Reject…</Button>
              </div>
            ) },
          ]} />
        </Card>
      </div>

      {prompt?.kind === 'freeze' && <TextPrompt title="Freeze outbound money" label="Reason" minLength={5} danger confirmLabel="Freeze" onSubmit={async (reason) => { await api.post('/admin/recovery/freeze', { reason }); reloadAll(); return true; }} onClose={() => setPrompt(null)} />}
      {prompt?.kind === 'resolve' && <ResolveModal id={prompt.id} onDone={reloadAll} onClose={() => setPrompt(null)} />}
      {prompt?.kind === 'mfa' && (
        <TextPrompt title={prompt.decision === 'approve' ? 'Approve authenticator recovery' : 'Reject recovery request'} label={prompt.decision === 'approve' ? 'How did you verify this person?' : 'Reason'} minLength={prompt.decision === 'approve' ? 10 : 3} danger={prompt.decision === 'reject'} confirmLabel={prompt.decision === 'approve' ? 'Approve' : 'Reject'}
          onSubmit={async (note) => { await api.post(`/admin/mfa-recovery-requests/${prompt.id}/${prompt.decision}`, { note }); reloadAll(); return true; }} onClose={() => setPrompt(null)} />
      )}
    </>
  );
}

function ResolveModal({ id, onDone, onClose }: { id: string; onDone: () => void; onClose: () => void }) {
  return (
    <TextPrompt title="Resolve held payout" label="What did you check?" hint="Leave a note describing the statement or provider dashboard check. 'Provider has it' adopts the provider's state; 'Not sent' requeues the payout (nothing is sent until the freeze is released)." minLength={10} confirmLabel="Not sent: requeue"
      onSubmit={async (note) => { await api.post(`/admin/recovery/payouts/${id}/resolve`, { outcome: 'confirmed_not_sent', note }); onDone(); return true; }} onClose={onClose} />
  );
}

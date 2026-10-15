'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Modal, Notice, useAction, useApi } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

const blank = {
  name: '', bankName: '', fromAddresses: '', dkimDomains: '', creditRegex: '', rejectRegexes: 'debited\nreversal\nfailed',
  amount: '', reference: '', timestamp: '', timestampFormat: 'DD-MM-YYYY HH:mm:ss', utcOffset: '+05:30', payer: '', subjectRegex: '',
};

function toDefinition(f: typeof blank) {
  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  return {
    fromAddresses: list(f.fromAddresses),
    dkimDomains: list(f.dkimDomains),
    ...(f.subjectRegex.trim() ? { subjectRegex: f.subjectRegex.trim() } : {}),
    creditRegex: f.creditRegex.trim(),
    rejectRegexes: f.rejectRegexes.split('\n').map((x) => x.trim()).filter(Boolean),
    amount: { regex: f.amount.trim() },
    reference: { regex: f.reference.trim() },
    timestamp: { regex: f.timestamp.trim(), format: f.timestampFormat.trim(), utcOffset: f.utcOffset.trim() || '+05:30' },
    ...(f.payer.trim() ? { payer: { regex: f.payer.trim() } } : {}),
  };
}

function Inner() {
  const params = useSearchParams();
  const status = useApi('/admin/mailbox/status');
  const templates = useApi<any[]>('/admin/alert-templates');
  const messages = useApi<any[]>('/admin/mailbox/messages');
  const act = useAction();
  const [validateFor, setValidateFor] = useState<any>(null);
  const [showNew, setShowNew] = useState(false);
  const s = status.data;
  const reload = () => { void status.reload(); void templates.reload(); void messages.reload(); };
  const connected = params.get('connected');
  const err = params.get('error');

  return (
    <>
      <PageHeader title="Bank mailbox" subtitle="Connect the mailbox that receives your bank's credit alerts (read-only), then describe the alert format." />
      <ErrorBanner error={status.error ?? act.error} />
      {connected && <Notice tone="green">Mailbox connected.</Notice>}
      {err && <Notice tone="amber">Connecting failed ({err}). Nothing was saved. Try again.</Notice>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Gmail connection">
          {!s ? <p className="text-sm text-slate-500">Loading…</p> : (
            <div className="space-y-3 text-sm">
              {s.connection ? (
                <dl className="grid grid-cols-3 gap-y-1">
                  <dt className="text-slate-500">Account</dt><dd className="col-span-2">{s.connection.email}</dd>
                  <dt className="text-slate-500">Status</dt><dd className="col-span-2"><Badge tone={s.connection.status === 'CONNECTED' ? 'green' : 'red'}>{s.connection.status}</Badge></dd>
                  <dt className="text-slate-500">Last check</dt><dd className="col-span-2">{when(s.connection.lastSyncAt)}</dd>
                  <dt className="text-slate-500">Access</dt><dd className="col-span-2">Read-only (<code className="text-xs">gmail.readonly</code>)</dd>
                  {s.connection.lastError && <><dt className="text-slate-500">Problem</dt><dd className="col-span-2 text-red-700">{s.connection.lastError}</dd></>}
                </dl>
              ) : s.folderSource ? (
                <Notice>Reading saved <code>.eml</code> files from a folder (sandbox testing). Gmail is not used.</Notice>
              ) : !s.gmailConfigured ? (
                <Notice tone="amber">Gmail sign-in is not set up on the server. Create an OAuth client in Google Cloud Console (read-only Gmail scope) and set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>GOOGLE_REDIRECT_URI</code>. See docs/bank-email.md.</Notice>
              ) : (
                <p className="text-slate-600">Not connected. You sign in at Google and approve read-only access. This app never sees your mailbox password.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {!s.connection && s.gmailConfigured && <Button busy={act.busy} onClick={async () => { const r = await act.run(() => api.post('/admin/mailbox/connect')); if (r?.url) window.location.href = r.url; }}>Connect Gmail</Button>}
                {s.connection && <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => { await api.post('/admin/mailbox/sync'); reload(); })}>Check now</Button>}
                {s.connection && <Button variant="danger" busy={act.busy} onClick={() => { if (confirm('Disconnect the mailbox? The authorisation is revoked at Google and the stored token deleted. Orders will stop being confirmed.')) void act.run(async () => { await api.post('/admin/mailbox/disconnect'); reload(); }); }}>Disconnect</Button>}
              </div>
              <p className="text-xs text-slate-500">Messages seen: {s.messages?.total ?? 0}, credits recorded: {s.messages?.credits ?? 0}, problems: {s.messages?.problems ?? 0}.</p>
            </div>
          )}
        </Card>

        <UploadEml onDone={reload} />
      </div>

      <Card title="Alert templates" className="mt-6" actions={<Button onClick={() => setShowNew(true)}>New template</Button>}>
        <Notice tone="amber">No bank format is built in. A template tells the system how <strong>your</strong> bank&apos;s credit alert looks, and it can only be activated after it has parsed a real sample email you supply. Until a template is active, no email is trusted.</Notice>
        <DataTable rows={(templates.data ?? []).filter((t) => t.definition?.channel !== 'notification')} rowKey={(t) => t.id} empty="No templates yet." columns={[
          { header: 'Name', cell: (t) => <div>{t.name}<div className="text-xs text-slate-500">{t.bankName}</div></div> },
          { header: 'Sender', cell: (t) => <span className="text-xs">{t.definition.fromAddresses.join(', ')}</span> },
          { header: 'Signed by', cell: (t) => <span className="text-xs">{t.definition.dkimDomains.join(', ')}</span> },
          { header: 'Sample validated', cell: (t) => (t.validatedAt ? <Badge tone="green">YES</Badge> : <Badge tone="amber">NOT YET</Badge>) },
          { header: 'Status', cell: (t) => <Badge>{t.status}</Badge> },
          { header: '', cell: (t) => (
            <div className="flex gap-1">
              {!t.validatedAt && <Button variant="secondary" onClick={() => setValidateFor(t)}>Validate with a real sample…</Button>}
              {t.validatedAt && t.status !== 'ACTIVE' && <Button busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/alert-templates/${t.id}/activate`); reload(); })}>Activate</Button>}
              {t.status === 'ACTIVE' && <Button variant="ghost" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/alert-templates/${t.id}/disable`); reload(); })}>Disable</Button>}
            </div>
          ) },
        ]} />
      </Card>

      <Card title="What happened to each email" className="mt-6">
        <DataTable rows={messages.data} rowKey={(m) => m.id} empty="No emails processed yet." columns={[
          { header: 'Received', cell: (m) => when(m.received_at) },
          { header: 'From', cell: (m) => <span className="text-xs">{m.from_addr ?? '—'}</span> },
          { header: 'Subject', cell: (m) => <span className="text-xs">{m.subject}</span> },
          { header: 'Result', cell: (m) => <Badge tone={m.status === 'CREDIT_RECORDED' ? 'green' : ['AUTH_FAILED', 'UNPARSEABLE', 'REJECTED', 'ERROR'].includes(m.status) ? 'red' : 'slate'}>{m.status}</Badge> },
          { header: 'Reason', cell: (m) => <span className="text-xs text-slate-600">{m.reason}</span> },
        ]} />
        <p className="mt-2 text-xs text-slate-500">Authentication failures on your bank&apos;s address are alerts: someone may be imitating the bank.</p>
      </Card>

      {showNew && <NewTemplate onClose={() => setShowNew(false)} onDone={reload} />}
      {validateFor && <ValidateModal template={validateFor} onClose={() => setValidateFor(null)} onDone={reload} />}
    </>
  );
}

function NewTemplate({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(blank);
  const [sample, setSample] = useState({ subject: '', text: '' });
  const [result, setResult] = useState<any>(null);
  const test = useAction();
  const create = useAction();
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const def = toDefinition(f);
  return (
    <Modal title="New alert template" onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <ErrorBanner error={test.error ?? create.error} />
        <p className="text-xs text-slate-500">Regular expressions are matched against the email text with line breaks and repeated spaces collapsed to single spaces. Put the value you want in the first capture group <code>( )</code>.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Template name">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
          <Field label="Bank name">{(id) => <Input id={id} value={f.bankName} onChange={set('bankName')} />}</Field>
        </div>
        <Field label="Sender address(es)" hint="Exactly as in the From header of the real alert, comma separated">{(id) => <Input id={id} value={f.fromAddresses} onChange={set('fromAddresses')} />}</Field>
        <Field label="DKIM signing domain(s)" hint="The domain in the d= of the real email's DKIM-Signature header (view the original message)">{(id) => <Input id={id} value={f.dkimDomains} onChange={set('dkimDomains')} />}</Field>
        <Field label="A credit is recognised by (regex)">{(id) => <Input id={id} value={f.creditRegex} onChange={set('creditRegex')} />}</Field>
        <Field label="Not a credit if any matches (one regex per line)">{(id) => <textarea id={id} rows={3} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={f.rejectRegexes} onChange={set('rejectRegexes')} />}</Field>
        <Field label="Amount (regex, amount in group 1)">{(id) => <Input id={id} value={f.amount} onChange={set('amount')} />}</Field>
        <Field label="Bank transaction reference (regex, group 1)">{(id) => <Input id={id} value={f.reference} onChange={set('reference')} />}</Field>
        <Field label="Credit date/time text (regex, group 1)">{(id) => <Input id={id} value={f.timestamp} onChange={set('timestamp')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date/time format" hint="Tokens: YYYY MMM MM DD HH hh mm ss A">{(id) => <Input id={id} value={f.timestampFormat} onChange={set('timestampFormat')} />}</Field>
          <Field label="UTC offset of those times">{(id) => <Input id={id} value={f.utcOffset} onChange={set('utcOffset')} />}</Field>
        </div>
        <Field label="Payer (optional regex, stored masked)">{(id) => <Input id={id} value={f.payer} onChange={set('payer')} />}</Field>
        <hr />
        <p className="text-sm font-medium">Try it on a real alert (nothing is credited)</p>
        <Field label="Subject (optional)">{(id) => <Input id={id} value={sample.subject} onChange={(e) => setSample({ ...sample, subject: e.target.value })} />}</Field>
        <Field label="Email text">{(id) => <textarea id={id} rows={5} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={sample.text} onChange={(e) => setSample({ ...sample, text: e.target.value })} />}</Field>
        <Button variant="secondary" busy={test.busy} disabled={!sample.text.trim()} onClick={async () => setResult(await test.run(() => api.post('/admin/alert-templates/test', { definition: def, ...sample })))}>Test on this sample</Button>
        {result && (result.ok
          ? <Notice tone="green">Parsed: {inr(result.credit.amountMinor)}, reference <code>{result.credit.reference}</code>, credited {when(result.credit.creditedAt)}{result.credit.payerMasked ? `, payer ${result.credit.payerMasked}` : ''}. Check these against the email.</Notice>
          : <Notice tone="amber">Not parsed: {String(result.reason).replace(/_/g, ' ').toLowerCase()}. Adjust the expressions.</Notice>)}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button busy={create.busy} disabled={!f.name || !f.bankName || !result?.ok} onClick={async () => { if (await create.run(() => api.post('/admin/alert-templates', { name: f.name.trim(), bankName: f.bankName.trim(), definition: def }))) { onDone(); onClose(); } }}>Save template</Button>
      </div>
    </Modal>
  );
}

function ValidateModal({ template, onClose, onDone }: { template: any; onClose: () => void; onDone: () => void }) {
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={`Validate "${template.name}"`} onClose={onClose}>
      <ErrorBanner error={error} />
      <Notice tone="amber">Paste the text of a <strong>real</strong> credit alert from your bank. By submitting it you attest that it is genuine. The template must parse it completely before it can be activated.</Notice>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/admin/alert-templates/${template.id}/validate`, { subject, text }))) { onDone(); onClose(); } }}>
        <Field label="Subject">{(id) => <Input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <Field label="Email text">{(id) => <textarea id={id} required rows={6} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy} disabled={!text.trim()}>Validate</Button></div>
      </form>
    </Modal>
  );
}

function UploadEml({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [out, setOut] = useState<any>(null);
  return (
    <Card title="Test with a saved email (.eml)">
      <p className="mb-3 text-sm text-slate-600">Download the original bank alert from your mail client as <code>.eml</code> and upload it. It goes through the <strong>full</strong> pipeline: DKIM check against your bank&apos;s published key, sender allowlist, template, and matching. Use it to confirm your template with your real email.</p>
      <ErrorBanner error={error} />
      <input type="file" accept=".eml,message/rfc822" aria-label="Upload .eml" onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        buf.forEach((b) => (bin += String.fromCharCode(b)));
        const r = await run(() => api.post('/admin/mailbox/ingest-eml', { emlBase64: btoa(bin) }));
        if (r) { setOut(r); onDone(); }
        e.target.value = '';
      }} disabled={busy} className="block text-sm" />
      {out && <Notice tone={out.status === 'CREDIT_RECORDED' ? 'green' : 'amber'}>Result: <strong>{out.status}</strong>{out.reason ? ` (${String(out.reason).replace(/_/g, ' ').toLowerCase()})` : ''}{out.creditStatus ? `, credit ${out.creditStatus}` : ''}.</Notice>}
    </Card>
  );
}

export default function MailboxPage() {
  return <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}><Inner /></Suspense>;
}

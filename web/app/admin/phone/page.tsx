'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/providers';
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, Modal, Notice, useAction, useApi } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

const blank = {
  name: '', packages: 'com.phonepe.business', smsSenders: '', creditRegex: '', rejectRegexes: 'refund\nfailed\nreversal\nreversed\ndebited',
  amount: '', reference: '', payer: '', maxRupees: '2000',
};

function toDefinition(f: typeof blank) {
  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return {
    channel: 'notification' as const,
    packages: list(f.packages),
    smsSenders: list(f.smsSenders),
    useReceiptTime: true,
    maxAmountMinor: Math.round(Number(f.maxRupees || '0') * 100),
    creditRegex: f.creditRegex.trim(),
    rejectRegexes: lines(f.rejectRegexes),
    amount: { regex: f.amount.trim() },
    reference: { regex: f.reference.trim() },
    ...(f.payer.trim() ? { payer: { regex: f.payer.trim() } } : {}),
  };
}

export default function PhonePage() {
  const devices = useApi<any[]>('/admin/devices');
  const templates = useApi<any[]>('/admin/alert-templates');
  const messages = useApi<any[]>('/admin/mailbox/messages');
  const act = useAction();
  const [showDevice, setShowDevice] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [validateFor, setValidateFor] = useState<any>(null);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const phoneTemplates = (templates.data ?? []).filter((t) => t.definition?.channel === 'notification');
  const phoneMessages = (messages.data ?? []).filter((m) => m.source === 'device');
  const reload = () => { void devices.reload(); void templates.reload(); void messages.reload(); };

  return (
    <>
      <PageHeader title="Phone notifications" subtitle="Confirm payments from the payment notification on your phone. This is weaker evidence than a signed bank email." />
      <ErrorBanner error={devices.error ?? act.error} />
      <Notice tone="amber">
        <strong>What this proves, and what it does not.</strong> A forwarded phone notification is plain text. Nothing signs it, and this server cannot tell whether it really came from the payment app on your phone.
        To limit the risk: only devices holding a secret token are accepted; only the apps you allow are trusted; each open order gets a slightly different amount so the credit can be matched exactly;
        credits above the per-credit or daily limit are held for you to review; and nothing here releases payouts automatically.
      </Notice>

      <Card title="Forwarding devices" className="mt-6" actions={<Button onClick={() => setShowDevice(true)}>Add device</Button>}>
        <DataTable rows={devices.data} rowKey={(d) => d.id} empty="No devices yet." columns={[
          { header: 'Name', cell: (d) => d.name },
          { header: 'Status', cell: (d) => <Badge tone={d.status === 'ACTIVE' ? 'green' : 'red'}>{d.status}</Badge> },
          { header: 'Last post', cell: (d) => when(d.last_seen_at) },
          { header: 'Added', cell: (d) => when(d.created_at) },
          { header: '', cell: (d) => d.status === 'ACTIVE' && <Button variant="danger" busy={act.busy} onClick={() => { if (confirm(`Revoke "${d.name}"? It stops being accepted immediately.`)) void act.run(async () => { await api.post(`/admin/devices/${d.id}/revoke`); reload(); }); }}>Revoke</Button> },
        ]} />
      </Card>

      <Card title="Notification templates" className="mt-6" actions={<Button onClick={() => setShowTemplate(true)}>New template</Button>}>
        <Notice>A template tells the system how the notification text looks. It can only be activated after it has parsed a <strong>real</strong> notification you paste in. Only one real PhonePe Business example has been seen so far; if wording changes (paise amounts, other message types), unrecognised messages are listed below instead of being trusted.</Notice>
        <DataTable rows={phoneTemplates} rowKey={(t) => t.id} empty="No notification templates yet." columns={[
          { header: 'Name', cell: (t) => t.name },
          { header: 'Trusted apps / senders', cell: (t) => <span className="text-xs">{[...(t.definition.packages ?? []), ...(t.definition.smsSenders ?? [])].join(', ')}</span> },
          { header: 'Max per credit', cell: (t) => inr(t.definition.maxAmountMinor) },
          { header: 'Sample validated', cell: (t) => (t.validatedAt ? <Badge tone="green">YES</Badge> : <Badge tone="amber">NOT YET</Badge>) },
          { header: 'Status', cell: (t) => <Badge>{t.status}</Badge> },
          { header: '', cell: (t) => (
            <div className="flex gap-1">
              {!t.validatedAt && <Button variant="secondary" onClick={() => setValidateFor(t)}>Validate with a real notification…</Button>}
              {t.validatedAt && t.status !== 'ACTIVE' && <Button busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/alert-templates/${t.id}/activate`); reload(); })}>Activate</Button>}
              {t.status === 'ACTIVE' && <Button variant="ghost" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/alert-templates/${t.id}/disable`); reload(); })}>Disable</Button>}
            </div>
          ) },
        ]} />
      </Card>

      <Card title="Setting up the phone" className="mt-6">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
          <li>Add a device above and copy its token. It is shown once; only a hash is kept.</li>
          <li>On the phone, use a notification-forwarding automation app (for example Tasker or MacroDroid). Create a rule that fires on a notification from the payment app and sends an HTTPS <code>POST</code> to <code>{`<your server>/ingest/notification`}</code>.</li>
          <li>Header <code>Authorization: Bearer &lt;token&gt;</code>. JSON body with <code>package</code> (the app&apos;s package name), <code>title</code>, <code>text</code> and <code>postedAt</code> (Unix time in milliseconds). Which variable names give you those values depends on the app and version, so check them in the app itself.</li>
          <li>Test the connection from any computer (replace the values):
            <pre className="mt-1 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{`curl -X POST $SERVER/ingest/notification \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"package":"com.phonepe.business","title":"test","text":"hello","postedAt":'$(date +%s000)'}'`}</pre>
            A <code>UNTRUSTED_SENDER</code>/<code>IGNORED</code> reply means the connection and token work; a 401 means the token is wrong or revoked.</li>
          <li>Create orders with <strong>unique amount</strong> ticked on the Collections page. The customer must pay the exact adjusted amount shown (for example ₹10.01 instead of ₹10).</li>
          <li>Keep notification access and battery optimisation settings so the phone does not silently stop forwarding. If the phone is off or offline, orders simply stay pending (or expire); you can then assign a credit by hand.</li>
        </ol>
      </Card>

      <Card title="What happened to each forwarded notification" className="mt-6">
        <DataTable rows={phoneMessages} rowKey={(m) => m.id} empty="Nothing forwarded yet." columns={[
          { header: 'Received', cell: (m) => when(m.received_at) },
          { header: 'App / sender', cell: (m) => <span className="text-xs">{m.from_addr ?? '—'}</span> },
          { header: 'Title', cell: (m) => <span className="text-xs">{m.subject}</span> },
          { header: 'Result', cell: (m) => <Badge tone={m.status === 'CREDIT_RECORDED' ? 'green' : ['UNPARSEABLE', 'REJECTED', 'ERROR', 'UNTRUSTED_SENDER'].includes(m.status) ? 'red' : 'slate'}>{m.status}</Badge> },
          { header: 'Reason', cell: (m) => <span className="text-xs text-slate-600">{m.reason}</span> },
        ]} />
      </Card>

      {showDevice && <NewDevice onClose={() => setShowDevice(false)} onCreated={(d) => { setCreated(d); setShowDevice(false); reload(); }} />}
      {created && (
        <Modal title={`Token for "${created.name}"`} onClose={() => setCreated(null)}>
          <Notice tone="amber">Copy this now. It will not be shown again. Anyone holding it can submit notifications as this device; revoke the device if it leaks.</Notice>
          <pre className="mt-3 break-all whitespace-pre-wrap rounded bg-slate-100 p-3 text-xs" data-testid="device-token">{created.token}</pre>
          <div className="mt-4 flex justify-end"><Button onClick={() => setCreated(null)}>I have copied it</Button></div>
        </Modal>
      )}
      {showTemplate && <NewTemplate onClose={() => setShowTemplate(false)} onDone={reload} />}
      {validateFor && <ValidateModal template={validateFor} onClose={() => setValidateFor(null)} onDone={reload} />}
    </>
  );
}

function NewDevice({ onClose, onCreated }: { onClose: () => void; onCreated: (d: { name: string; token: string }) => void }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Add forwarding device" onClose={onClose}>
      <ErrorBanner error={error} />
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/admin/devices', { name: name.trim() })); if (r) onCreated({ name: r.name, token: r.token }); }}>
        <Field label="Device name" hint="For example: shop phone">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy} disabled={name.trim().length < 2}>Create</Button></div>
      </form>
    </Modal>
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
    <Modal title="New notification template" onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <ErrorBanner error={test.error ?? create.error} />
        <p className="text-xs text-slate-500">Expressions run against the notification text with repeated spaces collapsed. Put the value you want in the first capture group <code>( )</code>. The credit time is the time the notification arrived.</p>
        <Field label="Template name">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
        <Field label="Trusted app package(s)" hint="Comma separated. A notification from any other app is ignored.">{(id) => <Input id={id} value={f.packages} onChange={set('packages')} />}</Field>
        <Field label="Trusted SMS sender(s) (optional)" hint="Only if you forward SMS instead; use the sender id exactly as shown">{(id) => <Input id={id} value={f.smsSenders} onChange={set('smsSenders')} />}</Field>
        <Field label="A credit is recognised by (regex)">{(id) => <Input id={id} value={f.creditRegex} onChange={set('creditRegex')} />}</Field>
        <Field label="Not a credit if any matches (one regex per line)">{(id) => <textarea id={id} rows={3} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={f.rejectRegexes} onChange={set('rejectRegexes')} />}</Field>
        <Field label="Amount (regex, amount in group 1)">{(id) => <Input id={id} value={f.amount} onChange={set('amount')} />}</Field>
        <Field label="Transaction reference (regex, group 1)">{(id) => <Input id={id} value={f.reference} onChange={set('reference')} />}</Field>
        <Field label="Payer (optional regex, stored masked)">{(id) => <Input id={id} value={f.payer} onChange={set('payer')} />}</Field>
        <Field label="Largest single credit this template will accept (₹)">{(id) => <Input id={id} inputMode="decimal" value={f.maxRupees} onChange={set('maxRupees')} />}</Field>
        <hr />
        <p className="text-sm font-medium">Try it on a real notification (nothing is credited)</p>
        <Field label="Title">{(id) => <Input id={id} value={sample.subject} onChange={(e) => setSample({ ...sample, subject: e.target.value })} />}</Field>
        <Field label="Text">{(id) => <textarea id={id} rows={4} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={sample.text} onChange={(e) => setSample({ ...sample, text: e.target.value })} />}</Field>
        <Button variant="secondary" busy={test.busy} disabled={!sample.text.trim()} onClick={async () => setResult(await test.run(() => api.post('/admin/alert-templates/test', { definition: def, ...sample })))}>Test on this sample</Button>
        {result && (result.ok
          ? <Notice tone="green">Parsed: {inr(result.credit.amountMinor)}, reference <code>{result.credit.reference}</code>{result.credit.payerMasked ? `, payer ${result.credit.payerMasked}` : ''}. Check these against the notification.</Notice>
          : <Notice tone="amber">Not parsed: {String(result.reason).replace(/_/g, ' ').toLowerCase()}. Adjust the expressions.</Notice>)}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button busy={create.busy} disabled={!f.name || !result?.ok} onClick={async () => { if (await create.run(() => api.post('/admin/alert-templates', { name: f.name.trim(), bankName: 'Phone notification', definition: def }))) { onDone(); onClose(); } }}>Save template</Button>
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
      <Notice tone="amber">Paste the title and text of a <strong>real</strong> payment notification from your phone. By submitting it you attest that it is genuine. The template must parse it completely before it can be activated.</Notice>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post(`/admin/alert-templates/${template.id}/validate`, { subject, text }))) { onDone(); onClose(); } }}>
        <Field label="Title">{(id) => <Input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <Field label="Text">{(id) => <textarea id={id} required rows={5} className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" busy={busy} disabled={!text.trim()}>Validate</Button></div>
      </form>
    </Modal>
  );
}

'use client';
import { useState } from 'react';
import { api, saveSession } from '@/lib/api';
import { RecoveryCodesPanel } from './recovery-codes';
import { Badge, Button, Card, ErrorBanner, Field, Input, Notice, useAction, useApi } from './ui';
import { useSession } from './providers';

interface MfaStatus {
  required: boolean;
  enrolled: boolean;
  enrolledAt: string | null;
  sessionVerified: boolean;
  stepUpFresh: boolean;
  recoveryCodesRemaining: number;
}

/** Two-step verification management: enrol / replace the authenticator, regenerate recovery codes. Used by both areas. */
export function MfaSetup() {
  const session = useSession();
  const status = useApi<MfaStatus>('/auth/mfa/status');
  const [stage, setStage] = useState<'idle' | 'scan' | 'codes'>('idle');
  const [qr, setQr] = useState<{ secret: string; qrImage: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const { busy, error, run, setError } = useAction();

  const start = async () => {
    const r = await run(() => api.post('/auth/mfa/enrol/start'));
    if (r) {
      setQr({ secret: r.secret, qrImage: r.qrImage });
      setCode('');
      setStage('scan');
    }
  };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/auth/mfa/enrol/confirm', { code: code.replace(/\s/g, '') }));
    if (r && session) {
      saveSession({ token: r.token, role: session.role }); // every other session of this user was just revoked
      setCodes(r.recoveryCodes);
      setStage('codes');
    }
  };
  const regenerate = async () => {
    const r = await run(() => api.post('/auth/mfa/recovery-codes/regenerate'));
    if (r) {
      setCodes(r.recoveryCodes);
      setStage('codes');
    }
  };

  const s = status.data;
  return (
    <Card title="Two-step verification">
      <ErrorBanner error={error ?? status.error} />
      {stage === 'codes' ? (
        <RecoveryCodesPanel codes={codes} doneLabel="Done" onDone={() => { setStage('idle'); setError(null); void status.reload(); }} />
      ) : stage === 'scan' && qr ? (
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.qrImage} alt="QR code for your authenticator app" className="mx-auto h-44 w-44" />
          <details className="mt-2 text-sm text-slate-600"><summary className="cursor-pointer">Enter the key manually</summary><code className="mt-2 block break-all rounded bg-slate-100 p-2 text-xs">{qr.secret}</code></details>
          <form onSubmit={confirm} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Code from the app">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />}</Field>
            <Button type="submit" busy={busy}>Confirm</Button>
            <Button type="button" variant="secondary" onClick={() => setStage('idle')}>Cancel</Button>
          </form>
        </div>
      ) : !s ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            Status: {s.enrolled ? <Badge tone="green">ENABLED</Badge> : <Badge tone={s.required ? 'red' : 'slate'}>{s.required ? 'REQUIRED, NOT SET UP' : 'NOT ENABLED'}</Badge>}
            {s.enrolledAt && <span className="text-slate-500">since {new Date(s.enrolledAt).toLocaleDateString('en-IN')}</span>}
          </div>
          {s.enrolled && <p className="text-sm text-slate-600">Recovery codes left: <strong>{s.recoveryCodesRemaining}</strong>{s.recoveryCodesRemaining <= 2 && <span className="ml-2 text-amber-700">Generate new codes soon.</span>}</p>}
          {!s.enrolled && <Notice>Protects sign-in and sensitive actions with a code from an authenticator app. Turning it on signs out your other sessions.</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={start} busy={busy} variant={s.enrolled ? 'secondary' : 'primary'}>{s.enrolled ? 'Replace authenticator' : 'Set up'}</Button>
            {s.enrolled && <Button variant="secondary" onClick={regenerate} busy={busy}>New recovery codes</Button>}
          </div>
          {s.enrolled && <p className="text-xs text-slate-500">Replacing the authenticator or generating codes asks for a fresh code first and invalidates the old ones.</p>}
        </div>
      )}
    </Card>
  );
}

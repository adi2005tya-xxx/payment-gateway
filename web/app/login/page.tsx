'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { RecoveryCodesPanel } from '@/components/recovery-codes';
import { Button, ErrorBanner, Field, Input, useAction } from '@/components/ui';
import { api, saveSession } from '@/lib/api';

type Role = 'ADMIN' | 'MERCHANT';
type Step =
  | { name: 'credentials' }
  | { name: 'enrol'; token: string; role: Role; secret: string; qrImage: string }
  | { name: 'codes'; token: string; role: Role; codes: string[] }
  | { name: 'challenge'; token: string; role: Role };

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: 'credentials' });
  const { busy, error, run, setError } = useAction();
  const finish = (token: string, role: Role) => {
    saveSession({ token, role });
    router.replace(role === 'ADMIN' ? '/admin' : '/merchant');
  };

  if (step.name === 'credentials') {
    return (
      <AuthCard
        title="Sign in"
        footer={<>New merchant? <Link className="text-brand-700 underline" href="/register">Create an account</Link></>}
      >
        <ErrorBanner error={error} />
        <CredentialsForm
          busy={busy}
          onSubmit={async (email, password) => {
            const r = await run(() => api.post('/auth/login', { email, password }, { token: null }));
            if (!r) return;
            if (r.mfa === 'NOT_REQUIRED') return finish(r.token, r.role);
            if (r.mfa === 'CHALLENGE_REQUIRED') return setStep({ name: 'challenge', token: r.token, role: r.role });
            const e = await run(() => api.post('/auth/mfa/enrol/start', {}, { token: r.token }));
            if (e) setStep({ name: 'enrol', token: r.token, role: r.role, secret: e.secret, qrImage: e.qrImage });
          }}
        />
      </AuthCard>
    );
  }

  if (step.name === 'enrol') {
    const s = step;
    return (
      <AuthCard title="Set up two-step verification" subtitle="Required for your account. Use any authenticator app (Google Authenticator, Authy, 1Password…).">
        <ErrorBanner error={error} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={s.qrImage} alt="QR code for your authenticator app" className="mx-auto h-48 w-48" />
        <details className="mt-3 text-sm text-slate-600">
          <summary className="cursor-pointer">Can't scan? Enter the key manually</summary>
          <code className="mt-2 block break-all rounded bg-slate-100 p-2 text-xs">{s.secret}</code>
        </details>
        <CodeForm
          label="Enter the 6-digit code from the app"
          busy={busy}
          onSubmit={async (code) => {
            const r = await run(() => api.post('/auth/mfa/enrol/confirm', { code }, { token: s.token }));
            if (r) setStep({ name: 'codes', token: r.token, role: s.role, codes: r.recoveryCodes });
          }}
        />
      </AuthCard>
    );
  }

  if (step.name === 'codes') {
    const s = step;
    return (
      <AuthCard title="Save your recovery codes" subtitle="If you lose your authenticator, each of these single-use codes lets you sign in once. They are shown only now.">
        <RecoveryCodesPanel codes={s.codes} onDone={() => finish(s.token, s.role)} />
      </AuthCard>
    );
  }

  const s = step;
  return (
    <AuthCard title="Two-step verification" subtitle="Enter the code from your authenticator app.">
      <ErrorBanner error={error} />
      <ChallengeForm
        busy={busy}
        onSubmit={async (payload) => {
          const r = await run(() => api.post('/auth/mfa/challenge', payload, { token: s.token }));
          if (r) finish(r.token, s.role);
        }}
        onBack={() => { setError(null); setStep({ name: 'credentials' }); }}
      />
      <p className="mt-4 text-center text-xs text-slate-500">Lost your device? <Link href="/mfa-recovery" className="text-brand-700 underline">Request recovery</Link></p>
    </AuthCard>
  );
}

function CredentialsForm({ busy, onSubmit }: { busy: boolean; onSubmit: (email: string, password: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(email.trim(), password); }} className="space-y-4">
      <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button type="submit" busy={busy} className="w-full">Sign in</Button>
      <p className="text-center text-sm"><Link href="/forgot-password" className="text-brand-700 underline">Forgot password?</Link></p>
    </form>
  );
}

function CodeForm({ label, busy, onSubmit }: { label: string; busy: boolean; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(code.replace(/\s/g, '')); }} className="mt-4 space-y-4">
      <Field label={label}>{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,8}" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />}</Field>
      <Button type="submit" busy={busy} className="w-full">Verify and continue</Button>
    </form>
  );
}

function ChallengeForm({ busy, onSubmit, onBack }: { busy: boolean; onSubmit: (p: { code: string } | { recoveryCode: string }) => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(recovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') }); }} className="space-y-4">
      <Field label={recovery ? 'Recovery code' : 'Authenticator code'}>
        {(id) => <Input id={id} autoFocus inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder={recovery ? 'XXXXX-XXXXX' : '123456'} />}
      </Field>
      <Button type="submit" busy={busy} className="w-full">Verify</Button>
      <div className="flex justify-between text-xs">
        <button type="button" className="text-brand-700 underline" onClick={() => { setRecovery(!recovery); setCode(''); }}>{recovery ? 'Use authenticator code' : 'Use a recovery code'}</button>
        <button type="button" className="text-slate-600 underline" onClick={onBack}>Back</button>
      </div>
    </form>
  );
}

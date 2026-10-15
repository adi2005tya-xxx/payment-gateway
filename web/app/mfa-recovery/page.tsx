'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button, ErrorBanner, Field, Input, Notice, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function MfaRecovery() {
  const [f, setF] = useState({ email: '', password: '' });
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <AuthCard title="Lost your authenticator?" subtitle="Recovery is deliberate and slow, to protect you." footer={<Link className="text-brand-700 underline" href="/login">Back to sign in</Link>}>
      <ErrorBanner error={error} />
      {sent ? (
        <Notice tone="green">Request received. A different administrator must verify you outside this system and approve it, then a waiting period applies (24 hours by default). Signing in with your authenticator or a recovery code at any time cancels the request.</Notice>
      ) : (
        <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/auth/mfa/recovery-request', f, { token: null }))) setSent(true); }} className="space-y-4">
          <Notice>If you still have recovery codes, just sign in with one instead. This request needs your password and approval by another administrator.</Notice>
          <Field label="Email">{(id) => <Input id={id} type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="Password">{(id) => <Input id={id} type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
          <Button type="submit" busy={busy} className="w-full">Request recovery</Button>
        </form>
      )}
    </AuthCard>
  );
}

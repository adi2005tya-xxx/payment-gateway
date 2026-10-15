'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button, ErrorBanner, Field, Input, Notice, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <AuthCard title="Reset your password" footer={<Link className="text-brand-700 underline" href="/login">Back to sign in</Link>}>
      <ErrorBanner error={error} />
      {sent ? (
        <Notice tone="green">If an account exists for that email, a reset link has been sent. It expires in 30 minutes. Resetting your password does not turn off two-step verification.</Notice>
      ) : (
        <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/auth/password-reset/request', { email: email.trim() }, { token: null }))) setSent(true); }} className="space-y-4">
          <Field label="Email">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" busy={busy} className="w-full">Send reset link</Button>
        </form>
      )}
    </AuthCard>
  );
}

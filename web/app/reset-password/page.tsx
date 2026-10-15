'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { Button, ErrorBanner, Field, Input, Notice, useAction } from '@/components/ui';
import { api } from '@/lib/api';

function Form() {
  const token = useSearchParams().get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  if (!token) return <Notice tone="amber">This link is missing its token. Request a new one.</Notice>;
  if (done) return <Notice tone="green">Password changed and all sessions signed out. You can now <Link className="underline" href="/login">sign in</Link>.</Notice>;
  return (
    <>
      <ErrorBanner error={error} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/auth/password-reset/confirm', { token, password: pw }, { token: null }))) setDone(true); }} className="space-y-4">
        <Field label="New password" hint="At least 12 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        <Field label="Repeat password" error={pw2 && pw !== pw2 ? 'Passwords do not match' : undefined}>{(id) => <Input id={id} type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
        <Button type="submit" busy={busy} disabled={!pw || pw !== pw2} className="w-full">Set new password</Button>
      </form>
    </>
  );
}

export default function ResetPassword() {
  return (
    <AuthCard title="Choose a new password">
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}><Form /></Suspense>
    </AuthCard>
  );
}

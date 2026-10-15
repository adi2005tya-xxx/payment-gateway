'use client';
import Link from 'next/link';
import { useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button, ErrorBanner, Field, Input, Notice, useAction } from '@/components/ui';
import { api } from '@/lib/api';

export default function RegisterPage() {
  const [f, setF] = useState({ legalName: '', displayName: '', email: '', password: '' });
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  if (done) {
    return (
      <AuthCard title="Application received" footer={<Link className="text-brand-700 underline" href="/login">Go to sign in</Link>}>
        <Notice tone="green">Your account is pending verification. You can sign in now, but payment requests and payouts stay locked until an administrator approves your business.</Notice>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Create a merchant account" footer={<>Already registered? <Link className="text-brand-700 underline" href="/login">Sign in</Link></>}>
      <ErrorBanner error={error} />
      <form onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/auth/register', f, { token: null }))) setDone(true); }} className="space-y-4">
        <Field label="Registered business name">{(id) => <Input id={id} required minLength={2} value={f.legalName} onChange={set('legalName')} />}</Field>
        <Field label="Display name" hint="Shown to your customers at checkout">{(id) => <Input id={id} required minLength={2} value={f.displayName} onChange={set('displayName')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={f.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 12 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={12} value={f.password} onChange={set('password')} />}</Field>
        <Button type="submit" busy={busy} className="w-full">Create account</Button>
      </form>
    </AuthCard>
  );
}

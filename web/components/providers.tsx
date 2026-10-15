'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, currentSession, onSessionChange, saveSession, setStepUpHandler, Session } from '@/lib/api';
import { Button, ErrorBanner, Field, Input, Modal, cx, useAction } from './ui';

export function useSession(): Session | null {
  return useSyncExternalStore(onSessionChange, () => currentSession(), () => null);
}

/** Mounted once: lets any API call that needs a fresh authenticator code ask for it, then retry. */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        }),
    );
    return () => setStepUpHandler(null);
  }, []);
  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };
  return (
    <>
      {children}
      {open && <StepUpModal onDone={finish} />}
    </>
  );
}

function StepUpModal({ onDone }: { onDone: (ok: boolean) => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const { busy, error, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post('/auth/mfa/step-up', recovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') }));
    if (r) onDone(true);
  };
  return (
    <Modal title="Confirm it's you" onClose={() => onDone(false)}>
      <p className="mb-4 text-sm text-slate-600">This action is high-risk. Enter a current code from your authenticator app to continue.</p>
      <ErrorBanner error={error} />
      <form onSubmit={submit} className="space-y-4">
        <Field label={recovery ? 'Recovery code' : 'Authenticator code'}>
          {(id) => <Input id={id} autoFocus inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder={recovery ? 'XXXXX-XXXXX' : '123456'} />}
        </Field>
        <div className="flex items-center justify-between">
          <button type="button" className="text-xs text-brand-700 underline" onClick={() => { setRecovery(!recovery); setCode(''); }}>
            {recovery ? 'Use authenticator code' : 'Use a recovery code instead'}
          </button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => onDone(false)}>Cancel</Button>
            <Button type="submit" busy={busy} disabled={!code.trim()}>Confirm</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** Redirects unauthenticated visitors to /login and visitors of the wrong area to their own. */
export function RequireRole({ role, children }: { role: 'ADMIN' | 'MERCHANT'; children: ReactNode }) {
  const s = useSession();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (!ready) return;
    if (!s) router.replace('/login');
    else if (s.role !== role) router.replace(s.role === 'ADMIN' ? '/admin' : '/merchant');
  }, [ready, s, role, router]);
  if (!ready || !s || s.role !== role) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  return <>{children}</>;
}

export function Shell({ title, nav, children }: { title: string; nav: Array<{ href: string; label: string }>; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* already invalid: fine */
    }
    saveSession(null);
    router.replace('/login');
  }, [router]);
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <button className="rounded-md p-2 text-slate-700 hover:bg-slate-100 md:hidden" aria-label="Toggle menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button>
            <span className="text-base font-semibold text-slate-900">{title}</span>
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900" title="This build only talks to the simulated sandbox">SANDBOX</span>
          </div>
          <Button variant="ghost" onClick={logout}>Sign out</Button>
        </div>
        <nav aria-label="Main" className={cx('mx-auto max-w-7xl gap-1 overflow-x-auto px-4 pb-2 md:flex', menu ? 'flex flex-col' : 'hidden')}>
          {nav.map((n) => {
            const active = n.href === nav[0].href ? path === n.href : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} onClick={() => setMenu(false)} aria-current={active ? 'page' : undefined} className={cx('whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium', active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
                {n.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

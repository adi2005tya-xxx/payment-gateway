'use client';
import { ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api } from '@/lib/api';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export function Card({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white p-5 shadow-sm', className)}>
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold', tone === 'good' && 'text-emerald-700', tone === 'warn' && 'text-amber-700', tone === 'bad' && 'text-red-700')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  SUCCEEDED: 'green', PAID: 'green', ACTIVE: 'green', VERIFIED: 'green', APPROVED: 'green', SENT: 'green', APPLIED: 'green', COMPLETED: 'green',
  PENDING: 'amber', PROCESSING: 'amber', QUEUED: 'amber', SUBMITTED: 'amber', UNDER_REVIEW: 'amber', PENDING_VERIFICATION: 'amber', PROPOSED: 'amber', REQUESTED: 'amber', OPEN: 'amber', AWAITING_PAYMENT: 'amber', RECEIVED: 'amber',
  FAILED: 'red', REJECTED: 'red', SUSPENDED: 'red', EXPIRED: 'red', RETURNED: 'red', CANCELLED: 'slate', DISABLED: 'slate', REFUNDED: 'slate', PARTIALLY_REFUNDED: 'slate',
};
export function Badge({ children, tone }: { children: string; tone?: 'green' | 'amber' | 'red' | 'slate' | 'blue' }) {
  const t = tone ?? (TONES[children] as any) ?? 'slate';
  const cls = { green: 'bg-emerald-50 text-emerald-800 ring-emerald-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200', red: 'bg-red-50 text-red-800 ring-red-200', slate: 'bg-slate-100 text-slate-700 ring-slate-200', blue: 'bg-blue-50 text-blue-800 ring-blue-200' }[t as 'green'];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', cls)}>{children.replace(/_/g, ' ')}</span>;
}

export function Button({ variant = 'primary', busy, className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean }) {
  const v = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-slate-300',
    secondary: 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300',
    ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
  }[variant];
  return <button {...p} disabled={p.disabled || busy} className={cx('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed', v, className)}>{busy ? 'Working…' : p.children}</button>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{label}</label>
      {children(id)}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}
export const inputCls = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:ring-1 focus:ring-brand-500';
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const m = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{m}</div>;
}
export const Notice = ({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'amber' | 'green' }) => (
  <div className={cx('mb-4 rounded-lg border px-4 py-3 text-sm', tone === 'blue' && 'border-blue-200 bg-blue-50 text-blue-900', tone === 'amber' && 'border-amber-200 bg-amber-50 text-amber-900', tone === 'green' && 'border-emerald-200 bg-emerald-50 text-emerald-900')}>{children}</div>
);

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}
export function DataTable<T>({ rows, columns, empty = 'Nothing to show yet.', rowKey }: { rows: T[] | null; columns: Column<T>[]; empty?: string; rowKey: (r: T) => string }) {
  if (!rows) return <p className="py-6 text-sm text-slate-500">Loading…</p>;
  if (!rows.length) return <p className="py-6 text-sm text-slate-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            {columns.map((c) => <th key={c.header} scope="col" className={cx('whitespace-nowrap px-3 py-2 font-medium', c.className)}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
              {columns.map((c) => <td key={c.header} className={cx('px-3 py-2 align-top', c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Loads a GET endpoint; `reload()` refetches. Errors are surfaced, never swallowed. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** Runs an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

/** Modal asking for a free-text reason/note before a consequential action. */
export function TextPrompt({ title, label, hint, minLength = 0, confirmLabel = 'Confirm', danger, onSubmit, onClose }: {
  title: string; label: string; hint?: string; minLength?: number; confirmLabel?: string; danger?: boolean;
  onSubmit: (text: string) => Promise<unknown>; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={title} onClose={onClose}>
      <ErrorBanner error={error} />
      <form onSubmit={async (e) => { e.preventDefault(); const r = await run(() => onSubmit(text.trim())); if (r !== undefined) onClose(); }} className="space-y-4">
        <Field label={label} hint={hint}>{(id) => <textarea id={id} required={minLength > 0} minLength={minLength || undefined} rows={3} className={inputCls} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy} disabled={text.trim().length < minLength}>{confirmLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

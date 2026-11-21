'use client';
import { useMemo, useState } from 'react';
import { Button, Input, Select, cx } from '@/components/ui';

type Option = { code: string; name: string };

/** Bank codes Razorpay uses for the banks most customers pick; shown as tiles when the account has them enabled. */
const POPULAR = ['SBIN', 'HDFC', 'ICIC', 'UTIB', 'KKBK', 'YESB'];

export function NetbankingPanel({ banks, busy, disabled, onPay, label }: { banks: Option[]; busy: boolean; disabled: boolean; onPay: (p: { method: 'netbanking'; bank: string }) => void; label: string }) {
  const [bank, setBank] = useState('');
  const [q, setQ] = useState('');
  const popular = useMemo(() => POPULAR.map((c) => banks.find((b) => b.code === c)).filter((b): b is Option => !!b), [banks]);
  const filtered = useMemo(() => banks.filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase())), [banks, q]);

  if (banks.length === 0) return <p className="text-sm text-slate-600">Net banking is not enabled for this payment.</p>;
  return (
    <div className="space-y-3">
      {popular.length > 0 && (
        <div role="radiogroup" aria-label="Popular banks" className="grid grid-cols-2 gap-2">
          {popular.map((b) => (
            <button
              key={b.code}
              type="button"
              role="radio"
              aria-checked={bank === b.code}
              onClick={() => setBank(b.code)}
              className={cx('rounded-lg border px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-brand-500', bank === b.code ? 'border-brand-600 bg-brand-50' : 'border-slate-300 bg-white hover:bg-slate-50')}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}
      <label className="block text-xs font-medium text-slate-600" htmlFor="bank-search">Other banks</label>
      <Input id="bank-search" placeholder="Search your bank" value={q} onChange={(e) => setQ(e.target.value)} />
      <Select aria-label="Choose your bank" value={bank} onChange={(e) => setBank(e.target.value)} size={Math.min(6, Math.max(2, filtered.length))}>
        {filtered.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
      </Select>
      <Button type="button" busy={busy} disabled={disabled || busy || !bank} className="w-full" onClick={() => onPay({ method: 'netbanking', bank })}>{label}</Button>
      <p className="text-xs text-slate-500">You will be taken to your bank to log in and approve the payment.</p>
    </div>
  );
}

export function WalletPanel({ wallets, busy, disabled, onPay, label }: { wallets: Option[]; busy: boolean; disabled: boolean; onPay: (p: { method: 'wallet'; wallet: string }) => void; label: string }) {
  const [wallet, setWallet] = useState('');
  if (wallets.length === 0) return <p className="text-sm text-slate-600">Wallets are not enabled for this payment.</p>;
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Wallets" className="grid grid-cols-2 gap-2">
        {wallets.map((w) => (
          <button
            key={w.code}
            type="button"
            role="radio"
            aria-checked={wallet === w.code}
            onClick={() => setWallet(w.code)}
            className={cx('rounded-lg border px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-brand-500', wallet === w.code ? 'border-brand-600 bg-brand-50' : 'border-slate-300 bg-white hover:bg-slate-50')}
          >
            {w.name}
          </button>
        ))}
      </div>
      <Button type="button" busy={busy} disabled={disabled || busy || !wallet} className="w-full" onClick={() => onPay({ method: 'wallet', wallet })}>{label}</Button>
    </div>
  );
}

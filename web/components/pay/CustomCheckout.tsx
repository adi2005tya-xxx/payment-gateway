'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ErrorBanner, Field, Input, Notice, cx } from '@/components/ui';
import { API_URL, api, inr } from '@/lib/api';
import { useRazorpay } from '@/lib/razorpay';
import { CardForm, CardPayload } from './CardForm';
import { NetbankingPanel, WalletPanel } from './BankWalletPanels';
import { UpiPanel, findUpiUrl, isMobile } from './UpiPanel';

export interface CheckoutParams {
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  merchantName: string;
  description: string;
}

type Tab = 'upi' | 'card' | 'netbanking' | 'wallet';
const TAB_LABEL: Record<Tab, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallets' };

/**
 * Our own payment screen. Razorpay only processes the payment in the background through razorpay.js.
 * "Paid" is never decided here: after the processor reports success we ask the API to verify the signature and re-check the payment with the
 * provider, then the parent page shows PAID only when the platform's own record says so.
 */
export function CustomCheckout({ params, onSubmitted }: { params: CheckoutParams; onSubmitted: () => void }) {
  const { razorpay, methods, ready, error: loadError } = useRazorpay(params.keyId);
  const [tab, setTab] = useState<Tab>('upi');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'form' | 'verifying' | 'submitted' | 'rejected'>('form');
  const [message, setMessage] = useState<string | null>(null);
  const [upiUrl, setUpiUrl] = useState<string | null>(null);
  const [upiWaiting, setUpiWaiting] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const contactErr = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ? '' : 'Enter a valid email',
    phone: /^[6-9]\d{9}$/.test(phone) ? '' : 'Enter a 10-digit mobile number',
  };
  const contactOk = !contactErr.email && !contactErr.phone;

  const tabs: Tab[] = methods ? (['upi', 'card', 'netbanking', 'wallet'] as Tab[]).filter((t) => (t === 'upi' ? methods.upi : t === 'card' ? methods.card : t === 'netbanking' ? methods.netbanking.length > 0 : methods.wallet.length > 0)) : [];
  useEffect(() => {
    if (tabs.length && !tabs.includes(tab)) setTab(tabs[0]);
  }, [tabs.join(','), tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // razorpay.js events. Handlers live in a ref so the listeners (registered once) always see current state.
  const handlers = useRef<{ success: (d: any) => void; error: (d: any) => void; upi: (d: any) => void }>({ success: () => undefined, error: () => undefined, upi: () => undefined });
  handlers.current.success = async (d) => {
    setPhase('verifying');
    try {
      await api.post(`/pay/razorpay/verify`, { orderId: d?.razorpay_order_id, paymentId: d?.razorpay_payment_id, signature: d?.razorpay_signature }, { token: null });
      setPhase('submitted');
      onSubmitted();
    } catch {
      setPhase('rejected');
    } finally {
      setBusy(false);
    }
  };
  handlers.current.error = (d) => {
    setBusy(false);
    setUpiWaiting(false);
    setMessage(String(d?.error?.description ?? 'The payment did not go through.') + ' You have not been charged for a failed attempt. You can try again.');
  };
  handlers.current.upi = (d) => {
    const url = findUpiUrl(d);
    if (!url) return;
    setUpiWaiting(false);
    setBusy(false);
    if (isMobile()) window.location.href = url;
    else setUpiUrl(url);
  };

  useEffect(() => {
    if (!ready || !razorpay.current) return;
    const rz = razorpay.current;
    rz.on('payment.success', (d) => handlers.current.success(d));
    rz.on('payment.error', (d) => handlers.current.error(d));
    rz.on('payment.upi.intent_response', (d) => handlers.current.upi(d));
    rz.on('payment.upi.coproto_response', (d) => handlers.current.upi(d));
  }, [ready, razorpay]);

  // If UPI never returns a link (not enabled for custom checkout, or a response shape we do not recognise), say so instead of spinning.
  useEffect(() => {
    if (!upiWaiting) return;
    const t = setTimeout(() => {
      setUpiWaiting(false);
      setBusy(false);
      setMessage('We could not start UPI here. Use the secure payment page instead.');
    }, 10_000);
    return () => clearTimeout(t);
  }, [upiWaiting]);

  const pay = useCallback(
    (extra: Record<string, unknown>) => {
      setTouched(true);
      setErr(null);
      setMessage(null);
      if (!contactOk || !razorpay.current) return;
      setBusy(true);
      try {
        razorpay.current.createPayment({
          amount: params.amountMinor,
          currency: params.currency,
          order_id: params.orderId,
          email: email.trim(),
          contact: `+91${phone}`,
          ...extra,
        });
      } catch (e) {
        setBusy(false);
        setErr(e);
      }
    },
    [contactOk, razorpay, params, email, phone],
  );

  const startUpi = () => {
    setUpiUrl(null);
    setUpiWaiting(true);
    pay({ method: 'upi', '_[flow]': 'intent' });
  };

  if (phase === 'verifying') return <Notice>Checking your payment…</Notice>;
  if (phase === 'submitted') {
    return (
      <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900">
        <p className="font-medium">Payment received</p>
        <p className="mt-1">We are confirming it with the bank. This page updates by itself, so there is no need to pay again.</p>
      </div>
    );
  }
  if (phase === 'rejected') {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-medium">We could not verify this payment</p>
        <p className="mt-1">Do not pay again. If money left your account it is refunded automatically, or contact {params.merchantName} with your payment details.</p>
      </div>
    );
  }

  const label = `Pay ${inr(params.amountMinor)}`;
  const fallback = `${API_URL}/pay/razorpay/${encodeURIComponent(params.orderId)}`;

  return (
    <div className="mt-5 space-y-4">
      <ErrorBanner error={err ?? (loadError ? new Error(loadError) : null)} />

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your details</legend>
        <Field label="Email" error={touched ? contactErr.email : ''}>
          {(id) => <Input id={id} type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Mobile number" error={touched ? contactErr.phone : ''}>
          {(id) => (
            <div className="flex gap-2">
              <span className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-600">+91</span>
              <Input id={id} inputMode="numeric" autoComplete="tel-national" placeholder="9876543210" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            </div>
          )}
        </Field>
      </fieldset>

      {!ready && !loadError && <p className="text-sm text-slate-500" role="status">Loading payment options…</p>}

      {ready && tabs.length === 0 && <Notice tone="amber">No payment methods are available right now. <a className="underline" href={fallback}>Use the secure payment page</a>.</Notice>}

      {ready && tabs.length > 0 && (
        <>
          <div role="tablist" aria-label="Payment method" className="flex flex-wrap gap-2">
            {tabs.map((t) => (
              <button
                key={t}
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`panel-${t}`}
                type="button"
                onClick={() => { setTab(t); setMessage(null); }}
                className={cx('rounded-full border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500', tab === t ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'upi' && <UpiPanel busy={busy} disabled={false} upiUrl={upiUrl} onStart={startUpi} label={label} onGiveUp={() => { setUpiUrl(null); setBusy(false); }} />}
            {tab === 'card' && <CardForm busy={busy} disabled={false} label={label} onPay={(p: CardPayload) => pay({ ...p })} />}
            {tab === 'netbanking' && methods && <NetbankingPanel banks={methods.netbanking} busy={busy} disabled={false} label={label} onPay={(p) => pay({ ...p })} />}
            {tab === 'wallet' && methods && <WalletPanel wallets={methods.wallet} busy={busy} disabled={false} label={label} onPay={(p) => pay({ ...p })} />}
          </div>
        </>
      )}

      {message && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {message} <a className="underline" href={fallback}>Use the secure payment page</a>
        </div>
      )}
    </div>
  );
}

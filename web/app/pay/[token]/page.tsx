'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, ErrorBanner, Notice, useAction } from '@/components/ui';
import { api, inr, when } from '@/lib/api';

interface PublicView {
  merchantName: string;
  amountMinor: number;
  currency: string;
  description: string;
  status: 'AWAITING_PAYMENT' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'UNDER_REVIEW' | string;
  expiresAt: string | null;
  sandbox: boolean;
  sandboxOrderId?: string;
  qrImage?: string;
  payLink?: string;
}

/** Customer checkout. "Paid" is shown only after the platform has verified the credit; nothing on this page can mark a payment paid. */
export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const [v, setV] = useState<PublicView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const sim = useAction();

  const load = useCallback(async () => {
    try {
      setV(await api.get<PublicView>(`/public/pay/${encodeURIComponent(token)}`, { token: null }));
      setErr(null);
    } catch (e) {
      setErr(e);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (v?.status !== 'AWAITING_PAYMENT' && v?.status !== 'UNDER_REVIEW') return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [v?.status, load]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-4">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <ErrorBanner error={err} />
        {!v && !err && <p className="text-sm text-slate-500">Loading…</p>}
        {v && (
          <>
            {v.sandbox && <Notice tone="amber">SANDBOX: this is a simulated payment page. No real money moves.</Notice>}
            <p className="text-sm text-slate-600">Pay</p>
            <h1 className="text-lg font-semibold">{v.merchantName}</h1>
            <p className="mt-3 text-3xl font-semibold tabular-nums">{inr(v.amountMinor)}</p>
            {v.description && <p className="mt-1 text-sm text-slate-600">{v.description}</p>}
            {v.expiresAt && v.status === 'AWAITING_PAYMENT' && <p className="mt-1 text-xs text-slate-500">Valid until {when(v.expiresAt)}</p>}

            {v.status === 'PAID' && <Notice tone="green"><strong>Payment confirmed.</strong> {v.merchantName} has been notified. You can close this page.</Notice>}
            {v.status === 'EXPIRED' && <Notice tone="amber">This payment link has expired. Ask {v.merchantName} for a new one. If you already paid, keep your UPI receipt and contact them.</Notice>}
            {v.status === 'CANCELLED' && <Notice tone="amber">This payment request was cancelled by the merchant. Do not pay it.</Notice>}
            {v.status === 'UNDER_REVIEW' && <Notice>We received a payment for this request and are checking it. This can take a little while; you do not need to pay again.</Notice>}

            {v.status === 'AWAITING_PAYMENT' && (
              <div className="mt-5">
                {v.qrImage && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.qrImage} alt={`UPI QR code to pay ${inr(v.amountMinor)} to ${v.merchantName}`} className="mx-auto h-56 w-56" />
                )}
                {v.payLink && (
                  <a href={v.payLink} className="mt-4 block rounded-lg bg-brand-600 px-4 py-3 text-center text-sm font-medium text-white hover:bg-brand-700">
                    Pay with your UPI app
                  </a>
                )}
                <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-slate-600">
                  <li>Pay the exact amount shown. Do not change the amount or the payment note: they identify your payment.</li>
                  <li>The account name in your UPI app may differ from the business name; that is expected.</li>
                  <li>This page updates by itself once your payment is verified. A success screen in your UPI app is not the confirmation.</li>
                </ul>
                <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><Badge>AWAITING_PAYMENT</Badge> Checking every few seconds…</p>

                {v.sandbox && v.sandboxOrderId && (
                  <div className="mt-5 rounded-lg border border-dashed border-amber-300 p-3">
                    <p className="mb-2 text-xs font-medium text-amber-900">Sandbox tools</p>
                    <ErrorBanner error={sim.error} />
                    <div className="flex gap-2">
                      <Button variant="secondary" busy={sim.busy} onClick={() => sim.run(() => api.post(`/sandbox/pay/${encodeURIComponent(v.sandboxOrderId!)}`, { outcome: 'captured' }, { token: null }))}>Simulate payment</Button>
                      <Button variant="ghost" busy={sim.busy} onClick={() => sim.run(() => api.post(`/sandbox/pay/${encodeURIComponent(v.sandboxOrderId!)}`, { outcome: 'failed' }, { token: null }))}>Simulate failure</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

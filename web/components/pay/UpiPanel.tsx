'use client';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';

export const isMobile = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const QR_SECONDS = 15 * 60;

/** Finds a UPI deep link in whatever shape razorpay.js reports its intent response in. */
export function findUpiUrl(v: unknown, depth = 0): string | null {
  if (depth > 4 || v == null) return null;
  if (typeof v === 'string') return /^(upi|intent|phonepe|tez|paytmmp|gpay):/i.test(v) ? v : null;
  if (typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const f = findUpiUrl(x, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

/**
 * UPI: on a phone, opens the customer's UPI app (intent). On a desktop, shows a QR in our own UI; the page polls the platform for the verified result.
 * UPI Collect (typing a UPI ID) is intentionally not offered.
 */
export function UpiPanel({ busy, disabled, upiUrl, onStart, label, onGiveUp }: { busy: boolean; disabled: boolean; upiUrl: string | null; onStart: () => void; label: string; onGiveUp: () => void }) {
  const mobile = isMobile();
  const [qr, setQr] = useState<string | null>(null);
  const [left, setLeft] = useState(QR_SECONDS);

  useEffect(() => {
    if (!upiUrl || mobile) return;
    let off = false;
    QRCode.toDataURL(upiUrl, { margin: 1, width: 224, errorCorrectionLevel: 'M' }).then((u) => !off && setQr(u)).catch(() => undefined);
    setLeft(QR_SECONDS);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => {
      off = true;
      clearInterval(t);
    };
  }, [upiUrl, mobile]);

  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  if (upiUrl && !mobile) {
    return (
      <div className="space-y-3 text-center">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="UPI QR code. Scan it with any UPI app to pay." className="mx-auto h-56 w-56" />
        ) : (
          <p className="text-sm text-slate-500">Preparing QR…</p>
        )}
        <p className="text-sm text-slate-700">Scan with any UPI app</p>
        <p className="text-xs tabular-nums text-slate-500" aria-live="off">{left > 0 ? `Expires in ${mm}:${ss}` : 'QR expired'}</p>
        {left === 0 && <Button type="button" onClick={onGiveUp} variant="secondary">Get a new QR</Button>}
        <p className="text-xs text-slate-500">This page updates by itself once your payment is confirmed.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Button type="button" busy={busy} disabled={disabled || busy} className="w-full" onClick={onStart}>{mobile ? 'Open my UPI app' : 'Show QR code'}</Button>
      <p className="text-xs text-slate-500">{mobile ? 'Your UPI app opens with the amount filled in. Approve the payment there, then come back.' : 'A QR code appears here. Scan it with the UPI app on your phone.'}</p>
    </div>
  );
}

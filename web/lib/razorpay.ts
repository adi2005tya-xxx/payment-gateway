'use client';
import { useEffect, useRef, useState } from 'react';

/** Minimal typings for razorpay.js (Custom Checkout). Loaded from Razorpay's CDN only; never self-hosted. */
export interface RazorpayInstance {
  once(event: 'ready', cb: (res: { methods?: Record<string, unknown> }) => void): void;
  on(event: string, cb: (data: any) => void): void;
  off?(event: string, cb?: (data: any) => void): void;
  createPayment(data: Record<string, unknown>, opts?: Record<string, unknown>): void;
}
declare global {
  interface Window {
    Razorpay?: new (opts: { key: string }) => RazorpayInstance;
  }
}

const SRC = 'https://checkout.razorpay.com/v1/razorpay.js';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Razorpay) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the payment script. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface Methods {
  upi: boolean;
  card: boolean;
  netbanking: Array<{ code: string; name: string }>;
  wallet: Array<{ code: string; name: string }>;
}

const WALLET_NAMES: Record<string, string> = { olamoney: 'Ola Money', freecharge: 'Freecharge', mobikwik: 'MobiKwik', amazonpay: 'Amazon Pay', airtelmoney: 'Airtel Money', jiomoney: 'JioMoney', payzapp: 'PayZapp', phonepe: 'PhonePe', paytm: 'Paytm' };

function list(v: unknown, names?: Record<string, string>): Array<{ code: string; name: string }> {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((c) => ({ code: String(c), name: names?.[String(c)] ?? String(c) }));
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== false && val != null)
      .map(([code, val]) => ({ code, name: typeof val === 'string' ? val : names?.[code] ?? code }));
  }
  return [];
}

export function normalizeMethods(m: Record<string, unknown> | undefined): Methods {
  return {
    upi: !!m?.upi,
    card: !!m?.card,
    netbanking: list(m?.netbanking).sort((a, b) => a.name.localeCompare(b.name)),
    wallet: list(m?.wallet, WALLET_NAMES),
  };
}

/** Loads razorpay.js once, creates the instance and reports which methods the account has enabled. Render only what is enabled. */
export function useRazorpay(keyId: string | null) {
  const ref = useRef<RazorpayInstance | null>(null);
  const [methods, setMethods] = useState<Methods | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!keyId) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !window.Razorpay) return;
        const rz = new window.Razorpay({ key: keyId });
        ref.current = rz;
        rz.once('ready', (res) => {
          if (cancelled) return;
          setMethods(normalizeMethods(res?.methods));
          setReady(true);
        });
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Payment script failed to load'));
    return () => {
      cancelled = true;
    };
  }, [keyId]);

  return { razorpay: ref, methods, ready, error };
}

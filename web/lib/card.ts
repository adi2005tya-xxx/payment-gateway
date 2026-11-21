/** Card input helpers. Card data stays in the browser and goes only to razorpay.js; nothing here is sent to our API. */

export type CardBrand = 'visa' | 'mastercard' | 'rupay' | 'amex' | 'diners' | 'maestro' | 'unknown';

export const digitsOnly = (s: string) => s.replace(/\D/g, '');

export function luhnValid(num: string): boolean {
  const d = digitsOnly(num);
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function cardBrand(num: string): CardBrand {
  const d = digitsOnly(num);
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return 'mastercard';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^3(0[0-5]|[68])/.test(d)) return 'diners';
  if (/^(60|65|81|82|508)/.test(d)) return 'rupay';
  if (/^(50|5[6-9]|6)/.test(d)) return 'maestro';
  return 'unknown';
}

export const BRAND_LABEL: Record<CardBrand, string> = { visa: 'Visa', mastercard: 'Mastercard', rupay: 'RuPay', amex: 'American Express', diners: 'Diners Club', maestro: 'Maestro', unknown: '' };

/** Groups digits for display: 4-6-5 for Amex, 4-4-4-4 otherwise. */
export function formatCardNumber(raw: string): string {
  const d = digitsOnly(raw).slice(0, cardBrand(raw) === 'amex' ? 15 : 19);
  if (cardBrand(d) === 'amex') return [d.slice(0, 4), d.slice(4, 10), d.slice(10)].filter(Boolean).join(' ');
  return (d.match(/.{1,4}/g) ?? []).join(' ');
}

export function formatExpiry(raw: string): string {
  const d = digitsOnly(raw).slice(0, 4);
  return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; // no auto "/" at 2 digits, so Backspace never gets stuck
}

export function parseExpiry(v: string): { month: string; year: string } | null {
  const m = /^(\d{2})\/(\d{2})$/.exec(v);
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  const year = 2000 + Number(m[2]);
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return null;
  return { month: m[1], year: String(year) };
}

export const cvvLength = (num: string) => (cardBrand(num) === 'amex' ? 4 : 3);

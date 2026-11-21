'use client';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { BRAND_LABEL, cardBrand, cvvLength, formatCardNumber, formatExpiry, luhnValid, parseExpiry } from '@/lib/card';

export interface CardPayload {
  method: 'card';
  'card[name]': string;
  'card[number]': string;
  'card[cvv]': string;
  'card[expiry_month]': string;
  'card[expiry_year]': string;
}

/** Card details stay in this component's state and go straight to razorpay.js through onPay. They are never sent to our API. */
export function CardForm({ busy, disabled, onPay, label }: { busy: boolean; disabled: boolean; onPay: (p: CardPayload) => void; label: string }) {
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [touched, setTouched] = useState(false);

  const brand = cardBrand(number);
  const exp = parseExpiry(expiry);
  const errors = {
    name: name.trim().length < 2 ? 'Enter the name on the card' : '',
    number: !luhnValid(number) ? 'Enter a valid card number' : '',
    expiry: !exp ? 'Use MM/YY, not in the past' : '',
    cvv: cvv.length !== cvvLength(number) ? `${cvvLength(number)} digits` : '',
  };
  const valid = !errors.name && !errors.number && !errors.expiry && !errors.cvv;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || !exp) return;
    onPay({
      method: 'card',
      'card[name]': name.trim(),
      'card[number]': number.replace(/\s/g, ''),
      'card[cvv]': cvv,
      'card[expiry_month]': exp.month,
      'card[expiry_year]': exp.year,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate autoComplete="on">
      <Field label="Card number" error={touched ? errors.number : ''}>
        {(id) => (
          <div className="relative">
            <Input id={id} inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456" value={number} onChange={(e) => setNumber(formatCardNumber(e.target.value))} />
            {brand !== 'unknown' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-500">{BRAND_LABEL[brand]}</span>}
          </div>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expiry" error={touched ? errors.expiry : ''}>
          {(id) => <Input id={id} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={expiry} onChange={(e) => setExpiry(formatExpiry(e.target.value))} />}
        </Field>
        <Field label="CVV" error={touched ? errors.cvv : ''}>
          {(id) => <Input id={id} inputMode="numeric" type="password" autoComplete="cc-csc" placeholder="123" maxLength={4} value={cvv} onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, cvvLength(number)))} />}
        </Field>
      </div>
      <Field label="Name on card" error={touched ? errors.name : ''}>
        {(id) => <Input id={id} autoComplete="cc-name" placeholder="As printed on the card" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Button type="submit" busy={busy} disabled={disabled || busy} className="w-full">{label}</Button>
      <p className="text-xs text-slate-500">Your card details are sent securely to the payment processor and are not stored by this site.</p>
    </form>
  );
}

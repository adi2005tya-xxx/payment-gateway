'use client';
import { ReactNode } from 'react';
import { RequireRole, Shell } from '@/components/providers';

const NAV = [
  { href: '/merchant', label: 'Overview' },
  { href: '/merchant/payments', label: 'Payments' },
  { href: '/merchant/requests', label: 'Payment requests' },
  { href: '/merchant/settlements', label: 'Settlements' },
  { href: '/merchant/account', label: 'Account & security' },
];

export default function MerchantLayout({ children }: { children: ReactNode }) {
  return (
    <RequireRole role="MERCHANT">
      <Shell title="Merchant dashboard" nav={NAV}>{children}</Shell>
    </RequireRole>
  );
}

'use client';
import { ReactNode } from 'react';
import { RequireRole, Shell } from '@/components/providers';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/collections', label: 'UPI collections' },
  { href: '/admin/mailbox', label: 'Bank mailbox' },
  { href: '/admin/phone', label: 'Phone notifications' },
  { href: '/admin/merchants', label: 'Merchants' },
  { href: '/admin/destinations', label: 'Destinations' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/payouts', label: 'Payouts' },
  { href: '/admin/reviews', label: 'Risk reviews' },
  { href: '/admin/reconciliation', label: 'Reconciliation' },
  { href: '/admin/recovery', label: 'Recovery' },
  { href: '/admin/audit', label: 'Audit & alerts' },
  { href: '/admin/security', label: 'My security' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireRole role="ADMIN">
      <Shell title="Administration" nav={NAV}>{children}</Shell>
    </RequireRole>
  );
}

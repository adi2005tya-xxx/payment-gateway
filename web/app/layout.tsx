import type { Metadata, Viewport } from 'next';
import { ReactNode } from 'react';
import { StepUpProvider } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = { title: 'Gateway', description: 'Payment collection and settlement (sandbox)' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StepUpProvider>{children}</StepUpProvider>
      </body>
    </html>
  );
}

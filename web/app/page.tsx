'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { currentSession } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const s = currentSession();
    router.replace(!s ? '/login' : s.role === 'ADMIN' ? '/admin' : '/merchant');
  }, [router]);
  return <p className="p-8 text-sm text-slate-500">Loading…</p>;
}

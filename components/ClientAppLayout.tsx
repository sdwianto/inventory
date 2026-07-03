'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import AppShell from '@/components/AppShell';

/** Halaman tanpa sidebar (login, dll.). */
const PUBLIC_PATHS = new Set(['/']);

export default function ClientAppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!pathname || PUBLIC_PATHS.has(pathname)) {
    return <>{children}</>;
  }
  return <AppShell>{children}</AppShell>;
}

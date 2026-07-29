import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'Inventory App — Gudang & Food Production',
  description:
    'Gudang, pengadaan B2B, food production MBG, dan distribusi — terintegrasi sales.app',
  manifest: '/manifest.json',
};

export const viewport = {
  themeColor: '#0A1931',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className="min-h-screen bg-bgn-sky-light antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

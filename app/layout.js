import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'Inventory App — Customer Gudang',
  description: 'Penerimaan barang dari sales.app & manajemen stok customer',
  manifest: '/manifest.json',
};

export const viewport = {
  themeColor: '#0A1931',
};

export default function RootLayout({ children }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className="min-h-screen bg-bgn-sky-light antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

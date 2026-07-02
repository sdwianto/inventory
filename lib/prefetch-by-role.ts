import type { QueryClient } from '@tanstack/react-query';
import { prefetchRouteData } from '@/lib/prefetch-route';

const ROLE_HOME_ROUTES: Record<string, string[]> = {
  GUDANG: ['/penerimaan', '/pembelian-po', '/dashboard'],
  SUPERVISOR: ['/penerimaan', '/maintenance/permintaan', '/dashboard'],
  ADMIN: ['/penerimaan', '/hutang', '/integrasi', '/dashboard'],
  OWNER: ['/penerimaan', '/hutang', '/dashboard'],
  MASTER: ['/dashboard', '/integrasi', '/utiliti/tenants'],
};

function hourWib(): number {
  const utc = new Date().getUTCHours();
  return (utc + 7) % 24;
}

function timeBasedRoutes(): string[] {
  const h = hourWib();
  if (h >= 6 && h < 12) {
    return ['/penerimaan', '/pembelian-po'];
  }
  if (h >= 14 && h < 18) {
    return ['/hutang', '/maintenance/permintaan'];
  }
  return [];
}

function canPrefetch(role: string, href: string, perms: string[] | '*'): boolean {
  if (perms === '*') return true;
  return perms.some((p) => href === p || href.startsWith(`${p}/`));
}

const ROLE_PERMISSIONS: Record<string, string[] | '*'> = {
  GUDANG: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/transfer'],
  SUPERVISOR: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer'],
  ADMIN: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi',
    '/integrasi', '/utiliti/tenant', '/utiliti/user'],
  OWNER: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi',
    '/integrasi', '/utiliti/tenant', '/utiliti/user'],
  MASTER: '*',
};

/** Prefetch route prioritas setelah login — berdasarkan role + jam operasional. */
export function prefetchByRole(queryClient: QueryClient, role: string) {
  const perms = ROLE_PERMISSIONS[role] || ['*'];
  const routes = new Set<string>();
  for (const href of ROLE_HOME_ROUTES[role] || ['/dashboard']) {
    if (canPrefetch(role, href, perms)) routes.add(href);
  }
  for (const href of timeBasedRoutes()) {
    if (canPrefetch(role, href, perms)) routes.add(href);
  }
  for (const href of routes) {
    prefetchRouteData(queryClient, href);
  }
}

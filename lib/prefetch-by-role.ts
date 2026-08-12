import type { QueryClient } from '@tanstack/react-query';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { prefetchRouteData } from '@/lib/prefetch-route';

const ROLE_HOME_ROUTES: Record<string, string[]> = {
  DRIVER: ['/food-production/distribution', '/food-production/service-point', '/dashboard'],
  GUDANG: ['/penerimaan', '/pembelian-po', '/dashboard', '/food-production/kitchen'],
  SUPERVISOR: ['/penerimaan', '/maintenance/permintaan', '/dashboard', '/food-production/plan'],
  ADMIN: ['/penerimaan', '/hutang', '/integrasi', '/dashboard', '/food-production/plan'],
  OWNER: ['/penerimaan', '/hutang', '/dashboard', '/food-production/plan'],
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

const FP_OPS_ROUTES = [
  '/food-production/kitchen', '/food-production/recipe', '/food-production/menu', '/food-production/plan',
  '/food-production/mrp', '/food-production/purchase-requirement', '/food-production/issue', '/food-production/result',
  '/food-production/report', '/food-production/calendar',
  '/food-production/service-point', '/food-production/distribution', '/food-production/cold-chain',
  '/food-production/haccp', '/food-production/batch', '/food-production/qc',
] as const;

const KA_OPS_ROUTES = [
  '/kitchen-assurance',
  '/kitchen-assurance/monitoring',
  '/kitchen-assurance/cases',
  '/kitchen-assurance/follow-up',
  '/kitchen-assurance/reports',
  '/kitchen-assurance/analytics',
  '/food-production/prerequisite',
  '/food-production/haccp-plan',
  '/food-production/haccp-verification',
  '/food-production/audit-readiness',
  '/food-production/qc',
] as const;

const FP_MGMT_ROUTES = [
  '/food-production/nutrition', '/food-production/cost', '/food-production/forecast',
  '/food-production/recommendations', '/food-production/dashboard', '/food-production/price-book',
] as const;

const FP_ROUTES = [...FP_OPS_ROUTES, ...FP_MGMT_ROUTES] as const;

const ROLE_PERMISSIONS: Record<string, string[] | '*'> = {
  DRIVER: [
    '/dashboard',
    '/food-production/service-point',
    '/food-production/distribution',
  ],
  GUDANG: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    ...FP_OPS_ROUTES,
    ...KA_OPS_ROUTES,
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset',
    '/stok/saldo', '/stok/pengeluaran', '/stok/release', '/stok/kartu', '/stok/transfer', '/stok/bins', '/stok/putaway'],
  SUPERVISOR: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    ...FP_ROUTES,
    ...KA_OPS_ROUTES,
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/pengeluaran', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/bins', '/stok/putaway'],
  ADMIN: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
    ...FP_ROUTES,
    ...KA_OPS_ROUTES,
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/pengeluaran', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi', '/stok/bins', '/stok/putaway',
    '/integrasi', '/utiliti/tenant', '/utiliti/user', '/utiliti/api-keys'],
  OWNER: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
    ...FP_ROUTES,
    ...KA_OPS_ROUTES,
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/pengeluaran', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi', '/stok/bins', '/stok/putaway',
    '/integrasi', '/utiliti/tenant', '/utiliti/user', '/utiliti/api-keys'],
  MASTER: '*',
};

/** Prefetch route prioritas setelah login — berdasarkan role + jam operasional. */
export function prefetchByRole(queryClient: QueryClient, role: string) {
  // MASTER tanpa tenant operasional pasti 400 di endpoint scoped — tunggu picker.
  if (role === 'MASTER' && !getActingTenantId()) return;

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

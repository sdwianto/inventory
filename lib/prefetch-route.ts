import type { QueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import { buildCursorListUrl } from '@/lib/cursor-prefetch-cache';
import { queryKeys } from '@/lib/query-keys';
import { buildProdukPageUrl, produkPageQueryKey } from '@/lib/produk-page-scope';

const PRODUCT_LIST_LIMIT = 100;

function prefetchCursorPage(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  baseUrl: string,
  limit = 100,
) {
  void queryClient.prefetchInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchJson(buildCursorListUrl(baseUrl, limit, (pageParam as string | null) ?? null)),
    initialPageParam: null as string | null,
    staleTime: 60_000,
  });
}

/** Warm cache saat hover menu — navigasi terasa instan. */
export function prefetchRouteData(queryClient: QueryClient, href: string) {
  const prefetch = <T>(queryKey: readonly unknown[], url: string) => {
    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () => fetchJson<T>(url),
      staleTime: 60_000,
    });
  };

  switch (href) {
    case '/dashboard':
      prefetch(queryKeys.dashboard.all, '/api/dashboard');
      break;
    case '/penerimaan':
      prefetchCursorPage(queryClient, queryKeys.pages.penerimaan(), '/api/pages/penerimaan', 100);
      break;
    case '/pembelian-po':
      prefetchCursorPage(queryClient, queryKeys.customerPurchaseOrders.list, '/api/customer-purchase-orders', 100);
      prefetch(['products', { limit: 100, enrichUom: 0 }], '/api/products?limit=100&enrichUom=0');
      break;
    case '/hutang':
      prefetchCursorPage(
        queryClient,
        queryKeys.pages.hutang({ approvalStatus: 'PENDING_REVIEW' }),
        '/api/pages/hutang?approvalStatus=PENDING_REVIEW',
        100,
      );
      break;
    case '/produk':
      prefetchCursorPage(
        queryClient,
        produkPageQueryKey('', ''),
        buildProdukPageUrl('', ''),
        PRODUCT_LIST_LIMIT,
      );
      break;
    case '/food-production/kitchen':
      prefetch(['food-production', 'kitchens'], '/api/kitchens');
      break;
    case '/food-production/recipe':
      prefetch(['food-production', 'recipes'], '/api/recipes');
      break;
    case '/food-production/menu':
      prefetch(['food-production', 'menus'], '/api/menus');
      break;
    case '/food-production/mrp':
      prefetch(['food-production', 'material-requirements'], '/api/material-requirements');
      prefetch(['food-production', 'production-plans'], '/api/production-plans');
      break;
    case '/food-production/purchase-requirement':
      prefetch(['food-production', 'purchase-requirements'], '/api/purchase-requirements');
      prefetch(['food-production', 'material-requirements'], '/api/material-requirements?status=APPROVED');
      break;
    case '/food-production/issue':
      prefetch(['food-production', 'material-issues'], '/api/material-issues');
      prefetch(['food-production', 'production-plans'], '/api/production-plans');
      break;
    case '/stok/pengeluaran':
      prefetch(['food-production', 'material-issues'], '/api/material-issues');
      prefetch(['food-production', 'production-plans'], '/api/production-plans');
      prefetch(queryKeys.inventoryReleases.list, '/api/inventory-releases');
      break;
    case '/stok/release':
      prefetch(queryKeys.inventoryReleases.list, '/api/inventory-releases');
      break;
    case '/food-production/result':
      prefetch(['food-production', 'production-results'], '/api/production-results');
      prefetch(['food-production', 'production-plans'], '/api/production-plans');
      break;
    case '/food-production/report':
      prefetch(['food-production', 'production-reports'], '/api/production-reports');
      break;
    case '/food-production/nutrition':
      prefetch(['food-production', 'nutrition-profiles'], '/api/nutrition-profiles');
      prefetch(['food-production', 'recipes'], '/api/recipes?aktif=1');
      break;
    case '/food-production/cost':
      prefetch(['food-production', 'food-costs'], '/api/food-costs');
      break;
    case '/food-production/qc':
      prefetch(['food-production', 'qc-results'], '/api/qc-results');
      prefetch(['food-production', 'qc-templates'], '/api/qc-templates?aktif=1');
      break;
    case '/food-production/forecast':
      prefetch(['food-production', 'food-forecasts'], '/api/food-forecasts?horizon=7');
      break;
    case '/food-production/dashboard':
      prefetch(['food-production', 'food-dashboard'], '/api/food-dashboard');
      break;
    case '/food-production/recommendations':
      prefetch(['food-production', 'food-recommendations'], '/api/food-recommendations?horizon=7');
      break;
    case '/food-production/calendar':
    case '/food-production/plan': {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const last = new Date(y, now.getMonth() + 1, 0).getDate();
      const from = `${y}-${m}-01`;
      const to = `${y}-${m}-${String(last).padStart(2, '0')}`;
      prefetch(
        ['food-production', 'production-plans', from, to],
        `/api/production-plans?from=${from}&to=${to}`,
      );
      prefetch(['food-production', 'kitchens'], '/api/kitchens?aktif=1');
      prefetch(['food-production', 'menus'], '/api/menus');
      break;
    }
    case '/food-production/transfer':
      prefetch(['food-production', 'kitchen-transfers'], '/api/kitchen-transfers');
      prefetch(['food-production', 'kitchens'], '/api/kitchens?aktif=1');
      break;
    case '/food-production/batch':
      prefetch(['food-production', 'production-batches'], '/api/production-batches');
      break;
    case '/food-production/service-point':
      prefetch(['food-production', 'service-points'], '/api/service-points');
      prefetch(['food-production', 'kitchens'], '/api/kitchens?aktif=1');
      break;
    case '/food-production/distribution':
      prefetch(['food-production', 'distribution-orders'], '/api/distribution-orders');
      prefetch(['food-production', 'service-points'], '/api/service-points?aktif=1');
      break;
    case '/food-production/cold-chain':
      prefetch(['food-production', 'temperature-logs'], '/api/temperature-logs');
      prefetch(['food-production', 'temperature-alerts'], '/api/temperature-logs/alerts');
      prefetch(['food-production', 'temperature-thresholds'], '/api/temperature-thresholds');
      prefetch(['food-production', 'kitchens'], '/api/kitchens?aktif=1');
      break;
    case '/food-production/haccp':
      prefetch(['food-production', 'haccp-results'], '/api/haccp-results');
      prefetch(['food-production', 'haccp-templates'], '/api/haccp-templates?aktif=1');
      prefetch(['food-production', 'production-batches'], '/api/production-batches');
      break;
    case '/food-production/price-book':
      prefetch(['food-production', 'supplier-price-book'], '/api/supplier-price-book?aktif=1');
      break;
    case '/utiliti/api-keys':
      prefetch(['utiliti', 'api-keys'], '/api/api-keys');
      break;
    case '/stok/saldo':
      prefetch(['stok', 'saldo'], '/api/stok/saldo');
      break;
    case '/stok/kartu':
      prefetch(
        ['products', { limit: 100 }],
        `/api/products?limit=100&enrichUom=0`,
      );
      break;
    case '/maintenance/permintaan':
      prefetchCursorPage(
        queryClient,
        queryKeys.maintenance.requests.cursor(''),
        '/api/maintenance-requests',
        100,
      );
      break;
    case '/maintenance/jadwal':
      prefetchCursorPage(
        queryClient,
        queryKeys.maintenance.schedules.cursor('ACTIVE'),
        '/api/maintenance-schedules?status=ACTIVE',
        100,
      );
      break;
    case '/maintenance/aset':
      prefetch(queryKeys.maintenance.assets.list({ q: '', status: '' }), '/api/assets');
      break;
    case '/maintenance/laporan': {
      const to = new Date().toISOString().slice(0, 10);
      const fromDate = new Date();
      fromDate.setMonth(fromDate.getMonth() - 5);
      fromDate.setDate(1);
      const from = fromDate.toISOString().slice(0, 10);
      prefetch(
        queryKeys.maintenance.reports.report({ from, to, assetId: '' }),
        `/api/maintenance-reports?from=${from}&to=${to}`,
      );
      break;
    }
    case '/utiliti/user':
      prefetchCursorPage(queryClient, ['users'], '/api/users', 100);
      break;
    case '/integrasi':
      prefetch(queryKeys.integrations.status(false), '/api/integrations/status');
      break;
    default:
      break;
  }
}

/** Prefetch semua route dalam satu menu group (saat expand sidebar). */
export function prefetchNavGroup(queryClient: QueryClient, hrefs: string[]) {
  for (const href of hrefs) {
    prefetchRouteData(queryClient, href);
  }
}

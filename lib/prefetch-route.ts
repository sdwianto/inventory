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

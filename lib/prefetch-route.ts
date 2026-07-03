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
      prefetch(['dashboard'], '/api/dashboard');
      break;
    case '/penerimaan':
      prefetchCursorPage(queryClient, queryKeys.pages.penerimaan(), '/api/pages/penerimaan', 100);
      break;
    case '/pembelian-po':
      prefetch(['customer-purchase-orders'], '/api/customer-purchase-orders');
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
        `/api/products?limit=100`,
      );
      break;
    case '/maintenance/permintaan':
      prefetchCursorPage(queryClient, ['maintenance-requests'], '/api/maintenance-requests', 100);
      break;
    case '/maintenance/jadwal':
      prefetchCursorPage(
        queryClient,
        ['maintenance-schedules', 'ACTIVE'],
        '/api/maintenance-schedules?status=ACTIVE',
        100,
      );
      break;
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

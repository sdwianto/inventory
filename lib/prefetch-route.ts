import type { QueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import { prefetchCursorList } from '@/lib/cursor-prefetch-cache';

const PRODUCT_LIST_LIMIT = 100;

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
      void prefetchCursorList('/api/goods-receipts', 100);
      break;
    case '/pembelian-po':
      prefetch(['customer-purchase-orders'], '/api/customer-purchase-orders');
      break;
    case '/hutang':
      void prefetchCursorList('/api/hutang?approvalStatus=PENDING_REVIEW', 100);
      break;
    case '/produk':
      void prefetchCursorList('/api/products?q=', PRODUCT_LIST_LIMIT);
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
      void prefetchCursorList('/api/maintenance-requests', 100);
      break;
    case '/maintenance/jadwal':
      void prefetchCursorList('/api/maintenance-schedules?status=ACTIVE', 100);
      break;
    case '/utiliti/user':
      void prefetchCursorList('/api/users', 100);
      break;
    case '/integrasi':
      prefetch(['integrations', 'status'], '/api/integrations/status');
      break;
    default:
      break;
  }
}

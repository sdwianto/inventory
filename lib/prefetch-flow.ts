import type { QueryClient } from '@tanstack/react-query';
import { prefetchRouteData } from '@/lib/prefetch-route';

export function prefetchRouteFlow(queryClient: QueryClient, fromPath: string) {
  if (fromPath.startsWith('/penerimaan')) {
    prefetchRouteData(queryClient, '/hutang');
  }
  if (fromPath.startsWith('/pembelian-po')) {
    prefetchRouteData(queryClient, '/penerimaan');
  }
}

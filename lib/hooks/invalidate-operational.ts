import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { invalidateNavBadges, type NavBadgeBroadcast } from '@/lib/hooks/use-nav-badges';

/** Invalidate badge, dashboard, stok, dan halaman operasional terkait. */
export function invalidateOperationalCaches(
  qc: QueryClient,
  opts?: { broadcast?: NavBadgeBroadcast },
) {
  invalidateNavBadges(qc, opts);
  void qc.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  void qc.invalidateQueries({ queryKey: queryKeys.stokSaldo.all });
  void qc.invalidateQueries({ queryKey: queryKeys.products.all });
  void qc.invalidateQueries({ queryKey: queryKeys.goodsReceipts.all });
  void qc.invalidateQueries({ queryKey: ['pages', 'penerimaan'] });
  void qc.invalidateQueries({ queryKey: ['pages', 'hutang'] });
  void qc.invalidateQueries({ queryKey: queryKeys.hutang.all });
  void qc.invalidateQueries({ queryKey: queryKeys.customerPurchaseOrders.all });
  void qc.invalidateQueries({ queryKey: queryKeys.maintenance.requests.all });
  void qc.invalidateQueries({ queryKey: queryKeys.maintenance.schedules.all });
}

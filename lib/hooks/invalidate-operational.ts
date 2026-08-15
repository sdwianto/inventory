import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { invalidateNavBadges, type NavBadgeBroadcast } from '@/lib/hooks/use-nav-badges';

type InvalidateOpts = { broadcast?: NavBadgeBroadcast };

/** PO ke vendor — list & badge saja. */
export function invalidatePoCaches(qc: QueryClient, opts?: InvalidateOpts) {
  invalidateNavBadges(qc, opts);
  void qc.invalidateQueries({ queryKey: queryKeys.customerPurchaseOrders.all });
}

/** Penerimaan GRN — list & badge. */
export function invalidateGrnCaches(qc: QueryClient, opts?: InvalidateOpts) {
  invalidateNavBadges(qc, opts);
  void qc.invalidateQueries({ queryKey: queryKeys.goodsReceipts.all });
  void qc.invalidateQueries({ queryKey: ['pages', 'penerimaan'] });
}

/** Tagihan vendor — list & badge. */
export function invalidateHutangCaches(qc: QueryClient, opts?: InvalidateOpts) {
  invalidateNavBadges(qc, opts);
  void qc.invalidateQueries({ queryKey: ['pages', 'hutang'] });
  void qc.invalidateQueries({ queryKey: queryKeys.hutang.all });
  void qc.invalidateQueries({ queryKey: queryKeys.vendorReturns.all });
}

/** Dashboard + stok + produk (setelah catalog sync / perubahan master). */
export function invalidateDashboardAndStockCaches(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  void qc.invalidateQueries({ queryKey: queryKeys.stokSaldo.all });
  void qc.invalidateQueries({ queryKey: queryKeys.products.all });
}

/** Invalidate badge, dashboard, stok, dan halaman operasional terkait. */
export function invalidateOperationalCaches(
  qc: QueryClient,
  opts?: InvalidateOpts,
) {
  invalidateNavBadges(qc, opts);
  void qc.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  void qc.invalidateQueries({ queryKey: queryKeys.stokSaldo.all });
  void qc.invalidateQueries({ queryKey: queryKeys.products.all });
  void qc.invalidateQueries({ queryKey: queryKeys.goodsReceipts.all });
  void qc.invalidateQueries({ queryKey: ['pages', 'penerimaan'] });
  void qc.invalidateQueries({ queryKey: ['pages', 'hutang'] });
  void qc.invalidateQueries({ queryKey: queryKeys.hutang.all });
  void qc.invalidateQueries({ queryKey: queryKeys.vendorReturns.all });
  void qc.invalidateQueries({ queryKey: queryKeys.customerPurchaseOrders.all });
  void qc.invalidateQueries({ queryKey: queryKeys.maintenance.requests.all });
  void qc.invalidateQueries({ queryKey: queryKeys.maintenance.schedules.all });
}

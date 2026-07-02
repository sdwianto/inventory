/** Jalankan sync hutang pending dari sales.app (untuk bg_jobs). */

import type { Db } from 'mongodb';
import { syncPostedInvoicesFromSales } from '@/lib/api/invoice-sync-sales';
import { backfixVendorHutangFromPostedGrns } from '@/lib/api/hutang-reconcile';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { hutangPendingReviewFilter } from '@/lib/api/hutang-filters';
import type { AuthContext } from '@/types/auth';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

interface ReconcileSummary {
  created: number;
  fixed: number;
  linked: number;
  replayed: number;
  scanned: number;
  salesErrors: unknown[];
}

export async function runHutangSyncPending(
  db: Db,
  tenantId: string,
  scopeAuth: AuthContext | null | undefined,
  { replaySales = false }: { replaySales?: boolean } = {},
) {
  let syncResult: Record<string, unknown> = {
    created: 0, existing: 0, refreshed: 0, errors: [], total: 0,
  };
  const reconcile: ReconcileSummary = {
    created: 0, fixed: 0, linked: 0, replayed: 0, scanned: 0, salesErrors: [],
  };

  await backfixVendorHutangFromPostedGrns(db, tenantId, { replaySales });
  const part = await syncPostedInvoicesFromSales(db, tenantId, { reconcileSales: replaySales }) as Record<string, unknown>;

  if (part.error && !part.skipped && !syncResult.error) {
    syncResult = part;
  } else {
    syncResult.created = Number(part.created || 0);
    syncResult.existing = Number(part.existing || 0);
    syncResult.refreshed = Number(part.refreshed || 0);
    syncResult.total = Number(part.total || 0);
    syncResult.fetchIncomplete = part.fetchIncomplete;
    syncResult.warning = part.warning;
    syncResult.fetchWarnings = part.fetchWarnings;
    syncResult.vendorsSynced = part.vendorsSynced;
    const partErrors = part.errors as unknown[] | undefined;
    if (partErrors?.length) syncResult.errors = partErrors;
    if (part.skipped) syncResult.skipped = true;
  }

  const partReconcile = part.reconcile as ReconcileSummary | undefined;
  if (partReconcile) {
    reconcile.created += Number(partReconcile.created || 0);
    reconcile.fixed += Number(partReconcile.fixed || 0);
    reconcile.linked += Number(partReconcile.linked || 0);
    reconcile.replayed += Number(partReconcile.replayed || 0);
    reconcile.scanned += Number(partReconcile.scanned || 0);
    if (partReconcile.salesErrors?.length) {
      reconcile.salesErrors.push(...partReconcile.salesErrors);
    }
  }

  let pendingAfter = 0;
  if (scopeAuth) {
    const pendingFilter = withTenantFilter(scopeAuth, hutangPendingReviewFilter());
    pendingAfter = await db.collection('hutang').countDocuments(pendingFilter);
  }

  if (syncResult.error && !syncResult.skipped) {
    return { error: String(syncResult.error), reconcile, pendingAfter };
  }

  await invalidateDashboardSnapshot(db, tenantId);

  return { ...syncResult, reconcile, pendingAfter };
}

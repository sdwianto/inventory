/** Sync DO shipped dari sales.app — untuk bg_jobs. */

import type { Db } from 'mongodb';
import { syncShippedDeliveriesFromSales } from '@/lib/api/grn-sync-sales';
import { refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

export async function runGrnSyncShipped(db: Db, tenantId: string) {
  const result = await syncShippedDeliveriesFromSales(db, tenantId);
  if ('error' in result && result.error) {
    return result;
  }
  await invalidateDashboardSnapshot(db, tenantId);
  const grnRefreshed = await refreshUnresolvedGrnsForTenant(db, tenantId);
  return { ...result, grnRefreshed };
}

/** Sync DO shipped dari sales.app — untuk bg_jobs. */

import type { Db } from 'mongodb';
import { syncShippedDeliveriesFromSales } from '@/lib/api/grn-sync-sales';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

export async function runGrnSyncShipped(db: Db, tenantId: string) {
  const result = await syncShippedDeliveriesFromSales(db, tenantId);
  if (!('error' in result) || !result.error) {
    await invalidateDashboardSnapshot(db, tenantId);
  }
  return result;
}

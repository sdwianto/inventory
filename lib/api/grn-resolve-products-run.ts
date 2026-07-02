import type { Db } from 'mongodb';
import { refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';

export async function runGrnResolveProducts(db: Db, tenantId: string) {
  const tid = tenantId || 'default';
  const refreshed = await refreshUnresolvedGrnsForTenant(db, tid);
  await invalidateDashboardSnapshot(db, tid);
  return { refreshed, tenantId: tid };
}

/** Retry kirim PO ke satu vendor — partial fail multi-vendor (Phase 4.7). */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';
import { pushPoGroupToVendor, finalizePoSubmission, warmUpSalesApp } from '@/lib/api/customer-po-push';
import type { JsonObject } from '@/types/json';

export async function retryVendorSyncForSingleVendor(
  db: Db,
  po: Record<string, unknown>,
  vendorTenantId: string,
) {
  const tenantId = String(po.tenantId || 'default');
  const enriched = await enrichPoItemsForVendor(db, tenantId, (po.items || []) as JsonObject[]);
  if (enriched.error) return { error: enriched.error, status: 400 };

  const grouped = groupPoItemsByVendorTenant(enriched.items || []);
  if (grouped.error) return { error: grouped.error, status: 400 };

  const group = (grouped.groups || []).find((g) => g.vendorTenantId === vendorTenantId);
  if (!group) return { error: `Tidak ada baris untuk vendor ${vendorTenantId}`, status: 400 };

  const config = await getIntegrationConfig(db, tenantId, vendorTenantId);
  await warmUpSalesApp(config.salesAppUrl);
  const pushed = await pushPoGroupToVendor(db, {
    tenantId,
    config,
    po,
    vendorTenantId,
    items: group.items,
  });

  const now = new Date();
  const existing = ((po.vendorSubmissions || []) as JsonObject[]).filter(
    (s) => s.vendorTenantId !== vendorTenantId,
  );

  if (pushed.error) {
    const failedSub = {
      vendorTenantId,
      status: 'FAILED',
      error: pushed.error,
      itemCount: group.items.length,
      syncedAt: now,
    };
    const allSubs = [...existing, failedSub];
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      {
        $set: {
          vendorSubmissions: allSubs,
          // P1: Failed jelas — bukan PENDING happy path.
          vendorSyncPending: false,
          vendorSyncError: String(pushed.error),
          vendorSyncAt: now,
          updatedAt: now,
        },
      },
    );
    return { error: pushed.error, status: 502, vendorSynced: false };
  }

  const so = (pushed.vendorSo || {}) as JsonObject;
  const syncedSub = {
    vendorTenantId,
    status: 'SYNCED',
    vendorSoId: so.id || so.salesOrderId,
    vendorNoSO: so.noSO,
    vendorSo: pushed.vendorSo || null,
    itemCount: group.items.length,
    syncedAt: now,
  };
  const syncedSubs = [...existing, syncedSub];
  const stillFailed = syncedSubs.filter((s) => s.status === 'FAILED');

  const updated = await finalizePoSubmission(
    db,
    po,
    syncedSubs.filter((s) => s.status === 'SYNCED'),
    po.approvedBy as Record<string, unknown> | null | undefined,
    { partialFailures: stillFailed },
  );

  return { po: updated, vendorSynced: stillFailed.length === 0 };
}

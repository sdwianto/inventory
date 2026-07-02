/** Sync PO APPROVED ke sales.app — parallel batch untuk bg_jobs / API. */

import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import {
  retryVendorSyncForPo,
  VENDOR_SYNC_BATCH_LIMIT,
  VENDOR_SYNC_RETRY_COOLDOWN_MS,
  VENDOR_SYNC_PARALLEL,
} from '@/lib/api/customer-po-vendor-sync';
import type { JsonObject } from '@/types/json';
import type { AuthContext } from '@/types/auth';

export async function runPoVendorSyncPending(db: Db, scopeAuth: AuthContext | null | undefined) {
  const cutoff = new Date(Date.now() - VENDOR_SYNC_RETRY_COOLDOWN_MS);
  let filter: Record<string, unknown> = {
    status: 'APPROVED',
    vendorSyncPending: { $ne: false },
    $or: [
      { vendorSyncAt: { $exists: false } },
      { vendorSyncAt: { $lt: cutoff } },
    ],
  };
  filter = withTenantFilter(scopeAuth, filter);

  const pending = await db.collection('customer_purchase_orders')
    .find(filter)
    .sort({ approvedAt: 1 })
    .limit(VENDOR_SYNC_BATCH_LIMIT)
    .toArray();

  const synced: JsonObject[] = [];
  const failed: JsonObject[] = [];

  for (let i = 0; i < pending.length; i += VENDOR_SYNC_PARALLEL) {
    const chunk = pending.slice(i, i + VENDOR_SYNC_PARALLEL);
    const results = await Promise.all(
      chunk.map((po) => retryVendorSyncForPo(db, po, po.approvedBy)),
    );
    for (let j = 0; j < chunk.length; j += 1) {
      const po = chunk[j];
      const result = results[j];
      if (result.po) {
        synced.push({
          id: result.po.id,
          noPO: result.po.noPO,
          vendorNoSO: result.po.vendorNoSO,
        });
      } else {
        failed.push({ id: po.id, noPO: po.noPO, error: result.error });
        const errMsg = String(result.error || '');
        if (errMsg.includes('tidak dapat dihubungi') || errMsg.includes('ECONNREFUSED')) {
          return { attempted: pending.length, synced, failed, stoppedEarly: true };
        }
      }
    }
  }

  return { attempted: pending.length, synced, failed };
}

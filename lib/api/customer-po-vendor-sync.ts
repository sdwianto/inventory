/** Retry kirim PO APPROVED ke sales.app — dipakai handler & bg_jobs. */

import type { Db } from 'mongodb';
import { pushPoToVendor, finalizePoSubmission } from '@/lib/api/customer-po-push';

export const VENDOR_SYNC_RETRY_COOLDOWN_MS = 30_000;
export const VENDOR_SYNC_BATCH_LIMIT = 20;
export const VENDOR_SYNC_PARALLEL = 3;

export async function retryVendorSyncForPo(db: Db, po: Record<string, unknown>, approverSnap: unknown) {
  const pushed = await pushPoToVendor(db, po, String(po.tenantId || 'default'));
  if (!pushed.submissions?.length) {
    const now = new Date();
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      { $set: { vendorSyncError: pushed.error, vendorSyncAt: now, updatedAt: now } },
    );
    return { error: pushed.error, status: 502 };
  }
  const updated = await finalizePoSubmission(
    db,
    po,
    pushed.submissions,
    (approverSnap || po.approvedBy) as Record<string, unknown> | null | undefined,
  );
  return { po: updated, vendorSynced: true };
}

/** Retry kirim PO APPROVED ke sales.app — dipakai handler & bg_jobs. */

import type { Db } from 'mongodb';
import { pushPoToVendor, finalizePoSubmission } from '@/lib/api/customer-po-push';

export const VENDOR_SYNC_RETRY_COOLDOWN_MS = 30_000;
export const VENDOR_SYNC_BATCH_LIMIT = 20;
export const VENDOR_SYNC_PARALLEL = 3;

export const VENDOR_SYNC_PUSH_TIMEOUT_MS = 15_000;
export const VENDOR_SYNC_PUSH_RETRIES = 1;

export async function retryVendorSyncForPo(db: Db, po: Record<string, unknown>, approverSnap: unknown) {
  const pushed = await pushPoToVendor(
    db,
    po,
    String(po.tenantId || 'default'),
    { timeoutMs: VENDOR_SYNC_PUSH_TIMEOUT_MS },
  );
  if (!('submissions' in pushed) || !pushed.submissions?.length) {
    const errMsg = 'error' in pushed ? pushed.error : 'Gagal kirim ke vendor';
    const now = new Date();
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      { $set: { vendorSyncError: errMsg, vendorSyncAt: now, updatedAt: now } },
    );
    return { error: errMsg, status: 502 };
  }
  const updated = await finalizePoSubmission(
    db,
    po,
    pushed.submissions,
    (approverSnap || po.approvedBy) as Record<string, unknown> | null | undefined,
    { partialFailures: pushed.partialFailures || [] },
  );
  return { po: updated, vendorSynced: !(pushed.partialFailures?.length) };
}

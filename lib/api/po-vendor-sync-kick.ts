/** Enqueue PO_VENDOR_SYNC + picu worker terpisah (tanpa blok HTTP request). */

import type { Db } from 'mongodb';
import {
  enqueueJob,
  JOB_TYPES,
} from '@/lib/api/bg-jobs';
import { kickBgWorker } from '@/lib/api/worker-kick';

export async function enqueueAndKickPoVendorSync(
  db: Db,
  tenantId: string,
  { poId }: { poId?: string } = {},
) {
  const payload = poId
    ? { poId: String(poId), dedupeKey: `po-vendor:${poId}` }
    : {};

  const { jobId, reused } = await enqueueJob(db, {
    type: JOB_TYPES.PO_VENDOR_SYNC,
    tenantId,
    payload,
  });

  void kickBgWorker({ limit: 2 });

  return { jobId, reused };
}

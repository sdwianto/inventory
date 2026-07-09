/** Enqueue + kick PO_VENDOR_SYNC tanpa menahan respons HTTP (Vercel `after`). */

import { after } from 'next/server';
import type { Db } from 'mongodb';
import { connectToMongo } from '@/lib/api/db';
import {
  enqueueJob,
  processJobById,
  scheduleJobProcessing,
  JOB_TYPES,
} from '@/lib/api/bg-jobs';

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

  after(async () => {
    try {
      const freshDb = await connectToMongo();
      await processJobById(freshDb, jobId);
    } catch (e) {
      console.warn('[po-vendor-sync] background kick failed:', e instanceof Error ? e.message : e);
    }
  });
  scheduleJobProcessing(db, { limit: 2 });

  return { jobId, reused };
}

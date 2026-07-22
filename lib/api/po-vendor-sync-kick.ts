/** Enqueue PO_VENDOR_SYNC + wake/drain worker (VPS job-bus + legacy). */

import { after } from 'next/server';
import type { Db } from 'mongodb';
import { connectToMongo } from '@/lib/api/db';
import {
  enqueueJob,
  processJobById,
  scheduleJobProcessing,
  JOB_TYPES,
} from '@/lib/api/bg-jobs';
import { kickBgWorker } from '@/lib/api/worker-kick';
import { shouldUseLegacyBgPoll } from '@/lib/api/execution-wave';

const PROD_INVENTORY_URL = 'https://penarukan2.vercel.app';

function workerBaseUrl(): string {
  const env = String(process.env.INVENTORY_APP_URL || '').replace(/\/$/, '');
  if (env && !/localhost|127\.0\.0\.1/i.test(env)) return env;
  return PROD_INVENTORY_URL;
}

async function triggerWorker(db: Db, jobId: string): Promise<boolean> {
  // VPS: Redis wake dari enqueue + drain processOneTick (jangan no-op).
  if (!shouldUseLegacyBgPoll()) {
    scheduleJobProcessing(db, { limit: 4 });
    try {
      const { processExecutionJobs } = await import('@/lib/api/process-execution-jobs');
      await processExecutionJobs(db, {
        limit: 3,
        domain: 'inventory',
        workerId: 'po-vendor-http-drain',
        capabilities: ['SYNC', 'CPU_BATCH', 'WEBHOOK'],
      });
      return true;
    } catch (e) {
      console.warn('[po-vendor-sync] VPS drain failed:', e instanceof Error ? e.message : e);
      return true; // enqueue + Redis wake tetap jalur utama
    }
  }

  const kicked = await kickBgWorker({ limit: 2, baseUrl: workerBaseUrl() });
  try {
    const freshDb = await connectToMongo();
    await processJobById(freshDb, jobId);
    return true;
  } catch (e) {
    if (kicked) {
      console.warn('[po-vendor-sync] kick ok but inline process failed:', e instanceof Error ? e.message : e);
      return true;
    }
    console.warn('[po-vendor-sync] inline process failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

export async function enqueueAndKickPoVendorSync(
  db: Db,
  tenantId: string,
  { poId, vendorTenantId }: { poId?: string; vendorTenantId?: string } = {},
) {
  const vendorKey = vendorTenantId ? String(vendorTenantId) : '';
  const payload = poId
    ? {
        poId: String(poId),
        ...(vendorKey ? { vendorTenantId: vendorKey } : {}),
        dedupeKey: vendorKey
          ? `po-vendor:${poId}:${vendorKey}`
          : `po-vendor:${poId}`,
      }
    : {};

  const { jobId, reused } = await enqueueJob(db, {
    type: JOB_TYPES.PO_VENDOR_SYNC,
    tenantId,
    payload,
  });

  // Drain segera (termasuk job reused yang tidak re-publish wake).
  void triggerWorker(db, jobId);

  after(async () => {
    const freshDb = await connectToMongo();
    await triggerWorker(freshDb, jobId);
  });

  return { jobId, reused };
}

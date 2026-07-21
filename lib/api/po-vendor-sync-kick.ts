/** Enqueue PO_VENDOR_SYNC + picu worker (HTTP) dengan fallback proses job di after(). */

import { after } from 'next/server';
import type { Db } from 'mongodb';
import { connectToMongo } from '@/lib/api/db';
import {
  enqueueJob,
  processJobById,
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

async function triggerWorker(jobId: string): Promise<boolean> {
  if (!shouldUseLegacyBgPoll()) return true;

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

  void triggerWorker(jobId);

  after(async () => {
    await triggerWorker(jobId);
  });

  return { jobId, reused };
}

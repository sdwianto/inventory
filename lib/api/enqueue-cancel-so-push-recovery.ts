/** Enqueue CANCEL_SO_PUSH_RECOVERY — scheduler layer setelah drain FAILED (W1-2 slice 2). */

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

async function triggerWorker(db: Db, jobId: string): Promise<void> {
  if (!shouldUseLegacyBgPoll()) {
    scheduleJobProcessing(db, { limit: 4 });
    try {
      const { processExecutionJobs } = await import('@/lib/api/process-execution-jobs');
      await processExecutionJobs(db, {
        limit: 3,
        domain: 'inventory',
        workerId: 'cancel-so-http-drain',
        capabilities: ['SYNC', 'CPU_BATCH', 'WEBHOOK'],
      });
    } catch (e) {
      console.warn('[cancel-so-push] VPS drain failed:', e instanceof Error ? e.message : e);
    }
    return;
  }

  await kickBgWorker({ limit: 2, baseUrl: workerBaseUrl() });
  try {
    const freshDb = await connectToMongo();
    await processJobById(freshDb, jobId);
  } catch (e) {
    console.warn('[cancel-so-push] inline process failed:', e instanceof Error ? e.message : e);
  }
}

export async function enqueueAndKickCancelSoPushRecovery(
  db: Db,
  tenantId: string,
  input: { poId: string; reason?: string | null },
): Promise<{ jobId: string; reused: boolean }> {
  const poId = String(input.poId);
  const { jobId, reused } = await enqueueJob(db, {
    type: JOB_TYPES.CANCEL_SO_PUSH_RECOVERY,
    tenantId,
    payload: {
      poId,
      reason: input.reason ?? null,
      dedupeKey: `cancel-so-push:${poId}`,
    },
  });

  void triggerWorker(db, jobId);
  after(async () => {
    const freshDb = await connectToMongo();
    await triggerWorker(freshDb, jobId);
  });

  return { jobId, reused };
}

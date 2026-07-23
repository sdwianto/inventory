/**
 * Drain execution-platform bg_jobs via processOneTick (HTTP kick / in-request fast path).
 * Juga menjalankan recovery cycle (normalize legacy + reclaim DISPATCHED/RUNNING stale)
 * agar antrian tidak diam saat inventory-worker sempat down.
 */

import type { Db } from 'mongodb';
import type { JobDomain, WorkerCapability } from '@sdwianto/contracts';
import { processOneTick, runRecoveryCycle, ShutdownController } from '@sdwianto/platform';

export type ProcessExecutionJobsOpts = {
  limit?: number;
  domain?: JobDomain;
  workerId?: string;
  capabilities?: WorkerCapability[];
  /** Skip runRecoveryCycle (default: run recovery first). */
  skipRecovery?: boolean;
};

export type ProcessExecutionJobsResult = {
  processed: number;
  ticks: number;
  recovery?: {
    legacyNormalized: number;
    visibilityRequeued: number;
    claimTimeoutRequeued: number;
    staleRequeued: number;
    orphanDispatchedRequeued: number;
  };
};

/** DISPATCHED tanpa visibilityTimeoutAt yang menggantung setelah worker crash. */
export const STALE_DISPATCHED_MS = 15 * 60 * 1000;

export async function recoverOrphanDispatchedJobs(
  db: Db,
  { maxAgeMs = STALE_DISPATCHED_MS } = {},
): Promise<number> {
  const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
  const cutoffDate = new Date(Date.now() - maxAgeMs);
  const res = await db.collection('bg_jobs').updateMany(
    {
      status: 'DISPATCHED',
      $or: [
        { updatedAt: { $lte: cutoffIso } },
        { updatedAt: { $lte: cutoffDate } },
        {
          updatedAt: { $exists: false },
          createdAt: { $lte: cutoffDate },
        },
      ],
    },
    {
      $set: {
        status: 'PENDING',
        nextRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: 'Recovered from stale DISPATCHED (worker timeout)',
      },
      $unset: {
        claimedBy: '',
        claimedAt: '',
        visibilityTimeoutAt: '',
      },
    },
  );
  return res.modifiedCount;
}

export async function processExecutionJobs(
  db: Db,
  opts: ProcessExecutionJobsOpts = {},
): Promise<ProcessExecutionJobsResult> {
  // Side-effect: register inventory + webhook handlers.
  await import('@/lib/execution/workers/register-all');

  let recovery: ProcessExecutionJobsResult['recovery'];
  if (!opts.skipRecovery) {
    try {
      const cycle = await runRecoveryCycle(db);
      const orphanDispatchedRequeued = await recoverOrphanDispatchedJobs(db);
      recovery = {
        legacyNormalized: cycle.legacyNormalized.patched,
        visibilityRequeued: cycle.visibility.requeued,
        claimTimeoutRequeued: cycle.claimTimeout.requeued,
        staleRequeued: cycle.stale.requeued,
        orphanDispatchedRequeued,
      };
    } catch (e) {
      console.warn(
        '[processExecutionJobs] recovery failed:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  const limit = Math.min(30, Math.max(1, opts.limit ?? 10));
  const domain = opts.domain ?? 'inventory';
  const workerId = opts.workerId ?? `http-process-${domain}`;
  const capabilities = opts.capabilities
    ?? (['SYNC', 'CPU_BATCH', 'WEBHOOK'] as WorkerCapability[]);
  const shutdown = new ShutdownController();

  let ticks = 0;
  for (let i = 0; i < limit; i += 1) {
    const ran = await processOneTick({
      domain,
      workerId,
      capabilities,
      db,
      shutdown,
    });
    if (!ran) break;
    ticks += 1;
  }
  return { processed: ticks, ticks, recovery };
}

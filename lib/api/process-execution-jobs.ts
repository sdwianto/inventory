/**
 * Drain execution-platform bg_jobs via processOneTick (HTTP kick / in-request fast path).
 */

import type { Db } from 'mongodb';
import type { JobDomain, WorkerCapability } from '@sdwianto/contracts';
import { processOneTick, ShutdownController } from '@sdwianto/platform';

export type ProcessExecutionJobsOpts = {
  limit?: number;
  domain?: JobDomain;
  workerId?: string;
  capabilities?: WorkerCapability[];
};

export async function processExecutionJobs(
  db: Db,
  opts: ProcessExecutionJobsOpts = {},
): Promise<{ processed: number; ticks: number }> {
  // Side-effect: register inventory + webhook handlers.
  await import('@/lib/execution/workers/register-all');

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
  return { processed: ticks, ticks };
}

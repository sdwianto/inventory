#!/usr/bin/env node
/**
 * Inventory execution worker entrypoint (EE-9C).
 */

import { hostname } from 'node:os';
import { connectToMongo } from '@/lib/api/db';
import { loadPlatformConfig, validatePlatformConfig } from '@/lib/execution/runtime/config';
import { startExecutionMetricsServer } from '@/lib/execution/metrics/metrics-http-server';
import { startWorker } from '@/lib/execution/runtime/worker-runner';
import { ensureDefaultScheduledTasks } from '@/lib/execution/scheduler/seed-default-tasks';
import { runSchedulerCycle } from '@/lib/execution/scheduler/scheduler-daemon';
import '@/lib/execution/workers/register-all';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  validatePlatformConfig({ context: 'worker' });
  const config = loadPlatformConfig();
  if (!config.workerDomain) {
    throw new Error('WORKER_DOMAIN is required');
  }

  const db = await connectToMongo();
  const stopMetrics = startExecutionMetricsServer({ getDb: () => db });

  const workerId = config.workerId ?? `${config.workerDomain}-${hostname()}`;
  const capabilities = config.workerCapabilities;

  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  let schedulerShuttingDown = false;

  if (config.schedulerEnabled) {
    const seed = await ensureDefaultScheduledTasks(db);
    if (seed.inserted > 0) {
      console.info('[execution:worker] seeded scheduled tasks', seed);
    }

    const schedulerIntervalMs = config.schedulerPollIntervalSec * 1000;
    schedulerTimer = setInterval(() => {
      if (schedulerShuttingDown) return;
      void runSchedulerCycle(db).then((result) => {
        if (result.fired > 0 || result.errors > 0) {
          console.info('[execution:worker] scheduler', result);
        }
      }).catch((error) => {
        console.error('[execution:worker] scheduler error:', error);
      });
    }, schedulerIntervalMs);

    const bootstrap = await runSchedulerCycle(db);
    if (bootstrap.fired > 0 || bootstrap.errors > 0) {
      console.info('[execution:worker] scheduler bootstrap', bootstrap);
    }
  }

  console.info('[execution:worker] starting', {
    domain: config.workerDomain,
    workerId,
    capabilities,
    schedulerEnabled: config.schedulerEnabled,
  });

  try {
    await startWorker({
      domain: config.workerDomain,
      workerId,
      capabilities,
      db,
    });
  } finally {
    schedulerShuttingDown = true;
    if (schedulerTimer) clearInterval(schedulerTimer);
    await sleep(100);
    stopMetrics();
  }
}

main().catch((error) => {
  console.error('[execution:worker] fatal:', error);
  process.exit(1);
});

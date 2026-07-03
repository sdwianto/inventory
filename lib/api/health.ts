/** Liveness/readiness — ping MongoDB + backlog bg_jobs untuk orchestrator & MASTER alert. */

import type { Db } from 'mongodb';
import { ensureBgJobIndexes } from '@/lib/api/bg-jobs';

const startedAt = Date.now();
export const WORKER_STALE_THRESHOLD_SEC = 300;

export interface BgJobsHealth {
  pendingCount: number;
  oldestPendingAgeSec: number | null;
  deadLetterCount: number;
  workerStale: boolean;
}

export interface HealthPayload {
  status: 'ok' | 'degraded';
  app: string;
  uptimeSec: number;
  checks: {
    database: 'ok' | 'fail' | 'skipped';
    databaseError?: string;
    worker?: BgJobsHealth;
  };
  timestamp: string;
}

export async function buildBgJobsHealth(db: Db): Promise<BgJobsHealth> {
  await ensureBgJobIndexes(db);
  const pendingCount = await db.collection('bg_jobs').countDocuments({ status: 'PENDING' });
  const oldest = await db.collection('bg_jobs').findOne(
    { status: 'PENDING' },
    { sort: { createdAt: 1 }, projection: { createdAt: 1 } },
  );
  const oldestPendingAgeSec = oldest?.createdAt
    ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000)
    : null;
  const deadLetterCount = await db.collection('bg_jobs').countDocuments({
    status: 'FAILED',
    deadLetter: true,
  });
  const workerStale = oldestPendingAgeSec != null && oldestPendingAgeSec > WORKER_STALE_THRESHOLD_SEC;
  return { pendingCount, oldestPendingAgeSec, deadLetterCount, workerStale };
}

export async function buildHealthResponse(db: Db | null, appName: string): Promise<HealthPayload> {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  let database: HealthPayload['checks']['database'] = 'skipped';
  let databaseError: string | undefined;
  let worker: BgJobsHealth | undefined;

  if (db) {
    try {
      await db.command({ ping: 1 });
      database = 'ok';
      try {
        worker = await buildBgJobsHealth(db);
      } catch {
        worker = undefined;
      }
    } catch (e) {
      database = 'fail';
      databaseError = e instanceof Error ? e.message : 'ping failed';
    }
  } else {
    database = 'fail';
    databaseError = 'database connection unavailable';
  }

  const dbReady = database === 'ok';
  return {
    status: dbReady ? 'ok' : 'degraded',
    app: appName,
    uptimeSec,
    checks: {
      database,
      ...(databaseError ? { databaseError } : {}),
      ...(worker ? { worker } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

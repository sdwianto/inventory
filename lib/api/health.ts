/** Liveness/readiness — ping MongoDB + backlog bg_jobs untuk orchestrator & MASTER alert. */

import type { Db } from 'mongodb';
import { ensureBgJobIndexes } from '@/lib/api/bg-jobs';
import { checkMongoReplicaSet } from '@/lib/api/mongo-replica';
import { isDistributedRateLimitEnabled } from '@/lib/api/rate-limit';
import { distributedCacheHealthStatus, isRedisConfigured } from '@/lib/api/redis-rest';
import { buildSloChecks, sloOverallOk } from '@/lib/api/slo-check';

const startedAt = Date.now();
export const WORKER_STALE_THRESHOLD_SEC = 300;

export interface BgJobsHealth {
  pendingCount: number;
  oldestPendingAgeSec: number | null;
  deadLetterCount: number;
  workerStale: boolean;
  /** Open jobs tanpa jobSchemaVersion (legacy orphan — worker EE tidak claim). */
  orphanLegacyCount: number;
  /** Open jobs status DISPATCHED (sering stuck setelah worker crash). */
  dispatchedCount: number;
}

export interface ExecutionPlatformHealth {
  deploymentMode: string;
  jobBusEnabled: boolean;
  platformVersion: string;
  messageBusAdapter: string;
  executionWave?: string;
}

export function buildExecutionPlatformHealth(): ExecutionPlatformHealth {
  const jobBusRaw = (process.env.JOB_BUS_ENABLED || '').trim().toLowerCase();
  const wave = (process.env.EXECUTION_WAVE || '').trim();
  return {
    deploymentMode: (process.env.DEPLOYMENT_MODE || 'serverless').trim(),
    jobBusEnabled: jobBusRaw === '1' || jobBusRaw === 'true',
    platformVersion: (
      process.env.EXECUTION_PLATFORM_VERSION
      || process.env.PLATFORM_VERSION
      || '1'
    ).trim(),
    messageBusAdapter: (process.env.MESSAGE_BUS_ADAPTER || 'noop').trim(),
    ...(wave ? { executionWave: wave } : {}),
  };
}

export interface HealthPayload {
  status: 'ok' | 'degraded';
  app: string;
  uptimeSec: number;
  checks: {
    database: 'ok' | 'fail' | 'skipped';
    databaseError?: string;
    transactions?: 'ok' | 'fail' | 'skipped';
    transactionsError?: string;
    replicaSet?: string;
    rateLimit?: 'redis' | 'memory';
    cache?: 'redis' | 'memory';
    cacheStatus?: 'ok' | 'fail' | 'skipped';
    integrationReconcile?: {
      totalMismatch: number;
      checkedAt?: string;
      neverRun?: boolean;
      message?: string;
    };
    worker?: BgJobsHealth;
    slo?: import('@/lib/api/slo-check').SloChecks;
    execution?: ExecutionPlatformHealth;
  };
  timestamp: string;
}

const OPEN_QUEUE_STATUSES = ['PENDING', 'DISPATCHED', 'RETRYING'] as const;

export async function buildBgJobsHealth(db: Db): Promise<BgJobsHealth> {
  await ensureBgJobIndexes(db);
  const openFilter = { status: { $in: [...OPEN_QUEUE_STATUSES] } };
  const [pendingCount, oldest, deadLetterCount, orphanLegacyCount, dispatchedCount] = await Promise.all([
    db.collection('bg_jobs').countDocuments(openFilter),
    db.collection('bg_jobs').findOne(openFilter, {
      sort: { createdAt: 1 },
      projection: { createdAt: 1 },
    }),
    db.collection('bg_jobs').countDocuments({
      status: 'FAILED',
      deadLetter: true,
    }),
    db.collection('bg_jobs').countDocuments({
      ...openFilter,
      $or: [
        { jobSchemaVersion: { $exists: false } },
        { jobSchemaVersion: null },
      ],
    }),
    db.collection('bg_jobs').countDocuments({ status: 'DISPATCHED' }),
  ]);
  const oldestPendingAgeSec = oldest?.createdAt
    ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000)
    : null;
  const workerStale = oldestPendingAgeSec != null && oldestPendingAgeSec > WORKER_STALE_THRESHOLD_SEC;
  return {
    pendingCount,
    oldestPendingAgeSec,
    deadLetterCount,
    workerStale,
    orphanLegacyCount,
    dispatchedCount,
  };
}

export async function buildHealthResponse(db: Db | null, appName: string): Promise<HealthPayload> {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  let database: HealthPayload['checks']['database'] = 'skipped';
  let databaseError: string | undefined;
  let worker: BgJobsHealth | undefined;
  let transactions: HealthPayload['checks']['transactions'] = 'skipped';
  let transactionsError: string | undefined;
  let replicaSet: string | undefined;

  if (db) {
    try {
      await db.command({ ping: 1 });
      database = 'ok';
      try {
        worker = await buildBgJobsHealth(db);
      } catch {
        worker = undefined;
      }
      const replica = await checkMongoReplicaSet(db);
      transactions = replica.status;
      if (replica.setName) replicaSet = replica.setName;
      if (replica.error) transactionsError = replica.error;
    } catch (e) {
      database = 'fail';
      databaseError = e instanceof Error ? e.message : 'ping failed';
    }
  } else {
    database = 'fail';
    databaseError = 'database connection unavailable';
  }

  const cacheStatus = distributedCacheHealthStatus();
  let integrationReconcile: HealthPayload['checks']['integrationReconcile'];
  if (db && database === 'ok') {
    try {
      const latest = await db.collection('integration_reconcile_reports')
        .find({})
        .sort({ createdAt: -1 })
        .limit(1)
        .project({ summary: 1, createdAt: 1 })
        .toArray();
      const row = latest[0];
      if (row?.summary) {
        const summary = row.summary as { totalMismatch?: number };
        integrationReconcile = {
          totalMismatch: Number(summary.totalMismatch) || 0,
          checkedAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
        };
      } else {
        integrationReconcile = {
          totalMismatch: 0,
          neverRun: true,
          message: 'Cron integration reconcile belum pernah dijalankan',
        };
      }
    } catch {
      integrationReconcile = undefined;
    }
  }

  const dbReady = database === 'ok';
  const txReady = transactions !== 'fail';
  const cacheReady = cacheStatus !== 'fail';
  const reconcileReady = !integrationReconcile
    || (integrationReconcile.totalMismatch === 0
      && !(integrationReconcile.neverRun && process.env.NODE_ENV === 'production'));
  const slo = await buildSloChecks(db);
  const sloReady = sloOverallOk(slo);
  return {
    status: dbReady && txReady && cacheReady && reconcileReady && sloReady ? 'ok' : 'degraded',
    app: appName,
    uptimeSec,
    checks: {
      database,
      ...(databaseError ? { databaseError } : {}),
      transactions,
      ...(transactionsError ? { transactionsError } : {}),
      ...(replicaSet ? { replicaSet } : {}),
      rateLimit: isDistributedRateLimitEnabled() ? 'redis' : 'memory',
      cache: isRedisConfigured() ? 'redis' : 'memory',
      cacheStatus,
      ...(integrationReconcile ? { integrationReconcile } : {}),
      ...(worker ? { worker } : {}),
      slo,
      execution: buildExecutionPlatformHealth(),
    },
    timestamp: new Date().toISOString(),
  };
}

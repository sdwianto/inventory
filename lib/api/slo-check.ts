/** SLO aggregation untuk health endpoint Inventory (P1.1c mirror). */

import type { Db } from 'mongodb';
import { WORKER_STALE_THRESHOLD_SEC } from '@/lib/api/health';
import { alertOnSloBreaches } from '@/lib/api/slo-alert';

export interface SloChecks {
  database?: { ok: boolean };
  workerPendingAge?: { ok: boolean; oldestPendingAgeSec: number | null; thresholdSec: number };
  webhookInboxFailed1h?: { ok: boolean; failedCount: number; threshold: number };
  integrationReconcile?: { ok: boolean; totalMismatch: number; neverRun?: boolean };
  deadLetterJobs?: { ok: boolean; count: number; threshold: number };
}

export async function buildSloChecks(db: Db | null): Promise<SloChecks> {
  const checks: SloChecks = {};

  if (db) {
    try {
      await db.command({ ping: 1 });
      checks.database = { ok: true };
    } catch {
      checks.database = { ok: false };
    }

    try {
      const oldest = await db.collection('bg_jobs').findOne(
        { status: 'PENDING' },
        { sort: { createdAt: 1 }, projection: { createdAt: 1 } },
      );
      const oldestPendingAgeSec = oldest?.createdAt
        ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000)
        : null;
      checks.workerPendingAge = {
        ok: oldestPendingAgeSec == null || oldestPendingAgeSec < WORKER_STALE_THRESHOLD_SEC,
        oldestPendingAgeSec,
        thresholdSec: WORKER_STALE_THRESHOLD_SEC,
      };
    } catch {
      checks.workerPendingAge = { ok: true, oldestPendingAgeSec: null, thresholdSec: WORKER_STALE_THRESHOLD_SEC };
    }

    try {
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const failedCount = await db.collection('webhook_inbox').countDocuments({
        status: 'FAILED',
        createdAt: { $gte: since },
      });
      checks.webhookInboxFailed1h = { ok: failedCount < 5, failedCount, threshold: 5 };
    } catch {
      checks.webhookInboxFailed1h = { ok: true, failedCount: 0, threshold: 5 };
    }

    try {
      const latest = await db.collection('integration_reconcile_reports')
        .find({})
        .sort({ createdAt: -1 })
        .limit(1)
        .project({ summary: 1 })
        .toArray();
      const row = latest[0];
      const summary = row?.summary as { totalMismatch?: number } | undefined;
      const totalMismatch = Number(summary?.totalMismatch) || 0;
      checks.integrationReconcile = {
        ok: totalMismatch === 0 && (!!row || process.env.NODE_ENV !== 'production'),
        totalMismatch,
        neverRun: !row,
      };
    } catch {
      checks.integrationReconcile = { ok: true, totalMismatch: 0 };
    }

    try {
      const count = await db.collection('bg_jobs').countDocuments({
        status: 'FAILED',
        deadLetter: true,
      });
      const threshold = process.env.NODE_ENV === 'production' ? 3 : 25;
      checks.deadLetterJobs = { ok: count < threshold, count, threshold };
    } catch {
      checks.deadLetterJobs = { ok: true, count: 0, threshold: 3 };
    }
  }

  void alertOnSloBreaches(db, checks).catch(() => {});
  return checks;
}

export function sloOverallOk(checks: SloChecks): boolean {
  return (
    (checks.database?.ok !== false)
    && (checks.workerPendingAge?.ok !== false)
    && (checks.webhookInboxFailed1h?.ok !== false)
    && (checks.integrationReconcile?.ok !== false)
    && (checks.deadLetterJobs?.ok !== false)
  );
}

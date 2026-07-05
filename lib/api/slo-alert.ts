/** Ops alert saat SLO breach — Inventory (P1.1c). */

import type { Db } from 'mongodb';
import { logger } from '@/lib/api/logger';
import type { SloChecks } from '@/lib/api/slo-check';

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

type SloAlertKind =
  | 'workerPendingAge'
  | 'webhookInboxFailed1h'
  | 'integrationReconcile'
  | 'deadLetterJobs';

async function shouldSendAlert(db: Db | null, kind: SloAlertKind): Promise<boolean> {
  if (!db) return true;
  const key = `slo_alert_last:${kind}`;
  try {
    const row = await db.collection('system_meta').findOne({ key });
    const lastAt = row?.value?.at ? new Date(String(row.value.at)).getTime() : 0;
    if (lastAt && Date.now() - lastAt < ALERT_COOLDOWN_MS) return false;
    await db.collection('system_meta').updateOne(
      { key },
      {
        $set: { key, value: { at: new Date() }, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  } catch {
    return true;
  }
  return true;
}

async function sendOpsAlert(title: string, body: Record<string, unknown>): Promise<void> {
  const webhook = (process.env.OPS_ALERT_WEBHOOK_URL || '').trim();
  const payload = {
    title,
    service: 'inventory-app',
    at: new Date().toISOString(),
    ...body,
  };
  logger.warn('slo_breach', payload);
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    logger.warn('ops_alert_webhook_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function alertOnSloBreaches(db: Db | null, checks: SloChecks): Promise<void> {
  if (checks.workerPendingAge && !checks.workerPendingAge.ok) {
    if (await shouldSendAlert(db, 'workerPendingAge')) {
      await sendOpsAlert('SLO breach: BG jobs PENDING age', {
        kind: 'workerPendingAge',
        oldestPendingAgeSec: checks.workerPendingAge.oldestPendingAgeSec,
        thresholdSec: checks.workerPendingAge.thresholdSec,
      });
    }
  }
  if (checks.webhookInboxFailed1h && !checks.webhookInboxFailed1h.ok) {
    if (await shouldSendAlert(db, 'webhookInboxFailed1h')) {
      await sendOpsAlert('SLO breach: webhook inbox FAILED 1h', {
        kind: 'webhookInboxFailed1h',
        failedCount: checks.webhookInboxFailed1h.failedCount,
        threshold: checks.webhookInboxFailed1h.threshold,
      });
    }
  }
  if (checks.integrationReconcile && !checks.integrationReconcile.ok) {
    if (await shouldSendAlert(db, 'integrationReconcile')) {
      await sendOpsAlert('SLO breach: integration reconcile', {
        kind: 'integrationReconcile',
        totalMismatch: checks.integrationReconcile.totalMismatch,
        neverRun: checks.integrationReconcile.neverRun,
      });
    }
  }
  if (checks.deadLetterJobs && !checks.deadLetterJobs.ok) {
    if (await shouldSendAlert(db, 'deadLetterJobs')) {
      await sendOpsAlert('SLO breach: dead letter jobs', {
        kind: 'deadLetterJobs',
        count: checks.deadLetterJobs.count,
        threshold: checks.deadLetterJobs.threshold,
      });
    }
  }
}

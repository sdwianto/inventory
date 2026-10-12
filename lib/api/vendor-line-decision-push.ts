/**
 * Kirim keputusan purchasing atas baris tambahan vendor (diterima / ditolak) ke Sales, supaya vendor
 * melihatnya di baris SO dan baris yang ditolak tidak dikirim. Intent dicatat di integration_outbox
 * dalam TX keputusan; job VENDOR_LINE_DECISION_PUSH mengirimnya, rekonsiliasi menyapu sisanya.
 */

import type { ClientSession, Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { txOpts } from '@/lib/api/transaction';
import {
  INTEGRATION_OUTBOX_COLLECTION,
  INTEGRATION_OUTBOX_TYPES,
  markOutboxDone,
  markOutboxFailed,
  type IntegrationOutboxDoc,
} from '@/lib/api/integration-outbox';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { integrationCorrelationId } from '@/lib/api/integration-common';
import { createIntegrationClient } from '@/lib/integration/client';
import { logger } from '@/lib/api/logger';

const TYPE = INTEGRATION_OUTBOX_TYPES.ENSURE_PUSH_VENDOR_LINE_DECISION;
const STALE_PROCESSING_MS = 2 * 60 * 1000;
/** Sweep otomatis berhenti setelah batas ini — kegagalan permanen tidak diulang selamanya. */
export const MAX_DECISION_PUSH_ATTEMPTS = 8;

export type VendorLineDecisionPayload = {
  poId: string;
  noPO: string;
  lineId: string;
  vendorTenantId: string;
  salesOrderId?: string | null;
  noSO?: string | null;
  kode?: string | null;
  decision: 'ACCEPTED' | 'REJECTED';
  mode: string;
  reason?: string | null;
  decidedBy?: string | null;
  decidedAt: string;
};

/** Catat intent push dalam TX keputusan. Keputusan per baris final — duplikat diabaikan. */
export async function insertVendorLineDecisionOutbox(
  db: Db,
  tenantId: string,
  payload: VendorLineDecisionPayload,
  session?: ClientSession,
): Promise<void> {
  if (!payload.vendorTenantId) return;
  const now = new Date();
  const doc: IntegrationOutboxDoc = {
    id: randomUUID(),
    type: TYPE,
    aggregateId: `${payload.poId}:${payload.lineId}`,
    tenantId,
    payload: payload as unknown as Record<string, unknown>,
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    correlationId: integrationCorrelationId(payload.poId, payload.noPO) || null,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
  };
  try {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).insertOne(doc, txOpts(session));
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? Number((e as { code: number }).code) : 0;
    if (code !== 11000) throw e;
  }
}

async function claim(db: Db, id: string): Promise<IntegrationOutboxDoc | null> {
  const now = new Date();
  return await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOneAndUpdate(
    {
      id,
      type: TYPE,
      $or: [
        { status: { $in: ['PENDING', 'FAILED'] } },
        { status: 'PROCESSING', updatedAt: { $lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
      ],
    },
    { $set: { status: 'PROCESSING', updatedAt: now }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ) as IntegrationOutboxDoc | null;
}

async function pushOne(db: Db, row: IntegrationOutboxDoc): Promise<void> {
  const p = row.payload as unknown as VendorLineDecisionPayload;
  const apiKey = await getSalesApiKeyForVendor(db, row.tenantId, p.vendorTenantId);
  if (!apiKey) throw new Error('API key vendor tidak tersedia');
  const config = await getIntegrationConfig(db, row.tenantId, p.vendorTenantId);
  await createIntegrationClient(db).pushCustomerPoLineDecision({
    salesAppUrl: config.salesAppUrl,
    apiKey,
    correlationId: row.correlationId || undefined,
    idempotencyKey: `cpo-line-decision:${p.poId}:${p.lineId}:${p.decision}`,
    body: {
      customerTenantId: row.tenantId,
      vendorTenantId: p.vendorTenantId,
      customerPoId: p.poId,
      noPO: p.noPO,
      salesOrderId: p.salesOrderId || undefined,
      noSO: p.noSO || undefined,
      lineId: p.lineId,
      kode: p.kode || undefined,
      decision: p.decision,
      mode: p.mode,
      reason: p.reason || undefined,
      decidedBy: p.decidedBy || undefined,
      decidedAt: p.decidedAt,
    },
  });
}

/** Kirim semua keputusan yang belum terkirim untuk satu PO. */
export async function drainVendorLineDecisionsForPo(
  db: Db,
  tenantId: string,
  poId: string,
): Promise<{ pushed: number; failed: Array<{ lineId: string; error: string }> }> {
  const rows = await db.collection(INTEGRATION_OUTBOX_COLLECTION).find({
    type: TYPE,
    tenantId,
    'payload.poId': poId,
    status: { $in: ['PENDING', 'FAILED', 'PROCESSING'] },
  }).project({ id: 1 }).limit(100).toArray();
  let pushed = 0;
  const failed: Array<{ lineId: string; error: string }> = [];
  for (const r of rows) {
    const row = await claim(db, String(r.id));
    if (!row) continue;
    const lineId = String((row.payload as Record<string, unknown>).lineId || '');
    try {
      await pushOne(db, row);
      await markOutboxDone(db, row.id);
      pushed += 1;
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
      await markOutboxFailed(db, row.id, error);
      failed.push({ lineId, error });
      logger.warn('vendor_line_decision_push_failed', { tenantId, poId, lineId, attempts: row.attempts, error });
    }
  }
  return { pushed, failed };
}

export async function enqueueVendorLineDecisionPush(
  db: Db,
  tenantId: string,
  poId: string,
  dedupeKey: string,
): Promise<void> {
  try {
    const { enqueueJob, JOB_TYPES, scheduleJobProcessing } = await import('@/lib/api/bg-jobs');
    await enqueueJob(db, {
      type: JOB_TYPES.VENDOR_LINE_DECISION_PUSH,
      tenantId,
      payload: { poId, dedupeKey },
    });
    scheduleJobProcessing(db, { limit: 2 });
  } catch (e) {
    logger.warn('vendor_line_decision_enqueue_failed', { tenantId, poId, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function runVendorLineDecisionPushJob(
  db: Db,
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const poId = String(payload.poId || '').trim();
  if (!poId) return { error: 'poId wajib di payload VENDOR_LINE_DECISION_PUSH' };
  const out = await drainVendorLineDecisionsForPo(db, tenantId, poId);
  if (out.failed.length) {
    return { error: out.failed.map((f) => `${f.lineId}: ${f.error}`).join('; ').slice(0, 2000), pushed: out.pushed };
  }
  return { ok: true, pushed: out.pushed };
}

/** Sapu keputusan yang tertahan (job gagal / worker mati) — dipanggil rekonsiliasi berkala. */
export async function sweepStaleVendorLineDecisions(
  db: Db,
  opts: { tenantId?: string; olderThanMs?: number; now?: Date } = {},
): Promise<{ stale: number; requeuedPos: number; exhausted: number }> {
  const now = opts.now || new Date();
  const before = new Date(now.getTime() - (opts.olderThanMs ?? 10 * 60 * 1000));
  const rows = await db.collection(INTEGRATION_OUTBOX_COLLECTION).find({
    type: TYPE,
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    status: { $in: ['PENDING', 'FAILED', 'PROCESSING'] },
    updatedAt: { $lt: before },
  }).project({ tenantId: 1, payload: 1, attempts: 1 }).limit(500).toArray();
  const pos = new Map<string, string>();
  let exhausted = 0;
  for (const r of rows) {
    if (Number(r.attempts || 0) >= MAX_DECISION_PUSH_ATTEMPTS) {
      exhausted += 1;
      continue;
    }
    pos.set(String((r.payload as Record<string, unknown>)?.poId || ''), String(r.tenantId || 'default'));
  }
  const hour = Math.floor(now.getTime() / 3_600_000);
  for (const [poId, tenantId] of pos) {
    if (poId) await enqueueVendorLineDecisionPush(db, tenantId, poId, `vendor-line-decision-sweep:${poId}:${hour}`);
  }
  return { stale: rows.length, requeuedPos: pos.size, exhausted };
}

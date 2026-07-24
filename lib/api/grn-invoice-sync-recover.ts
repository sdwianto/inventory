/**
 * Recover GRN stuck in PENDING/SYNCING invoice sync (awaiting sales invoice.posted).
 * Does not poll Sales jobs — re-enqueues GRN_INVOICE_SYNC which:
 *   1) pull-reconcile invoice by noDO from Sales
 *   2) preferSync notify if still missing
 */

import type { Db } from 'mongodb';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

/** After this age without noInvoice, re-enqueue notify (cepat; dulu 60m → 3m). */
export const GRN_INVOICE_PENDING_STALE_MS = 45 * 1000;

export type GrnInvoiceSyncRow = {
  id?: string;
  tenantId?: string;
  noInvoice?: string | null;
  invoiceSyncStatus?: string | null;
  invoiceSyncAt?: Date | string | null;
  postedAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function anchorMs(row: GrnInvoiceSyncRow): number | null {
  const raw = row.invoiceSyncAt || row.postedAt || row.updatedAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Age in ms since waiting for invoice callback; null if not in flight. */
export function grnInvoiceSyncWaitMs(row: GrnInvoiceSyncRow, now = Date.now()): number | null {
  const sync = String(row.invoiceSyncStatus || '');
  if (sync !== 'PENDING' && sync !== 'SYNCING') return null;
  if (row.noInvoice) return null;
  const a = anchorMs(row);
  if (a == null) return null;
  return Math.max(0, now - a);
}

export function isGrnInvoiceSyncStale(row: GrnInvoiceSyncRow, now = Date.now()): boolean {
  const wait = grnInvoiceSyncWaitMs(row, now);
  return wait != null && wait >= GRN_INVOICE_PENDING_STALE_MS;
}

/**
 * Cancel mis-routed GRN_INVOICE_SYNC jobs (domain=integration on inventory DB —
 * never claimed by inventory-worker). Safe to call often.
 */
export async function cancelMisroutedGrnInvoiceSyncJobs(db: Db): Promise<number> {
  const res = await db.collection('bg_jobs').updateMany(
    {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      domain: 'integration',
      status: { $in: ['PENDING', 'DISPATCHED', 'RETRYING', 'WAITING_EXTERNAL'] },
    },
    {
      $set: {
        status: 'CANCELLED',
        updatedAt: new Date(),
        finishedAt: new Date(),
        lastError: 'domain migrated to inventory (EE-9D)',
      },
    },
  );
  return res.modifiedCount || 0;
}

/**
 * For list/detail rows: enqueue GRN_INVOICE_SYNC when PENDING/SYNCING longer than stale window.
 * Fire-and-forget safe — dedupe on running job per grnId.
 */
export async function recoverStuckGrnInvoiceSyncs(
  db: Db,
  rows: GrnInvoiceSyncRow[],
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? 10;
  const now = Date.now();
  await cancelMisroutedGrnInvoiceSyncJobs(db).catch(() => 0);
  let enqueued = 0;
  for (const row of rows) {
    if (enqueued >= limit) break;
    const id = String(row.id || '').trim();
    if (!id || !isGrnInvoiceSyncStale(row, now)) continue;
    const tenantId = normalizeTenantId(String(row.tenantId || 'default'));
    await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId,
      grnId: id,
      payload: {
        grnId: id,
        dedupeKey: `stuck-recover:${id}:${Math.floor(now / GRN_INVOICE_PENDING_STALE_MS)}`,
        recoverStuck: true,
      },
    });
    enqueued += 1;
  }
  if (enqueued > 0) {
    scheduleJobProcessing(db, { limit: Math.min(20, enqueued) });
  }
  return enqueued;
}

/**
 * Background sweeper (scheduler) — tidak bergantung buka halaman Penerimaan.
 * Cari GRN POSTED yang PENDING/SYNCING tanpa noInvoice, lalu recover (pull + preferSync).
 */
export async function sweepAllStuckGrnInvoiceSyncs(
  db: Db,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; enqueued: number; cancelledMisrouted: number }> {
  const limit = opts.limit ?? 40;
  const now = Date.now();
  const cancelledMisrouted = await cancelMisroutedGrnInvoiceSyncJobs(db).catch(() => 0);
  const rows = await db.collection('goods_receipts').find({
    status: 'POSTED',
    invoiceSyncStatus: { $in: ['PENDING', 'SYNCING'] },
    $or: [
      { noInvoice: null },
      { noInvoice: { $exists: false } },
      { noInvoice: '' },
    ],
  }).project({
    id: 1,
    tenantId: 1,
    noInvoice: 1,
    invoiceSyncStatus: 1,
    invoiceSyncAt: 1,
    postedAt: 1,
    updatedAt: 1,
  }).sort({ invoiceSyncAt: 1, postedAt: 1 }).limit(limit * 2).toArray() as GrnInvoiceSyncRow[];

  let enqueued = 0;
  for (const row of rows) {
    if (enqueued >= limit) break;
    const id = String(row.id || '').trim();
    if (!id || !isGrnInvoiceSyncStale(row, now)) continue;
    const tenantId = normalizeTenantId(String(row.tenantId || 'default'));
    await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId,
      grnId: id,
      payload: {
        grnId: id,
        recoverStuck: true,
        dedupeKey: `invoice-sweep:${id}:${Math.floor(now / GRN_INVOICE_PENDING_STALE_MS)}`,
      },
    });
    enqueued += 1;
  }
  if (enqueued > 0) {
    scheduleJobProcessing(db, { limit: Math.min(20, enqueued) });
  }

  // H1.1: also drain PENDING/FAILED business outbox (intent may exist while GRN status already FAILED).
  try {
    const { listPendingGrnInvoiceOutbox } = await import('@/lib/api/integration-outbox');
    const pendingOutbox = await listPendingGrnInvoiceOutbox(db, { limit: Math.max(0, limit - enqueued) });
    for (const row of pendingOutbox) {
      if (enqueued >= limit) break;
      await enqueueJob(db, {
        type: JOB_TYPES.GRN_INVOICE_SYNC,
        tenantId: normalizeTenantId(row.tenantId),
        grnId: row.aggregateId,
        payload: {
          grnId: row.aggregateId,
          recoverOutbox: true,
          dedupeKey: `outbox-sweep:${row.aggregateId}:${Math.floor(now / GRN_INVOICE_PENDING_STALE_MS)}`,
        },
      });
      enqueued += 1;
    }
    if (pendingOutbox.length > 0) {
      scheduleJobProcessing(db, { limit: Math.min(20, enqueued || 1) });
    }
  } catch {
    /* best-effort */
  }

  return { scanned: rows.length, enqueued, cancelledMisrouted };
}

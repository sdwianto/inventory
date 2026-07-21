/**
 * Recover GRN stuck in PENDING/SYNCING invoice sync (awaiting sales invoice.posted).
 * Does not poll Sales jobs — re-notifies via GRN_INVOICE_SYNC (deduped).
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

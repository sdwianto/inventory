/** Reconciliation nightly — diff CPO/GRN/hutang integrasi (Phase 4.4). */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { sweepStuckGrnPosting } from '@/lib/api/stuck-posting-sweep';

/** PENDING/FAILED without invoice — re-notify quickly (was 60m). */
const GRN_STALE_MS = 45 * 1000;
const GRN_SYNCING_STUCK_MS = 45 * 1000;
const PAGE = 200;
const MAX_PAGES = 25;

export interface IntegrationReconcileDiff {
  cpoStatusMismatch: Array<{ id: string; noPO: string; status: string; lastVendorEvent?: string }>;
  cpoWithoutVendorSo: Array<{ id: string; noPO: string; status: string }>;
  grnInvoiceNotDone: Array<{ id: string; noGRN?: string; noDO?: string; invoiceSyncStatus?: string }>;
  grnPostedWithoutDo: Array<{ id: string; noGRN?: string }>;
  hutangMissingVendorInvoice: Array<{ id: string; noHutang?: string; noPO?: string }>;
  autoFixEnqueued: number;
  stuckGrnReverted: number;
  truncated: boolean;
  scanned: Record<string, number>;
}

async function collectAll(
  db: Db,
  collection: string,
  filter: Record<string, unknown>,
  project: Record<string, number>,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; scanned: number }> {
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  let lastId = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageFilter = lastId
      ? { $and: [filter, { id: { $gt: lastId } }] }
      : filter;
    const batch = await db.collection(collection)
      .find(pageFilter)
      .project(project)
      .sort({ id: 1 })
      .limit(PAGE)
      .toArray() as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE) {
      return { rows, truncated, scanned: rows.length };
    }
    const nextId = String(batch[batch.length - 1]?.id || '');
    if (!nextId || nextId === lastId) {
      return { rows, truncated, scanned: rows.length };
    }
    lastId = nextId;
  }
  truncated = true;
  return { rows, truncated, scanned: rows.length };
}

export async function runIntegrationReconcile(
  db: Db,
  tenantId?: string | null,
): Promise<IntegrationReconcileDiff> {
  const tid = tenantId ? normalizeTenantId(tenantId) : null;
  const tenantFilter = tid ? tenantIdMatchFilter(tid) : {};

  const stuck = await sweepStuckGrnPosting(db);

  const cpoMismatchQ = await collectAll(db, 'customer_purchase_orders', {
    ...tenantFilter,
    lastVendorEvent: 'invoice.posted',
    status: { $nin: ['INVOICED', 'CANCELLED', 'REJECTED', 'RECEIVED'] },
  }, { id: 1, noPO: 1, status: 1, lastVendorEvent: 1 });

  const cpoWithoutSoQ = await collectAll(db, 'customer_purchase_orders', {
    ...tenantFilter,
    status: { $in: ['CONFIRMED', 'SHIPPED', 'RECEIVED', 'INVOICED', 'PARTIAL_SHIPPED', 'PARTIAL_RECEIVED'] },
    $or: [
      { vendorSoId: { $exists: false } },
      { vendorSoId: null },
      { vendorSoId: '' },
    ],
  }, { id: 1, noPO: 1, status: 1 });

  const grnWithoutDoQ = await collectAll(db, 'goods_receipts', {
    ...tenantFilter,
    status: 'POSTED',
    $or: [
      { noDO: { $exists: false } },
      { noDO: null },
      { noDO: '' },
    ],
  }, { id: 1, noGRN: 1 });

  const grnCutoff = new Date(Date.now() - GRN_STALE_MS);
  const grnSyncingCutoff = new Date(Date.now() - GRN_SYNCING_STUCK_MS);
  const grnInvoiceQ = await collectAll(db, 'goods_receipts', {
    ...tenantFilter,
    status: 'POSTED',
    $or: [
      {
        invoiceSyncStatus: 'SYNCING',
        postedAt: { $lt: grnSyncingCutoff },
      },
      {
        invoiceSyncStatus: { $in: ['PENDING', 'FAILED'] },
        postedAt: { $lt: grnCutoff },
      },
    ],
  }, { id: 1, noGRN: 1, noDO: 1, invoiceSyncStatus: 1, tenantId: 1 });

  const hutangQ = await collectAll(db, 'hutang', {
    ...tenantFilter,
    referenceType: 'VENDOR_INVOICE',
    $or: [
      { vendorInvoiceId: { $exists: false } },
      { vendorInvoiceId: null },
      { vendorInvoiceId: '' },
    ],
  }, { id: 1, noHutang: 1, noPO: 1 });

  let autoFixEnqueued = 0;
  for (const grn of grnInvoiceQ.rows) {
    const grnTenant = normalizeTenantId(String(grn.tenantId || tid || 'default'));
    await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId: grnTenant,
      grnId: String(grn.id),
      payload: { dedupeKey: `reconcile-grn:${grn.id}` },
    });
    autoFixEnqueued += 1;
  }
  if (autoFixEnqueued > 0) scheduleJobProcessing(db, { limit: Math.min(20, autoFixEnqueued) });

  const truncated = cpoMismatchQ.truncated || cpoWithoutSoQ.truncated
    || grnWithoutDoQ.truncated || grnInvoiceQ.truncated || hutangQ.truncated;

  const diff: IntegrationReconcileDiff = {
    cpoStatusMismatch: cpoMismatchQ.rows.map((r) => ({
      id: String(r.id),
      noPO: String(r.noPO || ''),
      status: String(r.status || ''),
      lastVendorEvent: r.lastVendorEvent ? String(r.lastVendorEvent) : undefined,
    })),
    cpoWithoutVendorSo: cpoWithoutSoQ.rows.map((r) => ({
      id: String(r.id),
      noPO: String(r.noPO || ''),
      status: String(r.status || ''),
    })),
    grnPostedWithoutDo: grnWithoutDoQ.rows.map((r) => ({
      id: String(r.id),
      noGRN: r.noGRN ? String(r.noGRN) : undefined,
    })),
    grnInvoiceNotDone: grnInvoiceQ.rows.map((r) => ({
      id: String(r.id),
      noGRN: r.noGRN ? String(r.noGRN) : undefined,
      noDO: r.noDO ? String(r.noDO) : undefined,
      invoiceSyncStatus: r.invoiceSyncStatus ? String(r.invoiceSyncStatus) : undefined,
    })),
    hutangMissingVendorInvoice: hutangQ.rows.map((r) => ({
      id: String(r.id),
      noHutang: r.noHutang ? String(r.noHutang) : undefined,
      noPO: r.noPO ? String(r.noPO) : undefined,
    })),
    autoFixEnqueued,
    stuckGrnReverted: stuck.grnReverted,
    truncated,
    scanned: {
      cpoMismatch: cpoMismatchQ.scanned,
      cpoWithoutSo: cpoWithoutSoQ.scanned,
      grnWithoutDo: grnWithoutDoQ.scanned,
      grnInvoice: grnInvoiceQ.scanned,
      hutang: hutangQ.scanned,
    },
  };

  const reportTenant = tid || 'system';
  await db.collection('integration_reconcile_reports').insertOne({
    id: uuidv4(),
    tenantId: reportTenant,
    diff,
    summary: {
      cpoMismatch: diff.cpoStatusMismatch.length,
      cpoWithoutSo: diff.cpoWithoutVendorSo.length,
      grnStale: diff.grnInvoiceNotDone.length,
      grnWithoutDo: diff.grnPostedWithoutDo.length,
      hutangOrphan: diff.hutangMissingVendorInvoice.length,
      autoFixEnqueued,
      stuckGrnReverted: stuck.grnReverted,
      truncated,
      totalMismatch:
        diff.cpoStatusMismatch.length
        + diff.cpoWithoutVendorSo.length
        + diff.grnInvoiceNotDone.length
        + diff.grnPostedWithoutDo.length
        + diff.hutangMissingVendorInvoice.length,
    },
    createdAt: new Date(),
  });

  return diff;
}

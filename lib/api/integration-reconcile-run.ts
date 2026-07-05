/** Reconciliation nightly — diff CPO/GRN/hutang integrasi (Phase 4.4). */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';

const GRN_STALE_MS = 60 * 60 * 1000;
const GRN_SYNCING_STUCK_MS = 5 * 60 * 1000;

export interface IntegrationReconcileDiff {
  cpoStatusMismatch: Array<{ id: string; noPO: string; status: string; lastVendorEvent?: string }>;
  cpoWithoutVendorSo: Array<{ id: string; noPO: string; status: string }>;
  grnInvoiceNotDone: Array<{ id: string; noGRN?: string; noDO?: string; invoiceSyncStatus?: string }>;
  grnPostedWithoutDo: Array<{ id: string; noGRN?: string }>;
  hutangMissingVendorInvoice: Array<{ id: string; noHutang?: string; noPO?: string }>;
  autoFixEnqueued: number;
}

export async function runIntegrationReconcile(
  db: Db,
  tenantId?: string | null,
): Promise<IntegrationReconcileDiff> {
  const tid = tenantId ? normalizeTenantId(tenantId) : null;
  const tenantFilter = tid ? tenantIdMatchFilter(tid) : {};

  const cpoStatusMismatch = await db.collection('customer_purchase_orders').find({
    ...tenantFilter,
    lastVendorEvent: 'invoice.posted',
    status: { $nin: ['INVOICED', 'CANCELLED', 'REJECTED', 'RECEIVED'] },
  }).project({ id: 1, noPO: 1, status: 1, lastVendorEvent: 1 }).limit(200).toArray();

  const cpoWithoutVendorSo = await db.collection('customer_purchase_orders').find({
    ...tenantFilter,
    status: { $in: ['CONFIRMED', 'SHIPPED', 'RECEIVED', 'INVOICED'] },
    $or: [
      { salesOrderId: { $exists: false } },
      { salesOrderId: null },
      { salesOrderId: '' },
    ],
  }).project({ id: 1, noPO: 1, status: 1 }).limit(100).toArray();

  const grnPostedWithoutDo = await db.collection('goods_receipts').find({
    ...tenantFilter,
    status: 'POSTED',
    $or: [
      { noDO: { $exists: false } },
      { noDO: null },
      { noDO: '' },
    ],
  }).project({ id: 1, noGRN: 1 }).limit(100).toArray();

  const grnCutoff = new Date(Date.now() - GRN_STALE_MS);
  const grnSyncingCutoff = new Date(Date.now() - GRN_SYNCING_STUCK_MS);
  const grnInvoiceNotDone = await db.collection('goods_receipts').find({
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
  }).project({ id: 1, noGRN: 1, noDO: 1, invoiceSyncStatus: 1, tenantId: 1 }).limit(200).toArray();

  const hutangMissingVendorInvoice = await db.collection('hutang').find({
    ...tenantFilter,
    referenceType: 'VENDOR_INVOICE',
    $or: [
      { vendorInvoiceId: { $exists: false } },
      { vendorInvoiceId: null },
      { vendorInvoiceId: '' },
    ],
  }).project({ id: 1, noHutang: 1, noPO: 1 }).limit(200).toArray();

  let autoFixEnqueued = 0;
  for (const grn of grnInvoiceNotDone) {
    const grnTenant = normalizeTenantId(String(grn.tenantId || tid || 'default'));
    await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId: grnTenant,
      grnId: grn.id,
      payload: { dedupeKey: `reconcile-grn:${grn.id}` },
    });
    autoFixEnqueued += 1;
  }
  if (autoFixEnqueued > 0) scheduleJobProcessing(db, { limit: 5 });

  const diff: IntegrationReconcileDiff = {
    cpoStatusMismatch: cpoStatusMismatch.map((r) => ({
      id: String(r.id),
      noPO: String(r.noPO || ''),
      status: String(r.status || ''),
      lastVendorEvent: r.lastVendorEvent ? String(r.lastVendorEvent) : undefined,
    })),
    cpoWithoutVendorSo: cpoWithoutVendorSo.map((r) => ({
      id: String(r.id),
      noPO: String(r.noPO || ''),
      status: String(r.status || ''),
    })),
    grnPostedWithoutDo: grnPostedWithoutDo.map((r) => ({
      id: String(r.id),
      noGRN: r.noGRN ? String(r.noGRN) : undefined,
    })),
    grnInvoiceNotDone: grnInvoiceNotDone.map((r) => ({
      id: String(r.id),
      noGRN: r.noGRN ? String(r.noGRN) : undefined,
      noDO: r.noDO ? String(r.noDO) : undefined,
      invoiceSyncStatus: r.invoiceSyncStatus ? String(r.invoiceSyncStatus) : undefined,
    })),
    hutangMissingVendorInvoice: hutangMissingVendorInvoice.map((r) => ({
      id: String(r.id),
      noHutang: r.noHutang ? String(r.noHutang) : undefined,
      noPO: r.noPO ? String(r.noPO) : undefined,
    })),
    autoFixEnqueued,
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

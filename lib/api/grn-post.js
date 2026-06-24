// Orkestrasi posting GRN — stok sync, CPO sync, invoice async.

import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import { enrichGrnDoc } from '@/lib/api/grn-enrich';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { warehouseLabel } from '@/lib/api/warehouses';

export async function postGoodsReceipt(db, { grn, tenantId, body, asyncInvoice = true }) {
  const stock = await applyGrnStockPosting(db, tenantId, grn, body?.items);
  if (stock.error) return { error: stock.error };

  const now = new Date();
  const lokasiSummary = [...stock.lokasiSet].map((k) => `${k} - ${warehouseLabel(k)}`).join(', ');

  const invoicePatch = {
    invoiceSyncStatus: 'NONE',
    invoiceSyncError: null,
    invoiceSyncAt: null,
  };

  const config = await getIntegrationConfig(db, tenantId);
  const canSyncInvoice = !!(config.salesApiKey && (grn.noDO || grn.vendorDeliveryId));

  if (canSyncInvoice) {
    if (asyncInvoice) {
      invoicePatch.invoiceSyncStatus = 'PENDING';
    } else {
      invoicePatch.invoiceSyncStatus = 'SYNCING';
    }
  } else if (!config.salesApiKey) {
    invoicePatch.invoiceSyncStatus = 'SKIPPED';
    invoicePatch.invoiceSyncError = 'not_paired';
  }

  await db.collection('goods_receipts').updateOne(
    { id: grn.id },
    {
      $set: {
        status: 'POSTED',
        items: stock.itemsFull,
        receivedTotal: stock.receivedTotal,
        lokasi: lokasiSummary,
        lokasiKodes: [...stock.lokasiSet],
        postedAt: now,
        userName: body?.userName,
        ...invoicePatch,
      },
    },
  );

  const posted = await db.collection('goods_receipts').findOne({ id: grn.id });
  const cpoSync = await syncCpoOnGrnPosted(db, posted);

  let invoiceSync = null;
  let jobId = null;

  if (canSyncInvoice && asyncInvoice) {
    const enq = await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId,
      grnId: grn.id,
      payload: { noGRN: grn.noGRN, noDO: grn.noDO },
    });
    jobId = enq.jobId;
    scheduleJobProcessing(db);
    invoiceSync = { async: true, jobId, status: 'PENDING' };
  } else if (canSyncInvoice && !asyncInvoice) {
    const { notifyGrnPostedToSales } = await import('@/lib/api/grn-notify-sales');
    invoiceSync = await notifyGrnPostedToSales(db, tenantId, posted);
    const patch = { invoiceSyncAt: new Date() };
    if (invoiceSync.error) {
      patch.invoiceSyncStatus = 'FAILED';
      patch.invoiceSyncError = invoiceSync.error;
    } else if (invoiceSync.skipped) {
      patch.invoiceSyncStatus = 'SKIPPED';
    } else {
      patch.invoiceSyncStatus = 'DONE';
      if (invoiceSync.noInvoice) patch.noInvoice = invoiceSync.noInvoice;
    }
    await db.collection('goods_receipts').updateOne({ id: grn.id }, { $set: patch });
    posted.invoiceSyncStatus = patch.invoiceSyncStatus;
    if (patch.noInvoice) posted.noInvoice = patch.noInvoice;
  }

  const enriched = await enrichGrnDoc(db, posted);
  return {
    ...enriched,
    cpoSync,
    invoiceSync,
    invoiceSyncStatus: posted.invoiceSyncStatus || enriched.invoiceSyncStatus,
  };
}

export async function replayGrnInvoiceAsync(db, { grn, tenantId }) {
  await db.collection('goods_receipts').updateOne(
    { id: grn.id },
    { $set: { invoiceSyncStatus: 'PENDING', invoiceSyncError: null } },
  );
  const enq = await enqueueJob(db, {
    type: JOB_TYPES.GRN_INVOICE_SYNC,
    tenantId,
    grnId: grn.id,
    payload: { replay: true },
  });
  scheduleJobProcessing(db);
  const refreshed = await db.collection('goods_receipts').findOne({ id: grn.id });
  const enriched = await enrichGrnDoc(db, refreshed);
  return { ...enriched, invoiceSync: { async: true, jobId: enq.jobId, status: 'PENDING' } };
}

// Orkestrasi posting GRN — stok sync, CPO sync, invoice async.

import type { Db } from 'mongodb';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import type { GrnDoc as StockGrnDoc } from '@/types/documents';
import { enrichGrnDoc } from '@/lib/api/grn-enrich';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing, processJobById } from '@/lib/api/bg-jobs';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { warehouseLabel } from '@/lib/api/warehouses';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import type { JsonObject } from '@/types/json';

type GrnDoc = StockGrnDoc & {
  id: string;
  invoiceSyncStatus?: string;
  invoiceSyncError?: string | null;
};

export type { GrnDoc };

interface PostGoodsReceiptParams {
  grn: GrnDoc;
  tenantId: string;
  body?: Record<string, unknown>;
  asyncInvoice?: boolean;
}

interface ReplayGrnInvoiceParams {
  grn: GrnDoc;
  tenantId: string;
}

export async function postGoodsReceipt(
  db: Db,
  { grn, tenantId, body, asyncInvoice = true }: PostGoodsReceiptParams,
): Promise<Record<string, unknown> & { error?: string }> {
  const salesApiKey = await getSalesApiKeyForVendor(
    db,
    tenantId,
    grn.vendorTenantId ? String(grn.vendorTenantId) : undefined,
  );
  const canSyncInvoice = !!(salesApiKey && (grn.noDO || grn.vendorDeliveryId));
  // Di Vercel, grn-posted inline sering timeout sebelum hutang terbentuk — pakai bg job.
  const syncInvoiceInline = asyncInvoice === false && !process.env.VERCEL;

  const txResult = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    const stock = await applyGrnStockPosting(
      txDb,
      tenantId,
      grn as StockGrnDoc,
      (body?.items ?? undefined) as JsonObject[] | undefined,
      session,
    );
    if (stock.error) return { error: stock.error };

    const now = new Date();
    const lokasiSet = stock.lokasiSet as Set<string>;
    const lokasiSummary = [...lokasiSet].map((k) => `${k} - ${warehouseLabel(k)}`).join(', ');

    const invoicePatch: Record<string, unknown> = {
      invoiceSyncStatus: 'NONE',
      invoiceSyncError: null,
      invoiceSyncAt: null,
    };

    if (canSyncInvoice) {
      invoicePatch.invoiceSyncStatus = asyncInvoice ? 'PENDING' : 'SYNCING';
    } else if (!salesApiKey) {
      invoicePatch.invoiceSyncStatus = 'SKIPPED';
      invoicePatch.invoiceSyncError = 'not_paired';
    }

    await txDb.collection('goods_receipts').updateOne(
      { id: grn.id },
      {
        $set: {
          status: 'POSTED',
          items: stock.itemsFull,
          receivedTotal: stock.receivedTotal,
          lokasi: lokasiSummary,
          lokasiKodes: [...lokasiSet],
          postedAt: now,
          userName: body?.userName,
          ...invoicePatch,
        },
      },
      txOpts(session),
    );

    await writeAuditLog(txDb, {
      tenantId,
      action: 'GRN_POSTED',
      entityType: 'goods_receipt',
      entityId: grn.id,
      summary: `GRN ${grn.noGRN || grn.id} posted — DO ${grn.noDO || '—'}`,
      userName: typeof body?.userName === 'string' ? body.userName : undefined,
      metadata: {
        noDO: grn.noDO,
        receivedTotal: stock.receivedTotal,
        lokasiKodes: [...lokasiSet],
      },
    }, session);

    return { lokasiSet, invoicePatch };
  });

  if ('error' in txResult && txResult.error) return { error: txResult.error };

  const posted = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
  if (!posted) return { error: 'GRN tidak ditemukan setelah posting' };

  const sideFx = await enqueueJob(db, {
    type: JOB_TYPES.GRN_POST_SIDE_EFFECTS,
    tenantId,
    grnId: grn.id,
    payload: { grnId: grn.id },
  });
  scheduleJobProcessing(db);

  let invoiceSync: Record<string, unknown> | null = null;
  let jobId: string | null = null;

  if (canSyncInvoice && !syncInvoiceInline) {
    const enq = await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId,
      grnId: grn.id,
      payload: { noGRN: grn.noGRN, noDO: grn.noDO },
    });
    jobId = enq.jobId;
    void processJobById(db, enq.jobId);
    scheduleJobProcessing(db);
    invoiceSync = { async: true, jobId, status: 'PENDING' };
  } else if (canSyncInvoice && syncInvoiceInline) {
    const { notifyGrnPostedToSales } = await import('@/lib/api/grn-notify-sales');
    try {
      invoiceSync = await notifyGrnPostedToSales(db, tenantId, posted) as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('grn_invoice_sync_inline_exception', { tenantId, grnId: grn.id, error: msg });
      invoiceSync = { error: msg };
    }

    const patch: Record<string, unknown> = { invoiceSyncAt: new Date() };
    if ('error' in invoiceSync && invoiceSync.error) {
      patch.invoiceSyncStatus = 'FAILED';
      patch.invoiceSyncError = invoiceSync.error;
      const enq = await enqueueJob(db, {
        type: JOB_TYPES.GRN_INVOICE_SYNC,
        tenantId,
        grnId: grn.id,
        payload: { noGRN: grn.noGRN, noDO: grn.noDO, retryAfterInline: true },
      });
      jobId = enq.jobId;
      void processJobById(db, enq.jobId);
      scheduleJobProcessing(db);
      invoiceSync = { ...invoiceSync, async: true, jobId: enq.jobId, status: 'PENDING' };
    } else if (invoiceSync.skipped) {
      patch.invoiceSyncStatus = 'SKIPPED';
      patch.invoiceSyncError = invoiceSync.reason || null;
    } else {
      patch.invoiceSyncStatus = 'DONE';
      if (invoiceSync.noInvoice) patch.noInvoice = invoiceSync.noInvoice;
      if (invoiceSync.invoiceId) patch.vendorInvoiceId = invoiceSync.invoiceId;
      const hutang = invoiceSync.hutang as Record<string, unknown> | undefined;
      if (hutang?.hutangId) patch.hutangId = hutang.hutangId;
    }
    await db.collection('goods_receipts').updateOne({ id: grn.id }, { $set: patch });
    posted.invoiceSyncStatus = String(patch.invoiceSyncStatus);
    if (patch.noInvoice) posted.noInvoice = String(patch.noInvoice);
    if (patch.hutangId) posted.hutangId = String(patch.hutangId);
  }

  logger.info('grn_posted', { tenantId, grnId: grn.id, noGRN: grn.noGRN, noDO: grn.noDO });

  const enriched = await enrichGrnDoc(db, posted);
  return {
    ...enriched,
    sideEffectsJobId: sideFx.jobId,
    invoiceSync,
    invoiceSyncStatus: posted.invoiceSyncStatus || enriched?.invoiceSyncStatus,
  };
}

export async function replayGrnInvoiceAsync(
  db: Db,
  { grn, tenantId }: ReplayGrnInvoiceParams,
): Promise<Record<string, unknown>> {
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
  void processJobById(db, enq.jobId);
  scheduleJobProcessing(db);
  const refreshed = await db.collection('goods_receipts').findOne({ id: grn.id });
  const enriched = await enrichGrnDoc(db, refreshed as unknown as GrnDoc);
  return { ...enriched, invoiceSync: { async: true, jobId: enq.jobId, status: 'PENDING' } };
}

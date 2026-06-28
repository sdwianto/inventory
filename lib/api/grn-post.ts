// Orkestrasi posting GRN — stok sync, CPO sync, invoice async.

import type { Db } from 'mongodb';
import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import type { GrnDoc as StockGrnDoc } from '@/types/documents';
import { enrichGrnDoc } from '@/lib/api/grn-enrich';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { warehouseLabel } from '@/lib/api/warehouses';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { tryAutoCompleteWrFromGrn } from '@/lib/api/maintenance-wr-loop';
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
  const config = await getIntegrationConfig(db, tenantId);
  const canSyncInvoice = !!(config.salesApiKey && (grn.noDO || grn.vendorDeliveryId));

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
    } else if (!config.salesApiKey) {
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

  const cpoSync = await syncCpoOnGrnPosted(db, posted);
  const wrLoop = await tryAutoCompleteWrFromGrn(db, posted);

  let invoiceSync: Record<string, unknown> | null = null;
  let jobId: string | null = null;

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
    invoiceSync = await notifyGrnPostedToSales(db, tenantId, posted) as Record<string, unknown>;
    const patch: Record<string, unknown> = { invoiceSyncAt: new Date() };
    if ('error' in invoiceSync && invoiceSync.error) {
      patch.invoiceSyncStatus = 'FAILED';
      patch.invoiceSyncError = invoiceSync.error;
    } else if (invoiceSync.skipped) {
      patch.invoiceSyncStatus = 'SKIPPED';
    } else {
      patch.invoiceSyncStatus = 'DONE';
      if (invoiceSync.noInvoice) patch.noInvoice = invoiceSync.noInvoice;
    }
    await db.collection('goods_receipts').updateOne({ id: grn.id }, { $set: patch });
    posted.invoiceSyncStatus = String(patch.invoiceSyncStatus);
    if (patch.noInvoice) posted.noInvoice = String(patch.noInvoice);
  }

  logger.info('grn_posted', { tenantId, grnId: grn.id, noGRN: grn.noGRN, noDO: grn.noDO });

  const enriched = await enrichGrnDoc(db, posted);
  return {
    ...enriched,
    cpoSync,
    wrLoop,
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
  scheduleJobProcessing(db);
  const refreshed = await db.collection('goods_receipts').findOne({ id: grn.id });
  const enriched = await enrichGrnDoc(db, refreshed as unknown as GrnDoc);
  return { ...enriched, invoiceSync: { async: true, jobId: enq.jobId, status: 'PENDING' } };
}

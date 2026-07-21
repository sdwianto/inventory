// Orkestrasi posting GRN — stok sync, CPO sync, invoice async.

import type { Db } from 'mongodb';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import type { GrnDoc as StockGrnDoc } from '@/types/documents';
import { enrichGrnDoc } from '@/lib/api/grn-enrich';
import { runGrnPostSideEffects } from '@/lib/api/grn-post-side-effects-run';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing, processJobById } from '@/lib/api/bg-jobs';
import { shouldProcessGrnJobInline } from '@/lib/api/execution-inline-grn';
import { shouldUseLegacyBgPoll } from '@/lib/api/execution-wave';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { warehouseLabel } from '@/lib/api/warehouses';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { createJournal } from '@/lib/api/journal';
import { buildGrnAccrualJournalLines } from '@/lib/api/journal-lines';
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
  // VPS: sync faktur in-request (Sales sync-first) agar DONE sebelum response POST.
  // Opt-out: GRN_INVOICE_ASYNC=1. Vercel: jangan block lambda kecuali asyncInvoice=false.
  const forceVpsInline = !shouldUseLegacyBgPoll()
    && process.env.GRN_INVOICE_ASYNC !== '1'
    && !process.env.VERCEL;
  const syncInvoiceInline = (asyncInvoice === false || forceVpsInline) && !process.env.VERCEL;

  const priorStatus = String(grn.status || 'DRAFT');
  let txResult: { lokasiSet: Set<string>; invoicePatch: Record<string, unknown> } | { error: string };
  try {
    txResult = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    const now = new Date();
    // Klaim atomik dulu — dua post bersamaan tidak boleh keduanya apply stok.
    const claim = await txDb.collection('goods_receipts').updateOne(
      { id: grn.id, status: { $nin: ['POSTED', 'POSTING'] } },
      { $set: { status: 'POSTING', postingStartedAt: now } },
      txOpts(session),
    );
    if (claim.modifiedCount === 0) {
      throw new Error('GRN sudah diposting');
    }

    try {
    const stock = await applyGrnStockPosting(
      txDb,
      tenantId,
      grn as StockGrnDoc,
      (body?.items ?? undefined) as JsonObject[] | undefined,
      session,
    );
    // Throw agar klaim POSTING ikut rollback (jangan return error yang tetap commit).
    if (stock.error) throw new Error(stock.error);

    const lokasiSet = stock.lokasiSet as Set<string>;
    const lokasiSummary = [...lokasiSet].map((k) => `${k} - ${warehouseLabel(k)}`).join(', ');

    const invoicePatch: Record<string, unknown> = {
      invoiceSyncStatus: 'NONE',
      invoiceSyncError: null,
      invoiceSyncAt: null,
    };

    if (canSyncInvoice) {
      invoicePatch.invoiceSyncStatus = syncInvoiceInline ? 'SYNCING' : 'PENDING';
    } else if (!salesApiKey) {
      invoicePatch.invoiceSyncStatus = 'SKIPPED';
      invoicePatch.invoiceSyncError = 'not_paired';
    }

    await txDb.collection('goods_receipts').updateOne(
      { id: grn.id, status: 'POSTING' },
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

    const accrualSub = parseInt(String(stock.receivedTotal || 0), 10);
    if (accrualSub > 0) {
      const existingAccrual = await txDb.collection('jurnal').findOne({
        tenantId,
        sourceType: 'AUTO_GRN_ACCRUAL',
        sourceId: grn.id,
      }, txOpts(session));
      if (!existingAccrual) {
        await createJournal(txDb, {
          tanggal: now,
          keterangan: `GRN ${grn.noGRN || grn.id}`,
          sourceType: 'AUTO_GRN_ACCRUAL',
          sourceId: grn.id,
          userName: typeof body?.userName === 'string' ? body.userName : 'System',
          details: buildGrnAccrualJournalLines({
            noDoc: String(grn.noGRN || grn.id),
            subTotal: accrualSub,
          }),
          tenantId,
        }, session);
      }
    }

    return { lokasiSet, invoicePatch };
    } catch (inner) {
      // Fallback non-TX: revert klaim POSTING agar GRN tidak macet.
      if (!session) {
        await txDb.collection('goods_receipts').updateOne(
          { id: grn.id, status: 'POSTING' },
          { $set: { status: priorStatus, postingStartedAt: null } },
        );
      }
      throw inner;
    }
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  if ('error' in txResult) {
    return { error: String(txResult.error || 'Gagal posting GRN') };
  }

  const posted = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
  if (!posted) return { error: 'GRN tidak ditemukan setelah posting' };

  // Inline = jalankan sekali sekarang; async = enqueue job. Jangan keduanya (double qtyReceived).
  let sideEffectsJobId: string | null = null;
  if (syncInvoiceInline) {
    try {
      await runGrnPostSideEffects(db, tenantId, grn.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('grn_post_side_effects_inline_exception', { tenantId, grnId: grn.id, error: msg });
    }
  } else {
    const sideFx = await enqueueJob(db, {
      type: JOB_TYPES.GRN_POST_SIDE_EFFECTS,
      tenantId,
      grnId: grn.id,
      payload: { grnId: grn.id },
    });
    sideEffectsJobId = sideFx.jobId;
    scheduleJobProcessing(db);
  }

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
    scheduleJobProcessing(db);

    if (shouldProcessGrnJobInline()) {
      const jobOutcome = await processJobById(db, enq.jobId);
      scheduleJobProcessing(db);
      const refreshedPosted = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
      if (refreshedPosted) Object.assign(posted, refreshedPosted);
      const finalStatus = posted.invoiceSyncStatus || 'PENDING';
      if (jobOutcome && 'error' in jobOutcome && jobOutcome.error) {
        invoiceSync = {
          async: false,
          jobId,
          status: finalStatus,
          error: jobOutcome.error,
        };
      } else {
        invoiceSync = {
          async: false,
          jobId,
          status: finalStatus,
          noInvoice: posted.noInvoice,
        };
      }
    } else if (!shouldUseLegacyBgPoll()) {
      // VPS fallback: drain inventory tick in-request (asyncInvoice opt-out path).
      try {
        const { processExecutionJobs } = await import('@/lib/api/process-execution-jobs');
        await processExecutionJobs(db, {
          limit: 4,
          domain: 'inventory',
          workerId: 'grn-post-invoice-drain',
          capabilities: ['SYNC', 'CPU_BATCH'],
        });
        const refreshedPosted = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
        if (refreshedPosted) Object.assign(posted, refreshedPosted);
      } catch {
        /* worker Redis tetap jalur cadangan */
      }
      invoiceSync = {
        async: posted.invoiceSyncStatus !== 'DONE',
        jobId,
        status: posted.invoiceSyncStatus || 'PENDING',
        noInvoice: posted.noInvoice,
      };
    } else {
      invoiceSync = {
        async: true,
        jobId,
        status: posted.invoiceSyncStatus || 'PENDING',
      };
    }
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
      scheduleJobProcessing(db);
      if (shouldProcessGrnJobInline()) {
        const retryOutcome = await processJobById(db, enq.jobId);
        scheduleJobProcessing(db);
        const retryPosted = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
        if (retryPosted) Object.assign(posted, retryPosted);
        invoiceSync = {
          ...invoiceSync,
          async: false,
          jobId: enq.jobId,
          status: posted.invoiceSyncStatus || (retryOutcome && 'error' in retryOutcome ? 'FAILED' : 'PENDING'),
          error: retryOutcome && 'error' in retryOutcome ? retryOutcome.error : invoiceSync.error,
        };
      } else {
        invoiceSync = {
          ...invoiceSync,
          async: true,
          jobId: enq.jobId,
          status: 'PENDING',
        };
      }
    } else if (invoiceSync.skipped) {
      patch.invoiceSyncStatus = 'SKIPPED';
      patch.invoiceSyncError = invoiceSync.reason || null;
    } else if (invoiceSync.pending || (invoiceSync.async && invoiceSync.salesJobId)) {
      patch.invoiceSyncStatus = 'PENDING';
      patch.invoiceSyncError = null;
      patch.invoiceSyncAt = new Date();
      if (invoiceSync.salesJobId) patch.salesJobId = invoiceSync.salesJobId;
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
    sideEffectsJobId,
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

  if (shouldProcessGrnJobInline()) {
    await processJobById(db, enq.jobId);
    scheduleJobProcessing(db);
  }

  const refreshed = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
  const enriched = await enrichGrnDoc(db, refreshed);
  return {
    ...enriched,
    invoiceSync: {
      async: !shouldProcessGrnJobInline(),
      jobId: enq.jobId,
      status: refreshed?.invoiceSyncStatus || 'PENDING',
      noInvoice: refreshed?.noInvoice,
      error: refreshed?.invoiceSyncError,
    },
  };
}

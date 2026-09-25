// Orkestrasi posting GRN — stok sync; faktur Category A sync via IntegrationClient.

import type { Db } from 'mongodb';
import { applyGrnStockPosting } from '@/lib/api/grn-post-stock';
import type { GrnDoc as StockGrnDoc } from '@/types/documents';
import { enrichGrnDoc } from '@/lib/api/grn-enrich';
import { runGrnPostSideEffects } from '@/lib/api/grn-post-side-effects-run';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';
import { shouldUseLegacyBgPoll } from '@/lib/api/execution-wave';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { warehouseLabel } from '@/lib/api/warehouses';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { createJournal } from '@/lib/api/journal';
import { buildGrnAccrualJournalLines } from '@/lib/api/journal-lines';
import { writeAuditLog } from '@/lib/api/audit-log';
import { CasConflictError, isCasConflict } from '@/lib/api/cas';
import { logger } from '@/lib/api/logger';
import { drainEnsureGrnInvoice, insertEnsureGrnInvoiceOutbox } from '@/lib/api/integration-outbox';
import type { JsonObject } from '@/types/json';

type GrnDoc = StockGrnDoc & {
  id: string;
  invoiceSyncStatus?: string;
  invoiceSyncError?: string | null;
};

export type { GrnDoc };

export type GrnReceivedBy = {
  userId: string;
  userName: string;
  role: string;
  nik: string;
  jabatan?: string;
};

interface PostGoodsReceiptParams {
  grn: GrnDoc;
  tenantId: string;
  body?: Record<string, unknown>;
  asyncInvoice?: boolean;
  /** Snapshot aktor login saat Terima Barang — stempel Penerima gudang. */
  receivedBy?: GrnReceivedBy | null;
}

interface ReplayGrnInvoiceParams {
  grn: GrnDoc;
  tenantId: string;
}

export async function postGoodsReceipt(
  db: Db,
  { grn, tenantId, body, asyncInvoice = true, receivedBy = null }: PostGoodsReceiptParams,
): Promise<Record<string, unknown> & { error?: string }> {
  // P0: asyncInvoice diabaikan — Category A selalu sync SUCCESS|FAILED (bukan PENDING).
  void asyncInvoice;
  const salesApiKey = await getSalesApiKeyForVendor(
    db,
    tenantId,
    grn.vendorTenantId ? String(grn.vendorTenantId) : undefined,
  );
  const canSyncInvoice = !!(salesApiKey && (grn.noDO || grn.vendorDeliveryId));
  // P0: selalu inline CreateInvoice via IntegrationClient. Job hanya recovery setelah FAILED.
  const syncInvoiceInline = canSyncInvoice;

  const priorStatus = String(grn.status || 'DRAFT');
  let txResult: { lokasiSet: Set<string>; invoicePatch: Record<string, unknown> } | { error: string };
  try {
    txResult = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
    const now = new Date();
    // Klaim atomik dulu — dua post bersamaan tidak boleh keduanya apply stok.
    // linesRev: baris yang diposting harus sama dengan yang dibaca (webhook/resolve produk menaikkannya).
    const claim = await txDb.collection('goods_receipts').updateOne(
      { id: grn.id, status: { $nin: ['POSTED', 'POSTING', 'REVERSED'] }, linesRev: grn.linesRev ?? null },
      { $set: { status: 'POSTING', postingStartedAt: now } },
      txOpts(session),
    );
    if (claim.modifiedCount === 0) {
      throw new CasConflictError('GRN sudah diposting atau barisnya baru diperbarui — muat ulang lalu coba lagi');
    }

    try {
    const stock = await applyGrnStockPosting(
      txDb,
      tenantId,
      grn as StockGrnDoc,
      (body?.items ?? undefined) as JsonObject[] | undefined,
      session,
      receivedBy ? { userId: receivedBy.userId, userName: receivedBy.userName, role: receivedBy.role } : null,
      { overReceiveReason: body?.overReceiveReason ? String(body.overReceiveReason) : null },
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
      invoicePatch.invoiceSyncStatus = 'SYNCING';
    } else if (!salesApiKey) {
      invoicePatch.invoiceSyncStatus = 'SKIPPED';
      invoicePatch.invoiceSyncError = 'not_paired';
    }

    if (!receivedBy?.userName?.trim() || !receivedBy?.nik?.trim()) {
      throw new Error('Signature Penerima gudang wajib: isi Nama dan NIK lewat tombol Buat signature');
    }
    const receiverName = receivedBy.userName.trim();
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
          userName: receiverName,
          receivedBy,
          ...(stock.overReceive ? { overReceive: { ...stock.overReceive, at: now } } : {}),
          ...(Array.isArray(body?.photoUrls) && body.photoUrls.length ? { photos: body.photoUrls } : {}),
          ...invoicePatch,
        },
      },
      txOpts(session),
    );

    // H1.1: business outbox atomik dengan POSTED (≠ execution_outbox).
    if (canSyncInvoice) {
      await insertEnsureGrnInvoiceOutbox(
        txDb,
        {
          tenantId,
          grnId: grn.id,
          noGRN: grn.noGRN ? String(grn.noGRN) : null,
          noDO: grn.noDO ? String(grn.noDO) : null,
        },
        session,
      );
    }

    await writeAuditLog(txDb, {
      tenantId,
      action: 'GRN_POSTED',
      entityType: 'goods_receipt',
      entityId: grn.id,
      summary: `GRN ${grn.noGRN || grn.id} posted — DO ${grn.noDO || '—'}`
        + (stock.overReceive ? ` · lebih terima disetujui ${stock.overReceive.lines.length} baris` : ''),
      userName: receiverName,
      userId: receivedBy.userId,
      metadata: {
        noDO: grn.noDO,
        receivedTotal: stock.receivedTotal,
        lokasiKodes: [...lokasiSet],
        ...(stock.overReceive ? { overReceive: stock.overReceive } : {}),
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
          userName: receiverName,
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
    if (isCasConflict(e)) return { error: e.message, conflict: true };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  if ('error' in txResult) {
    return { error: String(txResult.error || 'Gagal posting GRN') };
  }

  const posted = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
  if (!posted) return { error: 'GRN tidak ditemukan setelah posting' };

  // Side-effects stok/CPO: inline di VPS; enqueue di legacy/Vercel. Terpisah dari CreateInvoice.
  let sideEffectsJobId: string | null = null;
  const runSideEffectsInline = !shouldUseLegacyBgPoll() && !process.env.VERCEL;
  if (runSideEffectsInline) {
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

  // H1.1: drain outbox = jalur utama reliability; inline = optimization latency UX.
  if (canSyncInvoice && syncInvoiceInline) {
    const drained = await drainEnsureGrnInvoice(db, {
      tenantId,
      grnId: grn.id,
      preferSync: true,
    });
    invoiceSync = drained.invoiceSync;
    const status = String(invoiceSync.status || (invoiceSync.error ? 'FAILED' : 'DONE'));
    const needsRecovery = Boolean(invoiceSync.needsRecovery) || status === 'FAILED'
      || Boolean(invoiceSync.error && !invoiceSync.noInvoice && !invoiceSync.alreadyDone);

    if (needsRecovery && status !== 'SKIPPED') {
      const enq = await enqueueJob(db, {
        type: JOB_TYPES.GRN_INVOICE_SYNC,
        tenantId,
        grnId: grn.id,
        payload: {
          noGRN: grn.noGRN,
          noDO: grn.noDO,
          retryAfterOutboxDrain: true,
          outboxId: drained.outboxId,
        },
      });
      jobId = enq.jobId;
      scheduleJobProcessing(db);
      invoiceSync = { ...invoiceSync, async: false, jobId: enq.jobId, status };
    }

    const refreshed = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
    if (refreshed) {
      posted.invoiceSyncStatus = refreshed.invoiceSyncStatus;
      if (refreshed.noInvoice) posted.noInvoice = String(refreshed.noInvoice);
      if (refreshed.hutangId) posted.hutangId = String(refreshed.hutangId);
    }
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

/** Buat faktur — drain outbox Category A. SUCCESS|FAILED ke user, bukan PENDING. */
export async function replayGrnInvoiceAsync(
  db: Db,
  { grn, tenantId }: ReplayGrnInvoiceParams,
): Promise<Record<string, unknown>> {
  await db.collection('goods_receipts').updateOne(
    { id: grn.id },
    { $set: { invoiceSyncStatus: 'SYNCING', invoiceSyncError: null } },
  );

  const drained = await drainEnsureGrnInvoice(db, {
    tenantId,
    grnId: grn.id,
    preferSync: true,
  });
  let invoiceSync = drained.invoiceSync;
  const status = String(invoiceSync.status || (invoiceSync.error ? 'FAILED' : 'DONE'));
  const needsRecovery = Boolean(invoiceSync.needsRecovery) || status === 'FAILED'
    || Boolean(invoiceSync.error && !invoiceSync.noInvoice && !invoiceSync.alreadyDone);

  if (needsRecovery && status !== 'SKIPPED') {
    const enq = await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId,
      grnId: grn.id,
      payload: { replay: true, retryAfterOutboxDrain: true, outboxId: drained.outboxId },
    });
    scheduleJobProcessing(db);
    invoiceSync = { ...invoiceSync, async: false, jobId: enq.jobId, status };
  }

  const refreshed = await db.collection('goods_receipts').findOne({ id: grn.id }) as GrnDoc | null;
  const enriched = await enrichGrnDoc(db, refreshed);
  return {
    ...enriched,
    invoiceSync: {
      async: false,
      status: refreshed?.invoiceSyncStatus || status,
      noInvoice: refreshed?.noInvoice || invoiceSync.noInvoice,
      error: refreshed?.invoiceSyncError || invoiceSync.error,
      ...(typeof invoiceSync.jobId === 'string' ? { jobId: invoiceSync.jobId } : {}),
    },
  };
}

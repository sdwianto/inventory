/** Orkestrasi posting RTV — stok OUT sync; CN Sales Category A via outbox. */

import type { Db } from 'mongodb';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { drainEnsureGoodsReturnCn, insertEnsureGoodsReturnCnOutbox, ensureGoodsReturnCnOutboxPending } from '@/lib/api/integration-outbox';
import { applyVendorReturnStock } from '@/lib/api/vendor-return-stock';
import { assertReturnQtyWithinMax, buildReturableLines } from '@/lib/api/vendor-return-returable';
import { findInflightVendorReturnSibling } from '@/lib/api/vendor-return-inflight';
import { vendorReturnSalesIdentityError } from '@/lib/api/vendor-return-map';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { buildVendorReturnTransitOutJournalLines } from '@/lib/api/journal-lines';
import { VENDOR_RETURNS_COLLECTION, type VendorReturnDoc, type VendorReturnLine } from '@/types/vendor-return';
import { integrationCorrelationId } from '@/lib/api/integration-common';

/** ADR-006 — tenggat keputusan vendor: 7 hari dari posting RTV, murni highlight visual (bukan auto-aksi). */
const VENDOR_DECISION_SLA_MS = 7 * 24 * 60 * 60 * 1000;

export async function postVendorReturn(
  db: Db,
  {
    doc,
    tenantId,
    body,
  }: {
    doc: VendorReturnDoc;
    tenantId: string;
    body?: Record<string, unknown>;
  },
): Promise<Record<string, unknown> & { error?: string }> {
  const isGrnReject = doc.source === 'grn-reject';
  const salesApiKey = await getSalesApiKeyForVendor(
    db,
    tenantId,
    doc.vendorTenantId ? String(doc.vendorTenantId) : undefined,
  );
  // RTV dari item ditolak GRN tidak pernah tertagih (qtyRejected dikecualikan dari invoice) — tidak ada dasar CN.
  const canSyncCn = !isGrnReject && !!(salesApiKey && (doc.vendorInvoiceId || doc.noInvoice));
  const priorStatus = String(doc.status || 'DRAFT');

  let txResult: { error?: string } | Record<string, never>;
  try {
    txResult = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      const now = new Date();
      const claim = await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: doc.id, status: 'PENDING_APPROVAL' },
        { $set: { status: 'POSTING', postingStartedAt: now, updatedAt: now } },
        txOpts(session),
      );
      if (claim.modifiedCount === 0) {
        throw new Error('Retur vendor harus berstatus PENDING_APPROVAL (sudah diajukan) sebelum diposting');
      }

      try {
      if (!isGrnReject) {
        const identErr = vendorReturnSalesIdentityError(doc.items || []);
        if (identErr) throw new Error(identErr);

        const hutang = await txDb.collection('hutang').findOne({
          ...tenantIdMatchFilter(tenantId),
          ...(doc.hutangId ? { id: doc.hutangId } : { noInvoice: doc.noInvoice }),
        }, txOpts(session));
        if (!hutang) throw new Error('Tagihan terkait tidak ditemukan');
        const posted = await txDb.collection(VENDOR_RETURNS_COLLECTION).find({
          ...tenantIdMatchFilter(tenantId),
          status: { $in: ['POSTED', 'POSTING', 'PENDING_APPROVAL'] },
          $or: [
            { noInvoice: doc.noInvoice },
            ...(doc.hutangId ? [{ hutangId: doc.hutangId }] : []),
          ],
        }, txOpts(session)).toArray();
        const qtyErr = assertReturnQtyWithinMax(
          doc.items || [],
          buildReturableLines(
            hutang as import('@/lib/api/vendor-return-returable').HutangLike,
            posted as import('@/lib/api/vendor-return-returable').PostedReturnLike[],
            { excludeReturnId: doc.id },
          ),
        );
        if (qtyErr) throw new Error(qtyErr);

        // Sales hanya izinkan SATU CN DRAFT per invoice — qty tidak overlap tidak cukup.
        // Blokir sibling in-flight: approval/posting, CN SYNCING/FAILED, atau menunggu vendor.
        const blockingSibling = findInflightVendorReturnSibling(
          posted as VendorReturnDoc[],
          doc.id,
        );
        if (blockingSibling) {
          const waitingApproval = String(blockingSibling.status) === 'PENDING_APPROVAL'
            || String(blockingSibling.status) === 'POSTING';
          const cnBusy = ['SYNCING', 'FAILED'].includes(String(blockingSibling.cnSyncStatus || ''));
          throw new Error(
            waitingApproval
              ? `Invoice ini sudah punya retur ${blockingSibling.noReturn || blockingSibling.id} yang menunggu approval/posting — selesaikan retur itu dulu.`
              : cnBusy
                ? `Invoice ini sudah punya retur ${blockingSibling.noReturn || blockingSibling.id} yang masih sync credit note (${blockingSibling.cnSyncStatus}) — selesaikan/retry CN itu dulu.`
                : `Invoice ini sudah punya retur ${blockingSibling.noReturn || blockingSibling.id} yang masih menunggu keputusan vendor — tunggu retur itu diputuskan (Terima/Tolak) dulu sebelum mengajukan retur baru untuk invoice yang sama.`,
          );
        }
      }

      // Item ditolak GRN tidak pernah masuk stok (dikecualikan saat posting GRN) — tidak ada stok OUT untuk dikurangi.
      // stockAppliedAt: retry setelah gagal non-TX / stuck sweep tidak boleh OUT kedua kali.
      let stockApplied = Boolean(doc.stockAppliedAt);
      const stock: {
        error?: string;
        items?: VendorReturnLine[];
        lotConsume?: import('@/types/vendor-return').VendorReturnDoc['lotConsume'];
      } = isGrnReject
        ? { items: doc.items }
        : stockApplied
          ? { items: doc.items, lotConsume: doc.lotConsume }
          : await applyVendorReturnStock(
            txDb,
            tenantId,
            doc.noReturn,
            doc.items || [],
            session,
          );
      if (stock.error) throw new Error(stock.error);

      if (!isGrnReject && !stockApplied) {
        stockApplied = true;
        // Persist segera (sebelum outbox/POSTED) agar fallback non-TX tetap idempotent.
        await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
          { id: doc.id },
          {
            $set: {
              stockAppliedAt: now,
              items: stock.items || doc.items,
              ...(stock.lotConsume ? { lotConsume: stock.lotConsume } : {}),
              updatedAt: now,
            },
          },
          txOpts(session),
        );
      }

      // ADR-005 — transit GL hanya jika CN lifecycle diharapkan (canSyncCn).
      // SKIPPED/unpaired: qty OUT tanpa transit (kompatibel perilaku lama).
      let transitPatch: Record<string, unknown> = {};
      if (canSyncCn && !isGrnReject) {
        const itemsForAmt = stock.items || doc.items || [];
        const transitAmount = Math.round(
          itemsForAmt.reduce((s, it) => s + (parseInt(String(it.jumlah || 0), 10) || 0), 0)
          || Number(doc.subTotal || doc.total || 0),
        );
        if (transitAmount > 0 && !doc.transitAppliedAt) {
          const transitLines = buildVendorReturnTransitOutJournalLines({
            noDoc: doc.noReturn,
            amount: transitAmount,
          });
          if (transitLines.length) {
            const j = await createJournalIfNotExists(txDb, {
              tanggal: now,
              keterangan: `Transit retur vendor ${doc.noReturn}`,
              sourceType: 'RTV_TRANSIT_OUT',
              sourceId: doc.id,
              userName: body?.userName ? String(body.userName) : 'rtv-post',
              details: transitLines,
              tenantId,
            }, session);
            transitPatch = {
              transitJournalId: j?.id || doc.transitJournalId || null,
              transitAmount,
              transitAppliedAt: now,
            };
            await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
              { id: doc.id },
              { $set: { ...transitPatch, updatedAt: now } },
              txOpts(session),
            );
          }
        } else if (doc.transitAppliedAt) {
          transitPatch = {
            transitJournalId: doc.transitJournalId || null,
            transitAmount: doc.transitAmount || null,
            transitAppliedAt: doc.transitAppliedAt,
          };
        }
      }

      const cnPatch: Record<string, unknown> = {
        cnSyncStatus: canSyncCn ? 'SYNCING' : 'SKIPPED',
        cnSyncError: canSyncCn ? null : (salesApiKey ? null : 'not_paired'),
        cnSyncAt: null,
        vendorDecision: canSyncCn ? 'PENDING' : 'NONE',
        vendorDecisionAt: null,
        vendorDecisionBy: null,
        vendorDecisionDueAt: canSyncCn ? new Date(now.getTime() + VENDOR_DECISION_SLA_MS) : null,
      };

      const postedBy = {
        userId: body?.userId ? String(body.userId) : undefined,
        userName: body?.userName ? String(body.userName) : undefined,
      };
      const approvedBy = body?.approvedBy && typeof body.approvedBy === 'object'
        ? body.approvedBy as Record<string, unknown>
        : (postedBy.userId
          ? { userId: postedBy.userId, userName: postedBy.userName, role: body?.userRole ? String(body.userRole) : undefined }
          : null);

      await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: doc.id, status: 'POSTING' },
        {
          $set: {
            status: 'POSTED',
            items: stock.items || doc.items,
            ...(stock.lotConsume ? { lotConsume: stock.lotConsume } : {}),
            ...(!isGrnReject ? { stockAppliedAt: doc.stockAppliedAt || now } : {}),
            ...transitPatch,
            postedAt: now,
            postedBy,
            ...(approvedBy ? { approvedAt: now, approvedBy } : {}),
            updatedAt: now,
            ...(Array.isArray(body?.photos) && (body.photos as unknown[]).length
              ? { photos: body.photos }
              : {}),
            ...cnPatch,
          },
        },
        txOpts(session),
      );

      if (canSyncCn) {
        await insertEnsureGoodsReturnCnOutbox(
          txDb,
          {
            tenantId,
            returnId: doc.id,
            noReturn: doc.noReturn,
            correlationId: integrationCorrelationId(`rtv:${doc.id}`),
          },
          session,
        );
      }
      return {};
      } catch (inner) {
        if (!session) {
          await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
            { id: doc.id, status: 'POSTING' },
            { $set: { status: priorStatus, postingStartedAt: null, updatedAt: new Date() } },
          );
        }
        throw inner;
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }

  if (txResult && 'error' in txResult && txResult.error) {
    return { error: String(txResult.error) };
  }

  const posted = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({ id: doc.id }) as VendorReturnDoc | null;
  if (!posted) return { error: 'Retur tidak ditemukan setelah posting' };

  await writeAuditLog(db, {
    tenantId,
    action: 'VENDOR_RETURN_POSTED',
    entityType: 'vendor_return',
    entityId: doc.id,
    summary: isGrnReject
      ? `Post RTV ${doc.noReturn} dari item ditolak GRN ${doc.noGRN || ''}`
      : `Post RTV ${doc.noReturn} invoice ${doc.noInvoice}`,
    metadata: { noReturn: doc.noReturn, noInvoice: doc.noInvoice, total: doc.total },
    userId: posted.postedBy?.userId,
    userName: posted.postedBy?.userName,
  });

  let cnSync: Record<string, unknown> | null = null;
  let jobId: string | null = null;

  if (canSyncCn) {
    const drained = await drainEnsureGoodsReturnCn(db, {
      tenantId,
      returnId: doc.id,
    });
    cnSync = drained.cnSync;
    const st = String(cnSync.status || (cnSync.error ? 'FAILED' : 'DONE'));
    const needsRecovery = Boolean(cnSync.needsRecovery) || st === 'FAILED'
      || Boolean(cnSync.error && !cnSync.creditNoteId);

    if (needsRecovery && st !== 'SKIPPED') {
      const enq = await enqueueJob(db, {
        type: JOB_TYPES.GOODS_RETURN_CN_SYNC,
        tenantId,
        payload: {
          returnId: doc.id,
          dedupeKey: `rtv-cn:${doc.id}`,
        },
      });
      jobId = enq.jobId;
      scheduleJobProcessing(db);
      cnSync = { ...cnSync, async: false, jobId: enq.jobId, status: st };
    }
  }

  const refreshed = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({ id: doc.id }) as VendorReturnDoc | null;
  logger.info('vendor_return_posted', {
    tenantId,
    returnId: doc.id,
    noReturn: doc.noReturn,
    cnSyncStatus: refreshed?.cnSyncStatus,
  });

  return {
    ...(refreshed || posted),
    cnSync,
    cnSyncStatus: refreshed?.cnSyncStatus || posted.cnSyncStatus,
    jobId,
  };
}

export async function retryVendorReturnCn(
  db: Db,
  { doc, tenantId }: { doc: VendorReturnDoc; tenantId: string },
): Promise<Record<string, unknown>> {
  if (doc.status !== 'POSTED') {
    return { error: 'Hanya RTV POSTED yang bisa retry sync CN' };
  }
  if (doc.source === 'grn-reject') {
    return { error: 'Retur dari item ditolak GRN tidak pernah tertagih — tidak ada credit note untuk disinkron' };
  }
  if (doc.vendorDecision === 'REJECTED') {
    return { error: 'Vendor menolak retur ini — tidak ada CN untuk disinkron' };
  }
  const sync = String(doc.cnSyncStatus || 'NONE');
  if (sync === 'DONE' && (doc.creditNoteId || doc.noCN)) {
    return { ...doc, cnSync: { status: 'DONE', alreadyDone: true, creditNoteId: doc.creditNoteId, noCN: doc.noCN } };
  }

  await db.collection(VENDOR_RETURNS_COLLECTION).updateOne(
    { id: doc.id },
    { $set: { cnSyncStatus: 'SYNCING', cnSyncError: null, updatedAt: new Date() } },
  );

  await ensureGoodsReturnCnOutboxPending(db, {
    tenantId,
    returnId: doc.id,
    noReturn: doc.noReturn,
    replay: true,
  });

  const drained = await drainEnsureGoodsReturnCn(db, {
    tenantId,
    returnId: doc.id,
  });
  let cnSync = drained.cnSync;
  const status = String(cnSync.status || (cnSync.error ? 'FAILED' : 'DONE'));
  const needsRecovery = Boolean(cnSync.needsRecovery) || status === 'FAILED'
    || Boolean(cnSync.error && !cnSync.creditNoteId);

  if (needsRecovery && status !== 'SKIPPED') {
    const enq = await enqueueJob(db, {
      type: JOB_TYPES.GOODS_RETURN_CN_SYNC,
      tenantId,
      payload: { returnId: doc.id, replay: true, dedupeKey: `rtv-cn:${doc.id}` },
    });
    scheduleJobProcessing(db);
    cnSync = { ...cnSync, async: false, jobId: enq.jobId, status };
  }

  const refreshed = await db.collection(VENDOR_RETURNS_COLLECTION).findOne({ id: doc.id }) as VendorReturnDoc | null;
  return {
    ...(refreshed || doc),
    cnSync: {
      async: false,
      status: refreshed?.cnSyncStatus || status,
      noCN: refreshed?.noCN || cnSync.noCN,
      creditNoteId: refreshed?.creditNoteId || cnSync.creditNoteId,
      error: refreshed?.cnSyncError || cnSync.error,
      ...(typeof cnSync.jobId === 'string' ? { jobId: cnSync.jobId } : {}),
    },
  };
}

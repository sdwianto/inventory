/** Orkestrasi posting RTV — stok OUT sync; CN Sales Category A via outbox. */

import type { Db } from 'mongodb';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import { logger } from '@/lib/api/logger';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { drainEnsureGoodsReturnCn, insertEnsureGoodsReturnCnOutbox } from '@/lib/api/integration-outbox';
import { applyVendorReturnStock } from '@/lib/api/vendor-return-stock';
import { VENDOR_RETURNS_COLLECTION, type VendorReturnDoc } from '@/types/vendor-return';
import { integrationCorrelationId } from '@/lib/api/integration-common';

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
  const salesApiKey = await getSalesApiKeyForVendor(
    db,
    tenantId,
    doc.vendorTenantId ? String(doc.vendorTenantId) : undefined,
  );
  const canSyncCn = !!(salesApiKey && (doc.vendorInvoiceId || doc.noInvoice));

  let txResult: { error?: string } | Record<string, never>;
  try {
    txResult = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      const now = new Date();
      const claim = await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: doc.id, status: { $nin: ['POSTED', 'POSTING'] } },
        { $set: { status: 'POSTING', postingStartedAt: now, updatedAt: now } },
        txOpts(session),
      );
      if (claim.modifiedCount === 0) {
        throw new Error('Retur vendor sudah diposting');
      }

      const stock = await applyVendorReturnStock(
        txDb,
        tenantId,
        doc.noReturn,
        doc.items || [],
        session,
      );
      if (stock.error) throw new Error(stock.error);

      const cnPatch: Record<string, unknown> = {
        cnSyncStatus: canSyncCn ? 'SYNCING' : 'SKIPPED',
        cnSyncError: canSyncCn ? null : (salesApiKey ? null : 'not_paired'),
        cnSyncAt: null,
      };

      const postedBy = {
        userId: body?.userId ? String(body.userId) : undefined,
        userName: body?.userName ? String(body.userName) : undefined,
      };

      await txDb.collection(VENDOR_RETURNS_COLLECTION).updateOne(
        { id: doc.id, status: 'POSTING' },
        {
          $set: {
            status: 'POSTED',
            items: stock.items || doc.items,
            postedAt: now,
            postedBy,
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
    summary: `Post RTV ${doc.noReturn} invoice ${doc.noInvoice}`,
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
    const status = String(cnSync.status || (cnSync.error ? 'FAILED' : 'DONE'));
    const needsRecovery = Boolean(cnSync.needsRecovery) || status === 'FAILED'
      || Boolean(cnSync.error && !cnSync.creditNoteId);

    if (needsRecovery && status !== 'SKIPPED') {
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
      cnSync = { ...cnSync, async: false, jobId: enq.jobId, status };
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

  await db.collection(VENDOR_RETURNS_COLLECTION).updateOne(
    { id: doc.id },
    { $set: { cnSyncStatus: 'SYNCING', cnSyncError: null, updatedAt: new Date() } },
  );

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

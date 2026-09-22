/**
 * Setelah edit in-place PO pasca-approve: batalkan SO vendor, clear binding, CreateSO ulang.
 * noPO / status CPO tetap; editRevision menaikkan idempotency CreateSO/cancel.
 */

import type { Db } from 'mongodb';
import { notifySalesPoCancelled } from '@/lib/api/customer-po-cancel-sales';
import { finalizePoSubmission, pushPoToVendor } from '@/lib/api/customer-po-push';
import { poHasVendorSoNumbers } from '@/lib/api/customer-po-so-extract';
import { reopenEnsureCreateSoOutboxForEdit } from '@/lib/api/integration-outbox';
import { enqueueAndKickPoVendorSync } from '@/lib/api/po-vendor-sync-kick';
import type { JsonObject } from '@/types/json';

export type ResyncVendorSoAfterPoEditResult = {
  ok: boolean;
  vendorSynced: boolean;
  vendorSyncPending: boolean;
  vendorSyncError: string | null;
  vendorSyncJobId?: string | null;
  cancelErrors?: JsonObject[];
};

const CLEAR_VENDOR_SO_FIELDS = {
  vendorSubmissions: [],
  vendorSoId: null,
  vendorNoSO: null,
  vendorSoSnapshot: null,
  vendorSo: null,
  vendorSyncPending: true,
  vendorSyncError: null,
} as const;

/** Cancel SO vendor saja (sebelum/ tanpa rewrite items). */
export async function cancelVendorSoForPoEdit(
  db: Db,
  po: Record<string, unknown>,
  opts: { editRevision: number; editReason: string },
): Promise<{ ok: boolean; error?: string; cancelErrors?: JsonObject[]; cancelled?: JsonObject[] }> {
  const editRevision = Math.max(1, Math.floor(opts.editRevision));
  const reason = `Edit PO (rev ${editRevision}): ${opts.editReason}`.slice(0, 500);
  const hadVendorSo = poHasVendorSoNumbers(po as JsonObject)
    || (Array.isArray(po.vendorSubmissions) && po.vendorSubmissions.length > 0);
  if (!hadVendorSo) return { ok: true, cancelled: [] };

  const cancelled = await notifySalesPoCancelled(db, po, reason, { editRevision });
  const cancelErrors = cancelled.errors || [];
  if (cancelErrors.length) {
    return {
      ok: false,
      error: `Gagal batalkan SO vendor sebelum edit: ${cancelErrors.map((e) => e.error).join('; ')}`,
      cancelErrors,
      cancelled: cancelled.cancelled || [],
    };
  }
  return { ok: true, cancelled: cancelled.cancelled || [], cancelErrors: undefined };
}

export async function resyncVendorSoAfterPoEdit(
  db: Db,
  po: Record<string, unknown>,
  opts: { editRevision: number; editReason: string; preserveStatus?: string },
): Promise<ResyncVendorSoAfterPoEditResult> {
  const tenantId = String(po.tenantId || 'default');
  const poId = String(po.id || '');
  const editRevision = Math.max(1, Math.floor(opts.editRevision));
  const preserveStatus = String(opts.preserveStatus || po.status || '').trim();

  await db.collection('customer_purchase_orders').updateOne(
    { id: poId },
    {
      $set: {
        ...CLEAR_VENDOR_SO_FIELDS,
        editRevision,
        updatedAt: new Date(),
      },
      $unset: {
        vendorSynced: '',
      },
    },
  );

  await reopenEnsureCreateSoOutboxForEdit(db, {
    tenantId,
    poId,
    noPO: po.noPO ? String(po.noPO) : null,
  });

  const fresh = await db.collection('customer_purchase_orders').findOne({ id: poId });
  if (!fresh) {
    return {
      ok: false,
      vendorSynced: false,
      vendorSyncPending: false,
      vendorSyncError: 'PO tidak ditemukan setelah clear SO',
    };
  }

  const pushPo = { ...fresh, editRevision, status: preserveStatus || fresh.status } as Record<string, unknown>;
  const pushed = await pushPoToVendor(db, pushPo, tenantId);

  if ('error' in pushed && pushed.error && !(pushed as { submissions?: unknown[] }).submissions?.length) {
    const syncError = String(pushed.error);
    await db.collection('customer_purchase_orders').updateOne(
      { id: poId },
      {
        $set: {
          vendorSyncPending: true,
          vendorSyncError: syncError,
          vendorSyncAt: new Date(),
          updatedAt: new Date(),
          // Jaga status dokumen (jangan turun ke APPROVED kosong tanpa sadar)
          ...(preserveStatus ? { status: preserveStatus } : {}),
        },
      },
    );
    let jobId: string | undefined;
    try {
      const enq = await enqueueAndKickPoVendorSync(db, tenantId, { poId });
      jobId = enq.jobId;
    } catch {
      /* best-effort recovery */
    }
    return {
      ok: false,
      vendorSynced: false,
      vendorSyncPending: true,
      vendorSyncError: syncError,
      vendorSyncJobId: jobId || null,
    };
  }

  const submissions = ((pushed as { submissions?: JsonObject[] }).submissions) || [];
  const partialFailures = ((pushed as { partialFailures?: JsonObject[] }).partialFailures) || [];
  await finalizePoSubmission(
    db,
    pushPo,
    submissions,
    (fresh.approvedBy || null) as Record<string, unknown> | null,
    { partialFailures, preserveStatus },
  );

  if (partialFailures.length) {
    let jobId: string | undefined;
    try {
      const enq = await enqueueAndKickPoVendorSync(db, tenantId, { poId });
      jobId = enq.jobId;
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      vendorSynced: Boolean(submissions.length),
      vendorSyncPending: true,
      vendorSyncError: partialFailures.map((f) => `${f.vendorTenantId}: ${f.error}`).join('; '),
      vendorSyncJobId: jobId || null,
    };
  }

  return {
    ok: submissions.length > 0,
    vendorSynced: submissions.length > 0,
    vendorSyncPending: false,
    vendorSyncError: null,
  };
}

/**
 * H1.1 Business integration outbox (≠ execution_outbox / job-bus).
 * Intent sync persisted atomically with business commit; drain = jalur utama reliability.
 */

import { randomUUID } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { logger } from '@/lib/api/logger';

export const INTEGRATION_OUTBOX_COLLECTION = 'integration_outbox';

/** Locked type names — ENSURE_GRN_INVOICE / ENSURE_CREATE_SO (Sales Order from Customer PO, bukan Supplier Order). */
export const INTEGRATION_OUTBOX_TYPES = {
  ENSURE_GRN_INVOICE: 'ENSURE_GRN_INVOICE',
  /** Customer PO APPROVED → Sales Order di Sales app. */
  ENSURE_CREATE_SO: 'ENSURE_CREATE_SO',
} as const;

export type IntegrationOutboxType =
  (typeof INTEGRATION_OUTBOX_TYPES)[keyof typeof INTEGRATION_OUTBOX_TYPES];

export type IntegrationOutboxStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

export type IntegrationOutboxDoc = {
  id: string;
  type: IntegrationOutboxType;
  aggregateId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  status: IntegrationOutboxStatus;
  attempts: number;
  lastError: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date | null;
};

const STALE_PROCESSING_MS = 2 * 60 * 1000;

export async function insertEnsureGrnInvoiceOutbox(
  db: Db,
  input: {
    tenantId: string;
    grnId: string;
    noGRN?: string | null;
    noDO?: string | null;
    correlationId?: string | null;
  },
  session?: ClientSession,
): Promise<{ inserted: boolean; id: string }> {
  const now = new Date();
  const id = randomUUID();
  const doc: IntegrationOutboxDoc = {
    id,
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE,
    aggregateId: input.grnId,
    tenantId: input.tenantId,
    payload: {
      grnId: input.grnId,
      noGRN: input.noGRN || null,
      noDO: input.noDO || null,
    },
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    correlationId: input.correlationId || null,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
  };
  try {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).insertOne(doc, txOpts(session));
    return { inserted: true, id };
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? Number((e as { code: number }).code) : 0;
    if (code === 11000) {
      const existing = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne(
        { type: INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE, aggregateId: input.grnId },
        txOpts(session),
      );
      return { inserted: false, id: String(existing?.id || id) };
    }
    throw e;
  }
}

/** Ensure a PENDING/FAILED row exists for legacy GRNs posted before H1.1. */
export async function ensureGrnInvoiceOutboxPending(
  db: Db,
  input: { tenantId: string; grnId: string; noGRN?: string | null; noDO?: string | null },
): Promise<void> {
  const existing = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE,
    aggregateId: input.grnId,
  });
  if (!existing) {
    await insertEnsureGrnInvoiceOutbox(db, input);
    return;
  }
  const status = String(existing.status || '');
  if (status === 'DONE' || status === 'PROCESSING') return;
  if (status === 'FAILED' || status === 'PENDING') {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
      { id: existing.id, status: { $in: ['FAILED', 'PENDING'] } },
      { $set: { status: 'PENDING', lastError: null, updatedAt: new Date() } },
    );
  }
}

/**
 * Claim one ENSURE_GRN_INVOICE row for drain.
 * Also reclaims stale PROCESSING (crash mid-drain).
 */
export async function claimEnsureGrnInvoiceOutbox(
  db: Db,
  grnId: string,
): Promise<IntegrationOutboxDoc | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const claimed = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOneAndUpdate(
    {
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE,
      aggregateId: grnId,
      $or: [
        { status: 'PENDING' },
        { status: 'FAILED' },
        { status: 'PROCESSING', updatedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: { status: 'PROCESSING', updatedAt: now },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
  return (claimed as IntegrationOutboxDoc | null) || null;
}

export async function markOutboxDone(
  db: Db,
  outboxId: string,
  patch: { lastError?: string | null } = {},
): Promise<void> {
  const now = new Date();
  await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
    { id: outboxId },
    {
      $set: {
        status: 'DONE',
        lastError: patch.lastError ?? null,
        updatedAt: now,
        processedAt: now,
      },
    },
  );
}

export async function markOutboxFailed(
  db: Db,
  outboxId: string,
  lastError: string,
): Promise<void> {
  const now = new Date();
  await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
    { id: outboxId },
    {
      $set: {
        status: 'FAILED',
        lastError: lastError.slice(0, 2000),
        updatedAt: now,
        processedAt: now,
      },
    },
  );
}

export async function getEnsureGrnInvoiceOutbox(
  db: Db,
  grnId: string,
): Promise<IntegrationOutboxDoc | null> {
  return (await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE,
    aggregateId: grnId,
  })) as IntegrationOutboxDoc | null;
}

/**
 * Apply notifyGrnPostedToSales result onto goods_receipts (Category A Success|Failed).
 * Shared by post drain + worker drain.
 */
export async function applyGrnInvoiceNotifyResult(
  db: Db,
  grnId: string,
  invoiceSync: Record<string, unknown>,
): Promise<{
  invoiceSyncStatus: string;
  needsRecovery: boolean;
  hasInvoice: boolean;
  patch: Record<string, unknown>;
}> {
  const patch: Record<string, unknown> = { invoiceSyncAt: new Date() };
  let invoiceSyncStatus = 'FAILED';
  let needsRecovery = false;
  let hasInvoice = false;

  if ('error' in invoiceSync && invoiceSync.error) {
    if (invoiceSync.noInvoice) patch.noInvoice = invoiceSync.noInvoice;
    if (invoiceSync.invoiceId) patch.vendorInvoiceId = invoiceSync.invoiceId;
    hasInvoice = Boolean(invoiceSync.noInvoice || invoiceSync.invoiceId);
    invoiceSyncStatus = hasInvoice ? 'DONE' : 'FAILED';
    patch.invoiceSyncStatus = invoiceSyncStatus;
    patch.invoiceSyncError = hasInvoice
      ? `Faktur ${invoiceSync.noInvoice} ada di Sales; hutang lokal: ${invoiceSync.error}`
      : invoiceSync.error;
    needsRecovery = !hasInvoice || Boolean(invoiceSync.error);
  } else if (invoiceSync.skipped) {
    invoiceSyncStatus = 'SKIPPED';
    patch.invoiceSyncStatus = 'SKIPPED';
    patch.invoiceSyncError = invoiceSync.reason || null;
  } else if (invoiceSync.pending || (invoiceSync.async && invoiceSync.salesJobId)) {
    invoiceSyncStatus = 'FAILED';
    patch.invoiceSyncStatus = 'FAILED';
    patch.invoiceSyncError = `Sales mengantri faktur (async) — tidak diizinkan Category A. Job ${invoiceSync.salesJobId || '—'}`;
    if (invoiceSync.salesJobId) patch.salesJobId = invoiceSync.salesJobId;
    needsRecovery = true;
  } else {
    invoiceSyncStatus = 'DONE';
    patch.invoiceSyncStatus = 'DONE';
    if (invoiceSync.noInvoice) patch.noInvoice = invoiceSync.noInvoice;
    if (invoiceSync.invoiceId) patch.vendorInvoiceId = invoiceSync.invoiceId;
    const hutang = invoiceSync.hutang as Record<string, unknown> | undefined;
    if (hutang?.hutangId) patch.hutangId = hutang.hutangId;
    hasInvoice = Boolean(invoiceSync.noInvoice || invoiceSync.invoiceId);
    if (invoiceSync.hutangLocalError) {
      patch.invoiceSyncError = `Faktur ${invoiceSync.noInvoice || ''} ada; hutang lokal: ${invoiceSync.hutangLocalError}`;
      needsRecovery = true;
    } else {
      patch.invoiceSyncError = null;
    }
  }

  await db.collection('goods_receipts').updateOne({ id: grnId }, { $set: patch });
  return { invoiceSyncStatus, needsRecovery, hasInvoice, patch };
}

/**
 * Primary reliability path: claim outbox → CreateInvoice → mark DONE|FAILED.
 * Inline post uses this as latency optimization; worker uses same path for recovery.
 */
export async function drainEnsureGrnInvoice(
  db: Db,
  input: { tenantId: string; grnId: string; preferSync?: boolean },
): Promise<{
  invoiceSync: Record<string, unknown>;
  outboxId: string | null;
  claimed: boolean;
  alreadyDone: boolean;
}> {
  const existing = await getEnsureGrnInvoiceOutbox(db, input.grnId);
  if (existing?.status === 'DONE') {
    const grn = await db.collection('goods_receipts').findOne({ id: input.grnId });
    return {
      invoiceSync: {
        alreadyDone: true,
        noInvoice: grn?.noInvoice || null,
        invoiceId: grn?.vendorInvoiceId || null,
        status: grn?.invoiceSyncStatus || 'DONE',
      },
      outboxId: existing.id,
      claimed: false,
      alreadyDone: true,
    };
  }

  await ensureGrnInvoiceOutboxPending(db, {
    tenantId: input.tenantId,
    grnId: input.grnId,
  });

  const claimed = await claimEnsureGrnInvoiceOutbox(db, input.grnId);
  if (!claimed) {
    const again = await getEnsureGrnInvoiceOutbox(db, input.grnId);
    if (again?.status === 'DONE') {
      return {
        invoiceSync: { alreadyDone: true, status: 'DONE' },
        outboxId: again.id,
        claimed: false,
        alreadyDone: true,
      };
    }
    if (again?.status === 'PROCESSING') {
      return {
        invoiceSync: {
          error: 'Outbox sedang diproses worker lain — recovery akan menyelesaikan',
          code: 'OUTBOX_BUSY',
        },
        outboxId: again.id,
        claimed: false,
        alreadyDone: false,
      };
    }
    return {
      invoiceSync: { error: 'Outbox tidak bisa diklaim', code: 'OUTBOX_CLAIM_FAILED' },
      outboxId: again?.id || null,
      claimed: false,
      alreadyDone: false,
    };
  }

  const grn = await db.collection('goods_receipts').findOne({ id: input.grnId });
  if (!grn) {
    await markOutboxFailed(db, claimed.id, 'GRN tidak ditemukan');
    return {
      invoiceSync: { error: 'GRN tidak ditemukan' },
      outboxId: claimed.id,
      claimed: true,
      alreadyDone: false,
    };
  }

  const { notifyGrnPostedToSales } = await import('@/lib/api/grn-notify-sales');
  let invoiceSync: Record<string, unknown>;
  try {
    invoiceSync = (await notifyGrnPostedToSales(db, input.tenantId, grn as Record<string, unknown>, {
      preferSync: input.preferSync !== false,
    })) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('integration_outbox_drain_exception', {
      tenantId: input.tenantId,
      grnId: input.grnId,
      outboxId: claimed.id,
      error: msg,
    });
    invoiceSync = { error: msg };
  }

  const applied = await applyGrnInvoiceNotifyResult(db, input.grnId, invoiceSync);
  const errMsg =
    typeof invoiceSync.error === 'string'
      ? invoiceSync.error
      : typeof applied.patch.invoiceSyncError === 'string'
        ? applied.patch.invoiceSyncError
        : null;

  if (applied.invoiceSyncStatus === 'DONE' || applied.invoiceSyncStatus === 'SKIPPED') {
    await markOutboxDone(db, claimed.id, {
      lastError: applied.needsRecovery ? errMsg : null,
    });
  } else {
    await markOutboxFailed(db, claimed.id, errMsg || 'invoice sync failed');
  }

  logger.info('integration_outbox_drained', {
    tenantId: input.tenantId,
    grnId: input.grnId,
    outboxId: claimed.id,
    status: applied.invoiceSyncStatus,
    attempts: claimed.attempts,
  });

  return {
    invoiceSync: {
      ...invoiceSync,
      status: applied.invoiceSyncStatus,
      needsRecovery: applied.needsRecovery,
    },
    outboxId: claimed.id,
    claimed: true,
    alreadyDone: false,
  };
}

/** Sweep PENDING/FAILED outbox rows for scheduler/recover. */
export async function listPendingGrnInvoiceOutbox(
  db: Db,
  opts: { limit?: number } = {},
): Promise<Array<{ aggregateId: string; tenantId: string; status: string }>> {
  const limit = opts.limit ?? 40;
  const rows = await db
    .collection(INTEGRATION_OUTBOX_COLLECTION)
    .find({
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_GRN_INVOICE,
      status: { $in: ['PENDING', 'FAILED'] },
    })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .project({ aggregateId: 1, tenantId: 1, status: 1 })
    .toArray();
  return rows.map((r) => ({
    aggregateId: String(r.aggregateId),
    tenantId: String(r.tenantId),
    status: String(r.status),
  }));
}

// ─── H1.3 ENSURE_CREATE_SO (Customer PO → Sales Order di Sales app) ───────────

export async function insertEnsureCreateSoOutbox(
  db: Db,
  input: {
    tenantId: string;
    poId: string;
    noPO?: string | null;
    correlationId?: string | null;
  },
  session?: ClientSession,
): Promise<{ inserted: boolean; id: string }> {
  const now = new Date();
  const id = randomUUID();
  const doc: IntegrationOutboxDoc = {
    id,
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_CREATE_SO,
    aggregateId: input.poId,
    tenantId: input.tenantId,
    payload: {
      poId: input.poId,
      noPO: input.noPO || null,
    },
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    correlationId: input.correlationId || null,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
  };
  try {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).insertOne(doc, txOpts(session));
    return { inserted: true, id };
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? Number((e as { code: number }).code) : 0;
    if (code === 11000) {
      const existing = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne(
        { type: INTEGRATION_OUTBOX_TYPES.ENSURE_CREATE_SO, aggregateId: input.poId },
        txOpts(session),
      );
      return { inserted: false, id: String(existing?.id || id) };
    }
    throw e;
  }
}

export async function ensureCreateSoOutboxPending(
  db: Db,
  input: { tenantId: string; poId: string; noPO?: string | null },
): Promise<void> {
  const existing = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_CREATE_SO,
    aggregateId: input.poId,
  });
  if (!existing) {
    await insertEnsureCreateSoOutbox(db, input);
    return;
  }
  const status = String(existing.status || '');
  if (status === 'DONE' || status === 'PROCESSING') return;
  await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
    { id: existing.id, status: { $in: ['FAILED', 'PENDING'] } },
    { $set: { status: 'PENDING', lastError: null, updatedAt: new Date() } },
  );
}

async function claimEnsureCreateSoOutbox(
  db: Db,
  poId: string,
): Promise<IntegrationOutboxDoc | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const claimed = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOneAndUpdate(
    {
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_CREATE_SO,
      aggregateId: poId,
      $or: [
        { status: 'PENDING' },
        { status: 'FAILED' },
        { status: 'PROCESSING', updatedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: { status: 'PROCESSING', updatedAt: now },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
  return (claimed as IntegrationOutboxDoc | null) || null;
}

export async function getEnsureCreateSoOutbox(
  db: Db,
  poId: string,
): Promise<IntegrationOutboxDoc | null> {
  return (await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_CREATE_SO,
    aggregateId: poId,
  })) as IntegrationOutboxDoc | null;
}

/**
 * Drain ENSURE_CREATE_SO → Create Sales Order via pushPoToVendor.
 * SO = Sales Order di Sales app (bukan Supplier Order).
 */
export async function drainEnsureCreateSo(
  db: Db,
  input: { tenantId: string; poId: string; approverSnap?: unknown },
): Promise<{
  ok: boolean;
  error?: string;
  outboxId: string | null;
  alreadyDone: boolean;
  vendorNoSO?: string | null;
  vendorSoId?: string | null;
  partialFailures?: unknown[];
}> {
  const existing = await getEnsureCreateSoOutbox(db, input.poId);
  if (existing?.status === 'DONE') {
    const po = await db.collection('customer_purchase_orders').findOne({ id: input.poId });
    return {
      ok: true,
      outboxId: existing.id,
      alreadyDone: true,
      vendorNoSO: po?.vendorNoSO ? String(po.vendorNoSO) : null,
      vendorSoId: po?.vendorSoId ? String(po.vendorSoId) : null,
    };
  }

  await ensureCreateSoOutboxPending(db, {
    tenantId: input.tenantId,
    poId: input.poId,
  });

  const claimed = await claimEnsureCreateSoOutbox(db, input.poId);
  if (!claimed) {
    const again = await getEnsureCreateSoOutbox(db, input.poId);
    if (again?.status === 'DONE') {
      return { ok: true, outboxId: again.id, alreadyDone: true };
    }
    return {
      ok: false,
      error: again?.status === 'PROCESSING'
        ? 'Outbox sedang diproses worker lain'
        : 'Outbox tidak bisa diklaim',
      outboxId: again?.id || null,
      alreadyDone: false,
    };
  }

  const po = await db.collection('customer_purchase_orders').findOne({ id: input.poId });
  if (!po) {
    await markOutboxFailed(db, claimed.id, 'PO tidak ditemukan');
    return {
      ok: false,
      error: 'PO tidak ditemukan',
      outboxId: claimed.id,
      alreadyDone: false,
    };
  }

  const { pushPoToVendor, finalizePoSubmission } = await import('@/lib/api/customer-po-push');
  const pushed = await pushPoToVendor(db, po as Record<string, unknown>, input.tenantId);

  if ('error' in pushed && pushed.error && !(pushed as { submissions?: unknown[] }).submissions?.length) {
    await db.collection('customer_purchase_orders').updateOne(
      { id: input.poId },
      {
        $set: {
          vendorSyncPending: false,
          vendorSyncError: pushed.error,
          vendorSyncAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
    await markOutboxFailed(db, claimed.id, String(pushed.error));
    return {
      ok: false,
      error: String(pushed.error),
      outboxId: claimed.id,
      alreadyDone: false,
    };
  }

  const submissions = (pushed as { submissions: unknown[] }).submissions || [];
  const partialFailures = (pushed as { partialFailures?: unknown[] }).partialFailures || [];
  const updated = await finalizePoSubmission(
    db,
    po as Record<string, unknown>,
    submissions as import('@/types/json').JsonObject[],
    (input.approverSnap || po.approvedBy || null) as Record<string, unknown> | null,
    { partialFailures: partialFailures as import('@/types/json').JsonObject[] },
  );

  if (partialFailures.length && submissions.length === 0) {
    await markOutboxFailed(db, claimed.id, 'partial CreateSO failure');
    return {
      ok: false,
      error: 'partial CreateSO failure',
      outboxId: claimed.id,
      alreadyDone: false,
      partialFailures,
    };
  }

  await markOutboxDone(db, claimed.id, {
    lastError: partialFailures.length ? 'partial CreateSO — recovery may retry' : null,
  });
  logger.info('integration_outbox_drained', {
    tenantId: input.tenantId,
    poId: input.poId,
    outboxId: claimed.id,
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_CREATE_SO,
    status: 'DONE',
    attempts: claimed.attempts,
  });

  return {
    ok: true,
    outboxId: claimed.id,
    alreadyDone: false,
    vendorNoSO: updated?.vendorNoSO ? String(updated.vendorNoSO) : null,
    vendorSoId: updated?.vendorSoId ? String(updated.vendorSoId) : null,
    partialFailures: partialFailures.length ? partialFailures : undefined,
  };
}


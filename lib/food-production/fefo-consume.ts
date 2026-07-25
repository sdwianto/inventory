/**
 * W2-1 — apply FEFO consume against production_batches (TX-safe).
 */

import type { ClientSession, Db } from 'mongodb';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveQtyRemaining,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { allocateFefo, type FefoAllocation } from '@/lib/food-production/fefo-allocate';

export type FefoConsumeLineResult = {
  stokId: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  allocations: FefoAllocation[];
  /** true when no ACTIVE/EXPIRED batches exist for product+warehouse (legacy stock). */
  skippedNoBatches: boolean;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

/**
 * Consume FG batches FEFO for one release line.
 * If no batches for product+warehouse → skip (legacy path; stock ledger already adjusted).
 * Shortfall does not fail the release — Detect reports drift.
 */
export async function consumeBatchesFefo(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    warehouseKode: string;
    needQty: number;
    asOf?: Date;
    allowExpired?: boolean;
    /** W2-2: limit consume to batches stamped by this HSL. */
    productionResultId?: string;
    releaseId?: string;
    noRelease?: string;
    distributionId?: string;
    noDokumen?: string;
  },
  session?: ClientSession | null,
): Promise<FefoConsumeLineResult> {
  const needQty = Number(input.needQty);
  const empty: FefoConsumeLineResult = {
    stokId: input.stokId,
    needQty: needQty > 0 ? needQty : 0,
    allocated: 0,
    shortfall: needQty > 0 ? needQty : 0,
    allocations: [],
    skippedNoBatches: true,
  };
  if (!(needQty > 0) || !input.stokId || !input.warehouseKode) return empty;

  const now = input.asOf ?? new Date();
  const filter: Record<string, unknown> = {
    tenantId: input.tenantId,
    finishedGoodProductId: input.stokId,
    warehouseKode: input.warehouseKode,
    status: { $in: ['ACTIVE', 'EXPIRED'] },
  };
  if (input.productionResultId) {
    filter.productionResultId = input.productionResultId;
  }

  const rows = await db
    .collection(PRODUCTION_BATCHES_COLLECTION)
    .find(filter, txOpts(session))
    .sort({ expiryDate: 1 })
    .toArray() as unknown as ProductionBatchDoc[];

  if (!rows.length) return empty;

  const candidates = rows.map((b) => ({
    id: b.id,
    batchNo: b.batchNo,
    expiryDate: b.expiryDate,
    qtyRemaining: effectiveQtyRemaining(b),
    status: b.status,
  }));

  const plan = allocateFefo(needQty, candidates, {
    asOf: now,
    allowExpired: input.allowExpired,
  });

  for (const a of plan.allocations) {
    const batch = rows.find((r) => r.id === a.batchId);
    if (!batch) continue;
    const before = effectiveQtyRemaining(batch);
    const after = Math.max(0, before - a.qty);
    const status = after <= 0 ? 'CONSUMED' : batch.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE';
    const lastConsumedBy = input.distributionId
      ? {
          distributionId: input.distributionId,
          noDokumen: input.noDokumen,
          at: now,
        }
      : input.releaseId
        ? {
            releaseId: input.releaseId,
            noRelease: input.noRelease,
            at: now,
          }
        : undefined;
    await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
      { id: batch.id, tenantId: input.tenantId },
      {
        $set: {
          qtyRemaining: after,
          status,
          updatedAt: now,
          ...(lastConsumedBy ? { lastConsumedBy } : {}),
        },
      },
      txOpts(session),
    );
    batch.qtyRemaining = after;
    batch.status = status;
  }

  return {
    stokId: input.stokId,
    needQty,
    allocated: plan.allocated,
    shortfall: plan.shortfall,
    allocations: plan.allocations,
    skippedNoBatches: false,
  };
}

export type FefoRestoreResult = {
  stokId: string;
  needQty: number;
  restored: number;
  shortfall: number;
  allocations: FefoAllocation[];
};

/**
 * W2-3 — restore qtyRemaining from prior ship allocations (already planned LIFO).
 * CONSUMED → ACTIVE when remaining > 0; past-expiry → EXPIRED.
 */
export async function restoreBatchesFromAllocations(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    restores: FefoAllocation[];
    asOf?: Date;
    distributionId?: string;
    noDokumen?: string;
  },
  session?: ClientSession | null,
): Promise<FefoRestoreResult> {
  const needQty = (input.restores || []).reduce((s, a) => s + (Number(a.qty) || 0), 0);
  const empty: FefoRestoreResult = {
    stokId: input.stokId,
    needQty,
    restored: 0,
    shortfall: needQty,
    allocations: [],
  };
  if (!(needQty > 0)) return empty;

  const now = input.asOf ?? new Date();
  const today = now.toISOString().slice(0, 10);
  let restored = 0;
  const applied: FefoAllocation[] = [];

  for (const a of input.restores) {
    const qty = Number(a.qty) || 0;
    if (!(qty > 0) || !a.batchId) continue;
    const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne(
      { id: a.batchId, tenantId: input.tenantId },
      txOpts(session),
    ) as unknown as ProductionBatchDoc | null;
    if (!batch) continue;

    const before = effectiveQtyRemaining(batch);
    const cap = Math.max(0, Number(batch.qty) || 0);
    const after = Math.min(cap, before + qty);
    const gained = after - before;
    if (!(gained > 0)) continue;

    const exp = String(batch.expiryDate || '').slice(0, 10);
    const past = /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < today;
    const status = after <= 0 ? 'CONSUMED' : past ? 'EXPIRED' : 'ACTIVE';

    await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
      { id: batch.id, tenantId: input.tenantId },
      {
        $set: {
          qtyRemaining: after,
          status,
          updatedAt: now,
          lastRestoredBy: {
            distributionId: input.distributionId,
            noDokumen: input.noDokumen,
            at: now,
          },
        },
      },
      txOpts(session),
    );
    restored += gained;
    applied.push({
      batchId: a.batchId,
      batchNo: a.batchNo || batch.batchNo,
      expiryDate: exp,
      qty: gained,
    });
  }

  return {
    stokId: input.stokId,
    needQty,
    restored,
    shortfall: Math.max(0, needQty - restored),
    allocations: applied,
  };
}

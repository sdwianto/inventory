/**
 * W2-4 — sync production_batches when cycle count (penyesuaian) changes stock.
 */

import type { ClientSession, Db } from 'mongodb';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveQtyRemaining,
  isExpired,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';

export type CycleCountFefoResult = {
  stokId: string;
  warehouseKode: string;
  deltaQty: number;
  skippedNoBatches: boolean;
  consumed?: number;
  increased?: number;
  shortfall?: number;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

/**
 * Count down → FEFO consume (allow expired).
 * Count up → increase newest batch qtyRemaining (+ qty cap).
 * No batches → skip (non-FG / legacy).
 */
export async function syncBatchesOnVariance(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    warehouseKode: string;
    deltaQty: number;
    asOf?: Date;
    noDokumen?: string;
  },
  session?: ClientSession | null,
): Promise<CycleCountFefoResult> {
  const delta = Number(input.deltaQty);
  const base: CycleCountFefoResult = {
    stokId: input.stokId,
    warehouseKode: input.warehouseKode,
    deltaQty: delta,
    skippedNoBatches: true,
  };
  if (!Number.isFinite(delta) || delta === 0 || !input.stokId || !input.warehouseKode) {
    return base;
  }

  const now = input.asOf ?? new Date();

  if (delta < 0) {
    const fefo = await consumeBatchesFefo(
      db,
      {
        tenantId: input.tenantId,
        stokId: input.stokId,
        warehouseKode: input.warehouseKode,
        needQty: Math.abs(delta),
        asOf: now,
        allowExpired: true,
        noDokumen: input.noDokumen,
      },
      session,
    );
    return {
      ...base,
      skippedNoBatches: fefo.skippedNoBatches,
      consumed: fefo.allocated,
      shortfall: fefo.shortfall,
    };
  }

  // Count up — prefer newest non-consumed, else revive latest CONSUMED.
  const rows = await db
    .collection(PRODUCTION_BATCHES_COLLECTION)
    .find(
      {
        tenantId: input.tenantId,
        finishedGoodProductId: input.stokId,
        warehouseKode: input.warehouseKode,
        status: { $in: ['ACTIVE', 'EXPIRED', 'CONSUMED'] },
      },
      txOpts(session),
    )
    .sort({ expiryDate: -1, producedAt: -1 })
    .limit(5)
    .toArray() as unknown as ProductionBatchDoc[];

  if (!rows.length) return base;

  const target = rows.find((b) => b.status !== 'CONSUMED') || rows[0];
  const before = effectiveQtyRemaining(target);
  const after = before + delta;
  const qtyCap = Math.max(Number(target.qty) || 0, after);
  const expired = isExpired(target.expiryDate, now);
  const status = after <= 0 ? 'CONSUMED' : expired ? 'EXPIRED' : 'ACTIVE';

  await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
    { id: target.id, tenantId: input.tenantId },
    {
      $set: {
        qty: qtyCap,
        qtyRemaining: after,
        status,
        updatedAt: now,
        lastCycleCountBy: {
          noDokumen: input.noDokumen,
          delta,
          at: now,
        },
      },
    },
    txOpts(session),
  );

  return {
    ...base,
    skippedNoBatches: false,
    increased: delta,
  };
}

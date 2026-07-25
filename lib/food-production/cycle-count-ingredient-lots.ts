/**
 * W2-8 — sync ingredient_lots when cycle count (penyesuaian) changes stock.
 * Mirror of syncBatchesOnVariance for FG (W2-4).
 */

import type { ClientSession, Db } from 'mongodb';
import {
  INGREDIENT_LOTS_COLLECTION,
  effectiveIngredientQtyRemaining,
  isIngredientExpired,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { consumeIngredientLotsFefo } from '@/lib/food-production/ingredient-lot-consume';

export type CycleCountLotResult = {
  stokId: string;
  warehouseKode: string;
  deltaQty: number;
  skippedNoLots: boolean;
  consumed?: number;
  increased?: number;
  shortfall?: number;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

/**
 * Count down → FEFO consume lots (allow expired).
 * Count up → increase newest lot qtyRemaining (+ qty cap).
 * No lots → skip (legacy / no W2-5 stamp).
 */
export async function syncLotsOnVariance(
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
): Promise<CycleCountLotResult> {
  const delta = Number(input.deltaQty);
  const base: CycleCountLotResult = {
    stokId: input.stokId,
    warehouseKode: input.warehouseKode,
    deltaQty: delta,
    skippedNoLots: true,
  };
  if (!Number.isFinite(delta) || delta === 0 || !input.stokId || !input.warehouseKode) {
    return base;
  }

  const now = input.asOf ?? new Date();

  if (delta < 0) {
    const fefo = await consumeIngredientLotsFefo(
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
      skippedNoLots: fefo.skippedNoLots,
      consumed: fefo.allocated,
      shortfall: fefo.shortfall,
    };
  }

  const rows = await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find(
      {
        tenantId: input.tenantId,
        productId: input.stokId,
        warehouseKode: input.warehouseKode,
        status: { $in: ['ACTIVE', 'EXPIRED', 'CONSUMED'] },
      },
      txOpts(session),
    )
    .sort({ expiryDate: -1, receivedAt: -1 })
    .limit(5)
    .toArray() as unknown as IngredientLotDoc[];

  if (!rows.length) return base;

  const target = rows.find((b) => b.status !== 'CONSUMED') || rows[0];
  const before = effectiveIngredientQtyRemaining(target);
  const after = before + delta;
  const qtyCap = Math.max(Number(target.qty) || 0, after);
  const expired = isIngredientExpired(target.expiryDate, now);
  const status = after <= 0 ? 'CONSUMED' : expired ? 'EXPIRED' : 'ACTIVE';

  await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
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
    skippedNoLots: false,
    increased: delta,
  };
}

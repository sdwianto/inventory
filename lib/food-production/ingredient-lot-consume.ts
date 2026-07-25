/**
 * W2-6 — FEFO consume against ingredient_lots (mirror of consumeBatchesFefo).
 */

import type { ClientSession, Db } from 'mongodb';
import {
  INGREDIENT_LOTS_COLLECTION,
  effectiveIngredientQtyRemaining,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { allocateFefo, type FefoAllocation } from '@/lib/food-production/fefo-allocate';

export type IngredientLotConsumeResult = {
  stokId: string;
  warehouseKode: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  allocations: FefoAllocation[];
  skippedNoLots: boolean;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

/**
 * Consume ingredient lots FEFO for one Issue line.
 * No lots → skip (legacy stock without W2-5 stamp).
 * Shortfall does not fail Issue — Detect reports drift.
 */
export async function consumeIngredientLotsFefo(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    warehouseKode: string;
    needQty: number;
    asOf?: Date;
    allowExpired?: boolean;
    issueId?: string;
    noDokumen?: string;
  },
  session?: ClientSession | null,
): Promise<IngredientLotConsumeResult> {
  const needQty = Number(input.needQty);
  const empty: IngredientLotConsumeResult = {
    stokId: input.stokId,
    warehouseKode: input.warehouseKode,
    needQty: needQty > 0 ? needQty : 0,
    allocated: 0,
    shortfall: needQty > 0 ? needQty : 0,
    allocations: [],
    skippedNoLots: true,
  };
  if (!(needQty > 0) || !input.stokId || !input.warehouseKode) return empty;

  const now = input.asOf ?? new Date();
  const rows = await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find(
      {
        tenantId: input.tenantId,
        productId: input.stokId,
        warehouseKode: input.warehouseKode,
        status: { $in: ['ACTIVE', 'EXPIRED'] },
      },
      txOpts(session),
    )
    .sort({ expiryDate: 1 })
    .toArray() as unknown as IngredientLotDoc[];

  if (!rows.length) return empty;

  const candidates = rows.map((b) => ({
    id: b.id,
    batchNo: b.lotNo,
    expiryDate: b.expiryDate,
    qtyRemaining: effectiveIngredientQtyRemaining(b),
    status: b.status,
  }));

  const plan = allocateFefo(needQty, candidates, {
    asOf: now,
    allowExpired: input.allowExpired,
  });

  for (const a of plan.allocations) {
    const lot = rows.find((r) => r.id === a.batchId);
    if (!lot) continue;
    const before = effectiveIngredientQtyRemaining(lot);
    const after = Math.max(0, before - a.qty);
    const status = after <= 0 ? 'CONSUMED' : lot.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE';
    await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
      { id: lot.id, tenantId: input.tenantId },
      {
        $set: {
          qtyRemaining: after,
          status,
          updatedAt: now,
          lastConsumedBy: {
            issueId: input.issueId,
            noDokumen: input.noDokumen,
            at: now,
          },
        },
      },
      txOpts(session),
    );
    lot.qtyRemaining = after;
    lot.status = status;
  }

  return {
    stokId: input.stokId,
    warehouseKode: input.warehouseKode,
    needQty,
    allocated: plan.allocated,
    shortfall: plan.shortfall,
    allocations: plan.allocations,
    skippedNoLots: false,
  };
}

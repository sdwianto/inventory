/**
 * W2-13 — relocate ingredient_lots FEFO across warehouses on TR/XFR.
 * Mirror of W2-12 relocateBatchesFefo for FG production_batches.
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  INGREDIENT_LOTS_COLLECTION,
  effectiveIngredientQtyRemaining,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { allocateFefo, type FefoAllocation } from '@/lib/food-production/fefo-allocate';
import { STOCK_QTY_EPS, isZeroQty, roundStockQty } from '@/lib/stock-ledger/precision';

export type LotRelocateLineResult = {
  stokId: string;
  fromWarehouseKode: string;
  toWarehouseKode: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  allocations: FefoAllocation[];
  /** true when no ACTIVE/EXPIRED lots at source (legacy / non-ingredient). */
  skippedNoLots: boolean;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

const LOT_CONFLICT = 'Lot bahan berubah bersamaan — ulangi transaksi';

/**
 * Relocate ingredient lots from source warehouse to dest FEFO.
 * Full remaining → update warehouseKode on same lot id.
 * Partial → decrement source + merge/clone at dest.
 * Shortfall / no lots: soft (stock already moved; Detect owns drift).
 */
export async function relocateLotsFefo(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    fromWarehouseKode: string;
    toWarehouseKode: string;
    needQty: number;
    asOf?: Date;
    allowExpired?: boolean;
    noTransaksi?: string;
    transferId?: string;
    xferId?: string;
  },
  session?: ClientSession | null,
): Promise<LotRelocateLineResult> {
  const needQty = roundStockQty(input.needQty);
  const fromWh = String(input.fromWarehouseKode || '').trim();
  const toWh = String(input.toWarehouseKode || '').trim();
  const empty: LotRelocateLineResult = {
    stokId: input.stokId,
    fromWarehouseKode: fromWh,
    toWarehouseKode: toWh,
    needQty: needQty > 0 ? needQty : 0,
    allocated: 0,
    shortfall: needQty > 0 ? needQty : 0,
    allocations: [],
    skippedNoLots: true,
  };

  if (!(needQty > 0) || !input.stokId || !fromWh || !toWh) return empty;
  if (fromWh === toWh) {
    return { ...empty, shortfall: 0, skippedNoLots: true };
  }

  const now = input.asOf ?? new Date();
  const tid = String(input.tenantId || 'default').trim() || 'default';

  const rows = (await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find(
      {
        tenantId: tid,
        productId: input.stokId,
        warehouseKode: fromWh,
        status: { $in: ['ACTIVE', 'EXPIRED'] },
      },
      txOpts(session),
    )
    .sort({ expiryDate: 1 })
    .toArray()) as unknown as IngredientLotDoc[];

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
    allowExpired: input.allowExpired !== false,
  });

  const lastRelocatedBy = {
    transferId: input.transferId,
    xferId: input.xferId,
    noTransaksi: input.noTransaksi,
    fromWarehouseKode: fromWh,
    toWarehouseKode: toWh,
    at: now,
  };

  for (const a of plan.allocations) {
    const lot = rows.find((r) => r.id === a.batchId);
    if (!lot) continue;
    const rem = effectiveIngredientQtyRemaining(lot);
    const take = roundStockQty(Math.min(a.qty, rem));
    if (!(take > 0)) continue;

    if (take >= rem - STOCK_QTY_EPS) {
      const moved = await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
        { id: lot.id, tenantId: tid, warehouseKode: fromWh, updatedAt: lot.updatedAt ?? null },
        {
          $set: {
            warehouseKode: toWh,
            updatedAt: now,
            lastRelocatedBy,
          },
        },
        txOpts(session),
      );
      if (moved.matchedCount === 0) throw new Error(LOT_CONFLICT);
      lot.warehouseKode = toWh;
      lot.qtyRemaining = rem;
      continue;
    }

    const afterSource = Math.max(0, roundStockQty(rem - take));
    const reduced = await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
      { id: lot.id, tenantId: tid, updatedAt: lot.updatedAt ?? null },
      {
        $set: {
          qtyRemaining: afterSource,
          status: isZeroQty(afterSource) ? 'CONSUMED' : lot.status,
          updatedAt: now,
          lastRelocatedBy,
        },
      },
      txOpts(session),
    );
    if (reduced.matchedCount === 0) throw new Error(LOT_CONFLICT);
    lot.qtyRemaining = afterSource;

    const destExisting = (await db.collection(INGREDIENT_LOTS_COLLECTION).findOne(
      {
        tenantId: tid,
        lotNo: lot.lotNo,
        productId: input.stokId,
        warehouseKode: toWh,
        status: { $in: ['ACTIVE', 'EXPIRED'] },
      },
      txOpts(session),
    )) as unknown as IngredientLotDoc | null;

    if (destExisting) {
      const destRem = effectiveIngredientQtyRemaining(destExisting);
      const newRem = roundStockQty(destRem + take);
      const credited = await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
        { id: destExisting.id, tenantId: tid, updatedAt: destExisting.updatedAt ?? null },
        {
          $set: {
            qtyRemaining: newRem,
            qty: Math.max(roundStockQty(destExisting.qty), newRem),
            status: destExisting.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
            updatedAt: now,
            lastRelocatedBy,
          },
        },
        txOpts(session),
      );
      if (credited.matchedCount === 0) throw new Error(LOT_CONFLICT);
    } else {
      const clone: IngredientLotDoc = {
        id: uuidv4(),
        tenantId: tid,
        lotNo: lot.lotNo,
        grnId: lot.grnId,
        noGRN: lot.noGRN,
        productId: lot.productId || input.stokId,
        productKode: lot.productKode,
        productNama: lot.productNama,
        warehouseKode: toWh,
        receivedAt: lot.receivedAt,
        expiryDate: lot.expiryDate,
        qty: take,
        qtyRemaining: take,
        satuan: lot.satuan,
        status: lot.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
        lineIndex: lot.lineIndex,
        relocatedFromLotId: lot.id,
        lastRelocatedBy,
        createdAt: now,
        updatedAt: now,
      };
      await db.collection(INGREDIENT_LOTS_COLLECTION).insertOne(clone, txOpts(session));
    }
  }

  return {
    stokId: input.stokId,
    fromWarehouseKode: fromWh,
    toWarehouseKode: toWh,
    needQty,
    allocated: plan.allocated,
    shortfall: plan.shortfall,
    allocations: plan.allocations,
    skippedNoLots: false,
  };
}

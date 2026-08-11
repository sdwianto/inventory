/**
 * W2-12 — relocate FG production_batches FEFO across warehouses on TR/XFR.
 * Stock ledger already moved; this keeps batch warehouseKode aligned.
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveFoodSafetyStatus,
  effectiveQtyRemaining,
  foodSafetyStatusMatch,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { allocateFefo, type FefoAllocation } from '@/lib/food-production/fefo-allocate';

export type FefoRelocateLineResult = {
  stokId: string;
  fromWarehouseKode: string;
  toWarehouseKode: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  allocations: FefoAllocation[];
  /** true when no ACTIVE/EXPIRED batches at source (legacy / non-FG). */
  skippedNoBatches: boolean;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

/**
 * Relocate FG batches from source warehouse to dest FEFO.
 * Full remaining → update warehouseKode on same batch id.
 * Partial → decrement source + merge/clone at dest.
 * Shortfall / no batches: soft (stock already moved; Detect owns drift).
 */
export async function relocateBatchesFefo(
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
): Promise<FefoRelocateLineResult> {
  const needQty = Number(input.needQty);
  const fromWh = String(input.fromWarehouseKode || '').trim();
  const toWh = String(input.toWarehouseKode || '').trim();
  const empty: FefoRelocateLineResult = {
    stokId: input.stokId,
    fromWarehouseKode: fromWh,
    toWarehouseKode: toWh,
    needQty: needQty > 0 ? needQty : 0,
    allocated: 0,
    shortfall: needQty > 0 ? needQty : 0,
    allocations: [],
    skippedNoBatches: true,
  };

  if (!(needQty > 0) || !input.stokId || !fromWh || !toWh) return empty;
  if (fromWh === toWh) {
    return { ...empty, shortfall: 0, skippedNoBatches: true };
  }

  const now = input.asOf ?? new Date();
  const tid = String(input.tenantId || 'default').trim() || 'default';

  const rows = (await db
    .collection(PRODUCTION_BATCHES_COLLECTION)
    .find(
      {
        tenantId: tid,
        finishedGoodProductId: input.stokId,
        warehouseKode: fromWh,
        status: { $in: ['ACTIVE', 'EXPIRED'] },
      },
      txOpts(session),
    )
    .sort({ expiryDate: 1 })
    .toArray()) as unknown as ProductionBatchDoc[];

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
    const batch = rows.find((r) => r.id === a.batchId);
    if (!batch) continue;
    const rem = effectiveQtyRemaining(batch);
    const take = Math.min(a.qty, rem);
    if (!(take > 0)) continue;

    if (take >= rem - 1e-9) {
      // FULL relocate — same batch id moves warehouse
      await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
        { id: batch.id, tenantId: tid, warehouseKode: fromWh },
        {
          $set: {
            warehouseKode: toWh,
            updatedAt: now,
            lastRelocatedBy,
          },
        },
        txOpts(session),
      );
      batch.warehouseKode = toWh;
      batch.qtyRemaining = rem;
      continue;
    }

    // PARTIAL — leave remainder at source; credit dest
    const afterSource = Math.max(0, rem - take);
    await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
      { id: batch.id, tenantId: tid },
      {
        $set: {
          qtyRemaining: afterSource,
          status: afterSource <= 0 ? 'CONSUMED' : batch.status,
          updatedAt: now,
          lastRelocatedBy,
        },
      },
      txOpts(session),
    );
    batch.qtyRemaining = afterSource;

    // ADR-004: relokasi tidak boleh mengubah disposisi. Hanya gabungkan ke batch
    // tujuan yang disposisinya sama, agar qty tertahan tidak melebur jadi bersih.
    const srcFoodSafety = effectiveFoodSafetyStatus(batch);
    const destExisting = (await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne(
      {
        tenantId: tid,
        batchNo: batch.batchNo,
        finishedGoodProductId: input.stokId,
        warehouseKode: toWh,
        status: { $in: ['ACTIVE', 'EXPIRED'] },
        foodSafetyStatus: foodSafetyStatusMatch(srcFoodSafety),
      },
      txOpts(session),
    )) as unknown as ProductionBatchDoc | null;

    if (destExisting) {
      const destRem = effectiveQtyRemaining(destExisting);
      const newRem = destRem + take;
      await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
        { id: destExisting.id, tenantId: tid },
        {
          $set: {
            qtyRemaining: newRem,
            qty: Math.max(Number(destExisting.qty || 0), newRem),
            status: destExisting.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
            updatedAt: now,
            lastRelocatedBy,
          },
        },
        txOpts(session),
      );
    } else {
      const clone: ProductionBatchDoc = {
        id: uuidv4(),
        tenantId: tid,
        batchNo: batch.batchNo,
        productionResultId: batch.productionResultId,
        productionResultNo: batch.productionResultNo,
        productionPlanId: batch.productionPlanId,
        productionPlanNo: batch.productionPlanNo,
        kitchenId: batch.kitchenId,
        kitchenNama: batch.kitchenNama,
        warehouseKode: toWh,
        producedAt: batch.producedAt,
        expiryDate: batch.expiryDate,
        finishedGoodProductId: batch.finishedGoodProductId || input.stokId,
        finishedGoodNama: batch.finishedGoodNama,
        qty: take,
        qtyRemaining: take,
        satuan: batch.satuan,
        status: batch.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
        foodSafetyStatus: srcFoodSafety,
        ...(batch.foodSafetyHistory?.length
          ? { foodSafetyHistory: batch.foodSafetyHistory }
          : {}),
        relocatedFromBatchId: batch.id,
        lastRelocatedBy,
        createdAt: now,
        updatedAt: now,
      };
      await db.collection(PRODUCTION_BATCHES_COLLECTION).insertOne(clone, txOpts(session));
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
    skippedNoBatches: false,
  };
}

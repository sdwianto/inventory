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
 * Peek lotNo FEFO pertama yang masih punya sisa (tanpa consume).
 * Dipakai hydrate preferredLotNo saat draft RTV dari hutang.
 */
export async function peekFefoLotNo(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    warehouseKode: string;
  },
  session?: ClientSession | null,
): Promise<string | null> {
  if (!input.stokId || !input.warehouseKode) return null;
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
    .limit(20)
    .toArray() as unknown as IngredientLotDoc[];

  for (const lot of rows) {
    const rem = effectiveIngredientQtyRemaining(lot);
    if (rem > 0) {
      const no = String(lot.lotNo || '').trim();
      if (no) return no;
    }
  }
  return null;
}

/**
 * Consume ingredient lots FEFO for one Issue / RTV line.
 * No lots → skip (legacy stock without W2-5 stamp).
 * Shortfall does not fail the parent mutation — Detect reports drift.
 *
 * `preferredLotNo` (opsional): lot dengan nomor itu diprioritaskan sebelum FEFO sisa.
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
    preferredLotNo?: string | null;
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

  const toCandidate = (b: IngredientLotDoc) => ({
    id: b.id,
    batchNo: b.lotNo,
    expiryDate: b.expiryDate,
    qtyRemaining: effectiveIngredientQtyRemaining(b),
    status: b.status,
  });

  const allocOpts = {
    asOf: now,
    allowExpired: input.allowExpired,
  };

  // preferredLotNo: ambil dulu dari lot yang cocok, baru FEFO sisa di lot lain.
  // Tidak cukup reorder sebelum allocateFefo — allocator selalu sort ulang by expiry.
  const preferred = String(input.preferredLotNo || '').trim();
  const preferredRows = preferred
    ? rows.filter((r) => String(r.lotNo || '').trim() === preferred)
    : [];
  const otherRows = preferred
    ? rows.filter((r) => String(r.lotNo || '').trim() !== preferred)
    : rows;

  const merged: FefoAllocation[] = [];
  let left = needQty;

  if (preferred && preferredRows.length && left > 0) {
    const prefPlan = allocateFefo(left, preferredRows.map(toCandidate), allocOpts);
    merged.push(...prefPlan.allocations);
    left = prefPlan.shortfall;
  }

  if (left > 0) {
    const restSource = preferred && preferredRows.length ? otherRows : rows;
    const restPlan = allocateFefo(left, restSource.map(toCandidate), allocOpts);
    merged.push(...restPlan.allocations);
    left = restPlan.shortfall;
  }

  for (const a of merged) {
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
    allocated: needQty - left,
    shortfall: left,
    allocations: merged,
    skippedNoLots: false,
  };
}

export type IngredientLotRestoreResult = {
  stokId: string;
  needQty: number;
  restored: number;
  shortfall: number;
  allocations: FefoAllocation[];
};

/**
 * Restore ingredient lot qty from prior FEFO allocations (LIFO via `planFefoRestore`).
 * Soft: missing lot rows skip; shortfall does not throw.
 */
export async function restoreIngredientLotsFromAllocations(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    restores: FefoAllocation[];
    asOf?: Date;
    noDokumen?: string;
    returnId?: string;
  },
  session?: ClientSession | null,
): Promise<IngredientLotRestoreResult> {
  const needQty = (input.restores || []).reduce((s, a) => s + (Number(a.qty) || 0), 0);
  const empty: IngredientLotRestoreResult = {
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
    const lot = await db.collection(INGREDIENT_LOTS_COLLECTION).findOne(
      { id: a.batchId, tenantId: input.tenantId },
      txOpts(session),
    ) as unknown as IngredientLotDoc | null;
    if (!lot) continue;

    const before = effectiveIngredientQtyRemaining(lot);
    const cap = Math.max(0, Number(lot.qty) || 0);
    const after = Math.min(cap, before + qty);
    const gained = after - before;
    if (!(gained > 0)) continue;

    const exp = String(lot.expiryDate || '').slice(0, 10);
    const past = /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < today;
    const status = after <= 0 ? 'CONSUMED' : past ? 'EXPIRED' : 'ACTIVE';

    await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
      { id: lot.id, tenantId: input.tenantId },
      {
        $set: {
          qtyRemaining: after,
          status,
          updatedAt: now,
          lastRestoredBy: {
            returnId: input.returnId,
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
      batchNo: a.batchNo || lot.lotNo,
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


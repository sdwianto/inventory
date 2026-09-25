/**
 * W2-6 — FEFO consume against ingredient_lots (mirror of consumeBatchesFefo).
 */

import type { ClientSession, Db } from 'mongodb';
import {
  INGREDIENT_LOTS_COLLECTION,
  LOT_QC_RELEASED_FILTER,
  businessDateIso,
  effectiveIngredientQtyRemaining,
  isLotQcHeld,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { allocateFefo, type FefoAllocation } from '@/lib/food-production/fefo-allocate';
import {
  applyAllocationConsumption,
  applyAllocationRestore,
  reservedQtyByLot,
} from '@/lib/stock-ledger/plan-reservation';
import { isZeroQty, roundStockQty } from '@/lib/stock-ledger/precision';

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
 * Lot karantina/ditolak QC (Fase 3.2):
 * - EXCLUDE (default): tidak pernah dikonsumsi.
 * - PREFERRED: hanya lot bernomor `preferredLotNo` yang boleh (RTV / pemusnahan lot ditolak).
 * - LAST: dikonsumsi setelah lot lolos habis (hitung fisik turun — barangnya memang tidak ada).
 */
export type LotQcHeldMode = 'EXCLUDE' | 'PREFERRED' | 'LAST';

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
        ...LOT_QC_RELEASED_FILTER,
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
    qcHeld?: LotQcHeldMode;
    /** Rencana pemilik: lot cadangannya ikut FEFO. */
    reservationPlanId?: string | null;
    /** Override yang sudah disetujui: cadangan rencana lain boleh dipakai setelah stok bebas. */
    reservationOverride?: boolean;
  },
  session?: ClientSession | null,
): Promise<IngredientLotConsumeResult> {
  const needQty = roundStockQty(input.needQty);
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
  const allRows = await db
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

  if (!allRows.length) return empty;

  const qcHeld = input.qcHeld ?? 'EXCLUDE';
  const preferred = String(input.preferredLotNo || '').trim();
  const heldRows = allRows.filter((r) => isLotQcHeld(r));
  const lastRows = qcHeld === 'LAST' ? heldRows : [];
  // PREFERRED = hanya lot bernomor itu (retur/pemusnahan lot ditolak). Sisa kebutuhan tidak
  // boleh tumpah ke lot lolos — itu stok yang sudah boleh dipakai.
  const releasedRows = qcHeld === 'PREFERRED'
    ? allRows.filter((r) => preferred !== '' && String(r.lotNo || '').trim() === preferred)
    : allRows.filter((r) => !isLotQcHeld(r));
  // Qty cadangan rencana lain tidak ikut FEFO, kecuali rencana pemilik atau override yang disetujui;
  // sisa lot di atas qty cadangan tetap stok bebas. PREFERRED (retur/pemusnahan lot tertentu) tetap mengambil lot itu.
  const reservedOther = qcHeld === 'PREFERRED'
    ? new Map<string, number>()
    : await reservedQtyByLot(db, session, {
      tenantId: input.tenantId,
      lotIds: releasedRows.map((r) => r.id),
      planId: input.reservationPlanId,
    });
  const lockedQty = (b: IngredientLotDoc) => Math.min(
    effectiveIngredientQtyRemaining(b),
    reservedOther.get(b.id) || 0,
  );
  const freeQty = (b: IngredientLotDoc) => roundStockQty(effectiveIngredientQtyRemaining(b) - lockedQty(b));
  const lockedRows = releasedRows.filter((r) => lockedQty(r) > 0);
  const reservedLast = input.reservationOverride || qcHeld !== 'LAST' ? [] : lockedRows;
  const rows = releasedRows.filter((r) => freeQty(r) > 0);
  const overrideRows = input.reservationOverride ? lockedRows : [];
  // Semua lot tertahan QC / terkunci cadangan: bukan "stok tanpa lot".
  if (!rows.length && !overrideRows.length && !reservedLast.length && !lastRows.length) {
    return { ...empty, skippedNoLots: false };
  }

  const toCandidate = (b: IngredientLotDoc) => ({
    id: b.id,
    batchNo: b.lotNo,
    expiryDate: b.expiryDate,
    qtyRemaining: effectiveIngredientQtyRemaining(b),
    status: b.status,
  });
  const toFreeCandidate = (b: IngredientLotDoc) => ({ ...toCandidate(b), qtyRemaining: freeQty(b) });
  const toLockedCandidate = (b: IngredientLotDoc) => ({ ...toCandidate(b), qtyRemaining: lockedQty(b) });

  const allocOpts = {
    asOf: now,
    allowExpired: input.allowExpired,
  };

  // preferredLotNo: ambil dulu dari lot yang cocok, baru FEFO sisa di lot lain.
  // Tidak cukup reorder sebelum allocateFefo — allocator selalu sort ulang by expiry.
  const preferredRows = preferred
    ? rows.filter((r) => String(r.lotNo || '').trim() === preferred)
    : [];
  const otherRows = preferred
    ? rows.filter((r) => String(r.lotNo || '').trim() !== preferred)
    : rows;

  const merged: FefoAllocation[] = [];
  let left = needQty;

  // Ambilan dari qty bebas lot bercadangan rencana lain tidak mengurangi cadangan itu.
  const reservationTakes: Array<{ lotId: string; qty: number }> = [];
  const takeFree = (allocs: FefoAllocation[]) => {
    for (const a of allocs) if (!reservedOther.has(a.batchId)) reservationTakes.push({ lotId: a.batchId, qty: a.qty });
  };

  if (preferred && preferredRows.length && left > 0) {
    const prefPlan = allocateFefo(left, preferredRows.map(toFreeCandidate), allocOpts);
    merged.push(...prefPlan.allocations);
    takeFree(prefPlan.allocations);
    left = prefPlan.shortfall;
  }

  if (left > 0) {
    const restSource = preferred && preferredRows.length ? otherRows : rows;
    const restPlan = allocateFefo(left, restSource.map(toFreeCandidate), allocOpts);
    merged.push(...restPlan.allocations);
    takeFree(restPlan.allocations);
    left = restPlan.shortfall;
  }

  // Override: stok bebas dulu, baru cadangan rencana lain (urut kedaluwarsa).
  // Hitung fisik: barangnya tidak ada, cadangan ikut terpakai sebelum lot tertahan QC.
  const lockedSource = overrideRows.length ? overrideRows : reservedLast;
  if (left > 0 && lockedSource.length) {
    const lockedPlan = allocateFefo(left, lockedSource.map(toLockedCandidate), allocOpts);
    merged.push(...lockedPlan.allocations);
    reservationTakes.push(...lockedPlan.allocations.map((a) => ({ lotId: a.batchId, qty: a.qty })));
    left = lockedPlan.shortfall;
  }

  if (left > 0 && lastRows.length) {
    const heldPlan = allocateFefo(left, lastRows.map(toCandidate), allocOpts);
    merged.push(...heldPlan.allocations);
    reservationTakes.push(...heldPlan.allocations.map((a) => ({ lotId: a.batchId, qty: a.qty })));
    left = heldPlan.shortfall;
  }

  for (const a of merged) {
    const lot = allRows.find((r) => r.id === a.batchId);
    if (!lot) continue;
    const before = effectiveIngredientQtyRemaining(lot);
    const after = Math.max(0, roundStockQty(before - a.qty));
    const status = isZeroQty(after) ? 'CONSUMED' : lot.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE';
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

  await applyAllocationConsumption(db, session, {
    tenantId: input.tenantId,
    takes: reservationTakes,
    at: now,
  });

  return {
    stokId: input.stokId,
    warehouseKode: input.warehouseKode,
    needQty,
    allocated: roundStockQty(needQty - left),
    shortfall: roundStockQty(left),
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
  const needQty = roundStockQty((input.restores || []).reduce((s, a) => s + roundStockQty(a.qty), 0));
  const empty: IngredientLotRestoreResult = {
    stokId: input.stokId,
    needQty,
    restored: 0,
    shortfall: needQty,
    allocations: [],
  };
  if (!(needQty > 0)) return empty;

  const now = input.asOf ?? new Date();
  const today = businessDateIso(now);
  let restored = 0;
  const applied: FefoAllocation[] = [];

  for (const a of input.restores) {
    const qty = roundStockQty(a.qty);
    if (!(qty > 0) || !a.batchId) continue;
    const lot = await db.collection(INGREDIENT_LOTS_COLLECTION).findOne(
      { id: a.batchId, tenantId: input.tenantId },
      txOpts(session),
    ) as unknown as IngredientLotDoc | null;
    if (!lot) continue;

    const before = effectiveIngredientQtyRemaining(lot);
    const cap = Math.max(0, roundStockQty(lot.qty));
    const after = Math.min(cap, roundStockQty(before + qty));
    const gained = roundStockQty(after - before);
    if (!(gained > 0)) continue;

    const exp = String(lot.expiryDate || '').slice(0, 10);
    const past = /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < today;
    const status = isZeroQty(after) ? 'CONSUMED' : past ? 'EXPIRED' : 'ACTIVE';
    // Lot ditolak QC yang kembali (vendor menolak retur) → tindak lanjut dibuka lagi.
    const reopenReject = lot.qcStatus === 'REJECTED';

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
          ...(reopenReject ? { qcRejectStatus: 'PENDING' } : {}),
        },
        ...(reopenReject ? { $unset: { qcRejectRtvId: '', qcRejectNoReturn: '' } } : {}),
      },
      txOpts(session),
    );
    restored = roundStockQty(restored + gained);
    await applyAllocationRestore(db, session, {
      tenantId: input.tenantId,
      takes: [{ lotId: lot.id, qty: gained }],
      at: now,
    });
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
    shortfall: Math.max(0, roundStockQty(needQty - restored)),
    allocations: applied,
  };
}


/**
 * W2-5 Detect / Repair — ingredient_lots expiry + vs stok_lokasi.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  INGREDIENT_LOTS_COLLECTION,
  effectiveIngredientQtyRemaining,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { consumeIngredientLotsFefo } from '@/lib/food-production/ingredient-lot-consume';

export const INGREDIENT_LOT_RECONCILE_REPORTS_COLLECTION = 'ingredient_lot_reconcile_reports';

export type IngredientLotMismatch = {
  kind: 'ACTIVE_PAST_EXPIRY' | 'EXPIRED_WITH_QTY' | 'LOT_VS_STOK_LOKASI';
  lotId?: string;
  lotNo?: string;
  productId?: string;
  warehouseKode?: string;
  detail: string;
  qtyRemaining?: number;
  stokLokasi?: number;
};

export type IngredientLotReconcileReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedLots: number;
    totalMismatch: number;
    activePastExpiry: number;
    expiredWithQty: number;
    lotVsStok: number;
  };
  mismatches: IngredientLotMismatch[];
};

export async function detectIngredientLotMismatches(
  db: Db,
  tenantId: string,
  opts?: { asOf?: Date; limit?: number },
): Promise<IngredientLotReconcileReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const asOf = opts?.asOf ?? new Date();
  const today = asOf.toISOString().slice(0, 10);
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);

  const lots = await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find({ tenantId: tid, status: { $in: ['ACTIVE', 'EXPIRED'] } })
    .sort({ expiryDate: 1 })
    .limit(500)
    .toArray() as unknown as IngredientLotDoc[];

  const mismatches: IngredientLotMismatch[] = [];
  let activePastExpiry = 0;
  let expiredWithQty = 0;

  for (const lot of lots) {
    if (mismatches.length >= limit) break;
    const rem = effectiveIngredientQtyRemaining(lot);
    const exp = String(lot.expiryDate || '').slice(0, 10);
    const past = /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < today;

    if (lot.status === 'ACTIVE' && past && rem > 0) {
      activePastExpiry += 1;
      mismatches.push({
        kind: 'ACTIVE_PAST_EXPIRY',
        lotId: lot.id,
        lotNo: lot.lotNo,
        productId: lot.productId,
        warehouseKode: lot.warehouseKode,
        qtyRemaining: rem,
        detail: `ACTIVE past expiry ${exp} with remaining ${rem}`,
      });
    } else if ((lot.status === 'EXPIRED' || past) && rem > 0) {
      expiredWithQty += 1;
      mismatches.push({
        kind: 'EXPIRED_WITH_QTY',
        lotId: lot.id,
        lotNo: lot.lotNo,
        productId: lot.productId,
        warehouseKode: lot.warehouseKode,
        qtyRemaining: rem,
        detail: `Expired ${exp} still has remaining ${rem}`,
      });
    }
  }

  const byKey = new Map<string, { productId: string; warehouseKode: string; sum: number }>();
  for (const lot of lots) {
    const productId = String(lot.productId || '').trim();
    const wh = String(lot.warehouseKode || '').trim();
    if (!productId || !wh) continue;
    const rem = effectiveIngredientQtyRemaining(lot);
    if (!(rem > 0)) continue;
    const key = `${productId}|${wh}`;
    const cur = byKey.get(key) || { productId, warehouseKode: wh, sum: 0 };
    cur.sum += rem;
    byKey.set(key, cur);
  }

  let lotVsStok = 0;
  for (const { productId, warehouseKode, sum } of byKey.values()) {
    if (mismatches.length >= limit) break;
    const lokasi = await getQtyStokLokasi(db, tid, productId, warehouseKode);
    const stock = typeof lokasi === 'number' ? lokasi : Number(lokasi);
    if (!Number.isFinite(stock)) continue;
    if (sum > stock + 0.001) {
      lotVsStok += 1;
      mismatches.push({
        kind: 'LOT_VS_STOK_LOKASI',
        productId,
        warehouseKode,
        qtyRemaining: sum,
        stokLokasi: stock,
        detail: `sum(qtyRemaining)=${sum} > stok_lokasi=${stock}`,
      });
    }
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedLots: lots.length,
      totalMismatch: mismatches.length,
      activePastExpiry,
      expiredWithQty,
      lotVsStok,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runIngredientLotDetect(
  db: Db,
  tenantId: string,
): Promise<IngredientLotReconcileReport> {
  const report = await detectIngredientLotMismatches(db, tenantId);
  await db.collection(INGREDIENT_LOT_RECONCILE_REPORTS_COLLECTION).insertOne(report);
  return report;
}

export type IngredientLotRepairResult = {
  tenantId: string;
  detectReportId: string;
  repaired: number;
  actions: Array<{
    kind: string;
    lotId?: string;
    productId?: string;
    warehouseKode?: string;
    detail: string;
  }>;
  afterSummary: IngredientLotReconcileReport['summary'];
  at: Date;
};

/**
 * W2-5/W2-7 Repair:
 * - ACTIVE_PAST_EXPIRY → EXPIRED
 * - LOT_VS_STOK_LOKASI (sum > stock) → FEFO consume excess (parity W2-4)
 */
export async function repairIngredientLotMismatches(
  db: Db,
  tenantId: string,
): Promise<IngredientLotRepairResult> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const now = new Date();
  const detect = await detectIngredientLotMismatches(db, tid);
  await db.collection(INGREDIENT_LOT_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...detect,
    phase: 'detect-before-repair',
  });

  const actions: IngredientLotRepairResult['actions'] = [];
  let repaired = 0;

  for (const m of detect.mismatches) {
    if (m.kind === 'ACTIVE_PAST_EXPIRY' && m.lotId) {
      const res = await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
        { id: m.lotId, tenantId: tid, status: 'ACTIVE' },
        { $set: { status: 'EXPIRED', updatedAt: now } },
      );
      if (res.modifiedCount > 0) {
        repaired += 1;
        actions.push({
          kind: m.kind,
          lotId: m.lotId,
          productId: m.productId,
          warehouseKode: m.warehouseKode,
          detail: `Marked EXPIRED · ${m.lotNo || m.lotId}`,
        });
      }
      continue;
    }

    if (m.kind === 'LOT_VS_STOK_LOKASI' && m.productId && m.warehouseKode) {
      const excess = Number(m.qtyRemaining || 0) - Number(m.stokLokasi || 0);
      if (!(excess > 0.001)) continue;
      const fefo = await consumeIngredientLotsFefo(db, {
        tenantId: tid,
        stokId: m.productId,
        warehouseKode: m.warehouseKode,
        needQty: excess,
        asOf: now,
        allowExpired: true,
        noDokumen: `LOT-REPAIR-${detect.id.slice(0, 8)}`,
      });
      if (fefo.allocated > 0) {
        repaired += 1;
        actions.push({
          kind: m.kind,
          productId: m.productId,
          warehouseKode: m.warehouseKode,
          detail: `Consumed excess ${fefo.allocated} (shortfall ${fefo.shortfall})`,
        });
      }
    }
  }

  const after = await detectIngredientLotMismatches(db, tid);
  await db.collection(INGREDIENT_LOT_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...after,
    phase: 'detect-after-repair',
    repairActions: actions,
  });

  return {
    tenantId: tid,
    detectReportId: detect.id,
    repaired,
    actions,
    afterSummary: after.summary,
    at: now,
  };
}

/**
 * W2-1 Detect · W2-4 Repair — FEFO / batch qty vs stok_lokasi.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveQtyRemaining,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { getQtyStokLokasi } from '@/lib/api/stok-lokasi';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';

export const FEFO_RECONCILE_REPORTS_COLLECTION = 'fefo_batch_reconcile_reports';

export type FefoMismatch = {
  kind:
    | 'EXPIRED_WITH_QTY'
    | 'ACTIVE_PAST_EXPIRY'
    | 'QTY_REMAINING_GT_QTY'
    | 'BATCH_VS_STOK_LOKASI';
  batchId?: string;
  batchNo?: string;
  stokId?: string;
  warehouseKode?: string;
  detail: string;
  qtyRemaining?: number;
  stokLokasi?: number;
};

export type FefoReconcileReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedBatches: number;
    totalMismatch: number;
    expiredWithQty: number;
    activePastExpiry: number;
    qtyCorruption: number;
    batchVsStok: number;
  };
  mismatches: FefoMismatch[];
};

export async function detectFefoBatchMismatches(
  db: Db,
  tenantId: string,
  opts?: { asOf?: Date; limit?: number },
): Promise<FefoReconcileReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const asOf = opts?.asOf ?? new Date();
  const today = asOf.toISOString().slice(0, 10);
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);

  const batches = await db
    .collection(PRODUCTION_BATCHES_COLLECTION)
    .find({
      tenantId: tid,
      status: { $in: ['ACTIVE', 'EXPIRED'] },
    })
    .sort({ expiryDate: 1 })
    .limit(500)
    .toArray() as unknown as ProductionBatchDoc[];

  const mismatches: FefoMismatch[] = [];
  let expiredWithQty = 0;
  let activePastExpiry = 0;
  let qtyCorruption = 0;

  for (const b of batches) {
    if (mismatches.length >= limit) break;
    const rem = effectiveQtyRemaining(b);
    const exp = String(b.expiryDate || '').slice(0, 10);
    const past = /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < today;

    if (rem > Number(b.qty || 0) + 1e-9) {
      qtyCorruption += 1;
      mismatches.push({
        kind: 'QTY_REMAINING_GT_QTY',
        batchId: b.id,
        batchNo: b.batchNo,
        stokId: b.finishedGoodProductId,
        warehouseKode: b.warehouseKode,
        qtyRemaining: rem,
        detail: `qtyRemaining ${rem} > qty ${b.qty}`,
      });
    }

    if (b.status === 'ACTIVE' && past && rem > 0) {
      activePastExpiry += 1;
      mismatches.push({
        kind: 'ACTIVE_PAST_EXPIRY',
        batchId: b.id,
        batchNo: b.batchNo,
        stokId: b.finishedGoodProductId,
        warehouseKode: b.warehouseKode,
        qtyRemaining: rem,
        detail: `ACTIVE past expiry ${exp} with remaining ${rem}`,
      });
    } else if ((b.status === 'EXPIRED' || past) && rem > 0) {
      expiredWithQty += 1;
      mismatches.push({
        kind: 'EXPIRED_WITH_QTY',
        batchId: b.id,
        batchNo: b.batchNo,
        stokId: b.finishedGoodProductId,
        warehouseKode: b.warehouseKode,
        qtyRemaining: rem,
        detail: `Expired ${exp} still has remaining ${rem}`,
      });
    }
  }

  // Aggregate remaining by product+warehouse vs stok_lokasi (only keys that have batches).
  const byKey = new Map<string, { stokId: string; warehouseKode: string; sum: number }>();
  for (const b of batches) {
    const stokId = String(b.finishedGoodProductId || '').trim();
    const wh = String(b.warehouseKode || '').trim();
    if (!stokId || !wh) continue;
    const rem = effectiveQtyRemaining(b);
    if (!(rem > 0)) continue;
    const key = `${stokId}|${wh}`;
    const cur = byKey.get(key) || { stokId, warehouseKode: wh, sum: 0 };
    cur.sum += rem;
    byKey.set(key, cur);
  }

  let batchVsStok = 0;
  for (const { stokId, warehouseKode, sum } of byKey.values()) {
    if (mismatches.length >= limit) break;
    const lokasi = await getQtyStokLokasi(db, tid, stokId, warehouseKode);
    const stock = typeof lokasi === 'number' ? lokasi : Number(lokasi);
    if (!Number.isFinite(stock)) continue;
    // Soft band: batch remaining should not exceed ledger by > 0.001
    if (sum > stock + 0.001) {
      batchVsStok += 1;
      mismatches.push({
        kind: 'BATCH_VS_STOK_LOKASI',
        stokId,
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
      scannedBatches: batches.length,
      totalMismatch: mismatches.length,
      expiredWithQty,
      activePastExpiry,
      qtyCorruption,
      batchVsStok,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runFefoBatchDetect(
  db: Db,
  tenantId: string,
): Promise<FefoReconcileReport> {
  const report = await detectFefoBatchMismatches(db, tenantId);
  await db.collection(FEFO_RECONCILE_REPORTS_COLLECTION).insertOne(report);
  return report;
}

export type FefoRepairResult = {
  tenantId: string;
  detectReportId: string;
  repaired: number;
  actions: Array<{
    kind: string;
    stokId?: string;
    warehouseKode?: string;
    batchId?: string;
    detail: string;
  }>;
  afterSummary: FefoReconcileReport['summary'];
  at: Date;
};

/**
 * W2-4 Repair:
 * - ACTIVE_PAST_EXPIRY → status EXPIRED
 * - BATCH_VS_STOK_LOKASI (sum > stock) → FEFO consume excess
 */
export async function repairFefoBatchMismatches(
  db: Db,
  tenantId: string,
): Promise<FefoRepairResult> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const now = new Date();
  const detect = await detectFefoBatchMismatches(db, tid);
  await db.collection(FEFO_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...detect,
    phase: 'detect-before-repair',
  });

  const actions: FefoRepairResult['actions'] = [];
  let repaired = 0;

  for (const m of detect.mismatches) {
    if (m.kind === 'ACTIVE_PAST_EXPIRY' && m.batchId) {
      const res = await db.collection(PRODUCTION_BATCHES_COLLECTION).updateOne(
        { id: m.batchId, tenantId: tid, status: 'ACTIVE' },
        { $set: { status: 'EXPIRED', updatedAt: now } },
      );
      if (res.modifiedCount > 0) {
        repaired += 1;
        actions.push({
          kind: m.kind,
          batchId: m.batchId,
          stokId: m.stokId,
          warehouseKode: m.warehouseKode,
          detail: `Marked EXPIRED · ${m.batchNo || m.batchId}`,
        });
      }
      continue;
    }

    if (m.kind === 'BATCH_VS_STOK_LOKASI' && m.stokId && m.warehouseKode) {
      const excess = Number(m.qtyRemaining || 0) - Number(m.stokLokasi || 0);
      if (!(excess > 0.001)) continue;
      const fefo = await consumeBatchesFefo(db, {
        tenantId: tid,
        stokId: m.stokId,
        warehouseKode: m.warehouseKode,
        needQty: excess,
        asOf: now,
        allowExpired: true,
        noDokumen: `FEFO-REPAIR-${detect.id.slice(0, 8)}`,
      });
      if (fefo.allocated > 0) {
        repaired += 1;
        actions.push({
          kind: m.kind,
          stokId: m.stokId,
          warehouseKode: m.warehouseKode,
          detail: `Consumed excess ${fefo.allocated} (shortfall ${fefo.shortfall})`,
        });
      }
    }
  }

  const after = await detectFefoBatchMismatches(db, tid);
  await db.collection(FEFO_RECONCILE_REPORTS_COLLECTION).insertOne({
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

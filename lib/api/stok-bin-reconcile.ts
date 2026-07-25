/**
 * W2-17 Detect — sum(stok_bin) vs stok_lokasi (warehouse grain).
 * Soft only; unslotted warehouse qty commonly appears as BIN_SUM_LT.
 * W2-22 Repair LT — soft-allocate BIN_SUM_LT residual to default bin (never GT / stok_lokasi).
 * W2-23 Repair GT — soft-consume BIN_SUM_GT overage via consumeStokBinSoft (never LT / stok_lokasi).
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { allocateStokBinSoft } from '@/lib/api/stok-bin-allocate';
import { consumeStokBinSoft } from '@/lib/api/stok-bin-consume';
import { STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';

export const STOK_BIN_RECONCILE_REPORTS_COLLECTION = 'stok_bin_reconcile_reports';

const EPS = 0.0005;

export type StokBinMismatch = {
  kind: 'BIN_SUM_GT_STOK_LOKASI' | 'BIN_SUM_LT_STOK_LOKASI';
  stokId: string;
  warehouseKode: string;
  binQtySum: number;
  stokLokasiQty: number;
  delta: number;
  detail: string;
};

export type StokBinRepairAction = {
  kind:
    | 'BIN_SUM_LT_STOK_LOKASI'
    | 'SKIP_NO_DEFAULT_BIN'
    | 'SKIP_ALLOCATE_FAIL'
    | 'BIN_SUM_GT_STOK_LOKASI'
    | 'SKIP_NO_BINS'
    | 'SKIP_CONSUME_SHORTFALL';
  stokId: string;
  warehouseKode: string;
  binKode?: string;
  /** LT residual or GT overage (amount targeted for soft repair). */
  residual: number;
  allocated: number;
  detail: string;
};

export type StokBinReconcileReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedKeys: number;
    totalMismatch: number;
    binSumGt: number;
    binSumLt: number;
  };
  mismatches: StokBinMismatch[];
  /** Optional — set on repair before/after Detect inserts only. */
  phase?: string;
  repairActions?: StokBinRepairAction[];
};

export type StokBinRepairResult = {
  detectBeforeId: string;
  detectAfterId: string;
  tenantId: string;
  repaired: number;
  skippedNoDefaultBin: number;
  skippedOther: number;
  ignoredGt: number;
  actions: StokBinRepairAction[];
  afterSummary: StokBinReconcileReport['summary'];
  at: string;
};

export type StokBinGtRepairResult = {
  detectBeforeId: string;
  detectAfterId: string;
  tenantId: string;
  repaired: number;
  skippedNoBins: number;
  skippedOther: number;
  ignoredLt: number;
  actions: StokBinRepairAction[];
  afterSummary: StokBinReconcileReport['summary'];
  at: string;
};

function qtyNum(v: unknown): number {
  return Math.round((parseFloat(String(v)) || 0) * 1000) / 1000;
}

export async function detectStokBinVsLokasi(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<StokBinReconcileReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const binAgg = await db.collection(STOK_BIN_COLLECTION).aggregate<{
    _id: { stokId: string; warehouseKode: string };
    qtySum: number;
  }>([
    { $match: { tenantId: tid } },
    {
      $group: {
        _id: { stokId: '$stokId', warehouseKode: '$warehouseKode' },
        qtySum: { $sum: '$qty' },
      },
    },
  ]).toArray();

  const binByKey = new Map<string, number>();
  for (const row of binAgg) {
    const stokId = String(row._id?.stokId || '');
    const wh = String(row._id?.warehouseKode || '');
    if (!stokId || !wh) continue;
    binByKey.set(`${stokId}:${wh}`, qtyNum(row.qtySum));
  }

  const lokasiRows = await db.collection('stok_lokasi').find(
    { tenantId: tid, qty: { $ne: 0 } },
    { projection: { stokId: 1, lokasiKode: 1, qty: 1 } },
  ).limit(5000).toArray();

  const lokByKey = new Map<string, number>();
  for (const row of lokasiRows) {
    const stokId = String(row.stokId || '');
    const wh = String(row.lokasiKode || '');
    if (!stokId || !wh) continue;
    lokByKey.set(`${stokId}:${wh}`, qtyNum(row.qty));
  }

  const keys = new Set<string>([...binByKey.keys(), ...lokByKey.keys()]);
  const mismatches: StokBinMismatch[] = [];
  let binSumGt = 0;
  let binSumLt = 0;

  for (const key of keys) {
    if (mismatches.length >= limit) break;
    const [stokId, warehouseKode] = key.split(':');
    const binQtySum = binByKey.get(key) || 0;
    const stokLokasiQty = lokByKey.get(key) || 0;
    const delta = Math.round((binQtySum - stokLokasiQty) * 1000) / 1000;
    if (Math.abs(delta) <= EPS) continue;

    if (delta > 0) {
      binSumGt += 1;
      mismatches.push({
        kind: 'BIN_SUM_GT_STOK_LOKASI',
        stokId,
        warehouseKode,
        binQtySum,
        stokLokasiQty,
        delta,
        detail: `${stokId}@${warehouseKode} · binSum ${binQtySum} > stok_lokasi ${stokLokasiQty}`,
      });
    } else {
      binSumLt += 1;
      mismatches.push({
        kind: 'BIN_SUM_LT_STOK_LOKASI',
        stokId,
        warehouseKode,
        binQtySum,
        stokLokasiQty,
        delta,
        detail: `${stokId}@${warehouseKode} · binSum ${binQtySum} < stok_lokasi ${stokLokasiQty} (unslotted OK until putaway)`,
      });
    }
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedKeys: keys.size,
      totalMismatch: mismatches.length,
      binSumGt,
      binSumLt,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runStokBinDetect(
  db: Db,
  tenantId: string,
): Promise<StokBinReconcileReport> {
  const report = await detectStokBinVsLokasi(db, tenantId);
  await db.collection(STOK_BIN_RECONCILE_REPORTS_COLLECTION).insertOne(report);
  return report;
}

/**
 * W2-22 Repair (MASTER):
 * - BIN_SUM_LT only → soft-allocate residual to default bin via allocateStokBinSoft
 * - Never repair BIN_SUM_GT; never write stok_lokasi
 */
export async function repairStokBinMismatches(
  db: Db,
  tenantId: string,
): Promise<StokBinRepairResult> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const at = new Date().toISOString();

  const before = await detectStokBinVsLokasi(db, tid);
  await db.collection(STOK_BIN_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...before,
    phase: 'detect-before-repair',
  });

  const actions: StokBinRepairAction[] = [];
  let repaired = 0;
  let skippedNoDefaultBin = 0;
  let skippedOther = 0;
  const ignoredGt = before.mismatches.filter(
    (m) => m.kind === 'BIN_SUM_GT_STOK_LOKASI',
  ).length;

  for (const m of before.mismatches) {
    if (m.kind !== 'BIN_SUM_LT_STOK_LOKASI') continue;

    const residual = Math.round((m.stokLokasiQty - m.binQtySum) * 1000) / 1000;
    if (!(residual > EPS)) continue;

    const alloc = await allocateStokBinSoft(
      db,
      tid,
      m.stokId,
      m.warehouseKode,
      residual,
    );

    if (alloc.allocated > 0) {
      repaired += 1;
      actions.push({
        kind: 'BIN_SUM_LT_STOK_LOKASI',
        stokId: m.stokId,
        warehouseKode: m.warehouseKode,
        binKode: alloc.binKode,
        residual,
        allocated: alloc.allocated,
        detail: `Soft-allocated residual ${alloc.allocated} → bin ${alloc.binKode || '?'}@${m.warehouseKode}`,
      });
      continue;
    }

    if (alloc.skippedNoDefaultBin) {
      skippedNoDefaultBin += 1;
      actions.push({
        kind: 'SKIP_NO_DEFAULT_BIN',
        stokId: m.stokId,
        warehouseKode: m.warehouseKode,
        residual,
        allocated: 0,
        detail: `No default bin · residual ${residual} left unslotted @${m.warehouseKode}`,
      });
      continue;
    }

    skippedOther += 1;
    actions.push({
      kind: 'SKIP_ALLOCATE_FAIL',
      stokId: m.stokId,
      warehouseKode: m.warehouseKode,
      binKode: alloc.binKode,
      residual,
      allocated: 0,
      detail: `allocateStokBinSoft failed · residual ${residual} @${m.warehouseKode}`,
    });
  }

  const after = await detectStokBinVsLokasi(db, tid);
  await db.collection(STOK_BIN_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...after,
    phase: 'detect-after-repair',
    repairActions: actions,
  });

  return {
    detectBeforeId: before.id,
    detectAfterId: after.id,
    tenantId: tid,
    repaired,
    skippedNoDefaultBin,
    skippedOther,
    ignoredGt,
    actions,
    afterSummary: after.summary,
    at,
  };
}

/**
 * W2-23 Repair GT (MASTER):
 * - BIN_SUM_GT only → soft-consume overage via consumeStokBinSoft
 * - Never repair BIN_SUM_LT; never write stok_lokasi
 * - Partial consume (allocated > 0) still counts as repaired
 */
export async function repairStokBinGtMismatches(
  db: Db,
  tenantId: string,
): Promise<StokBinGtRepairResult> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const at = new Date().toISOString();

  const before = await detectStokBinVsLokasi(db, tid);
  await db.collection(STOK_BIN_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...before,
    phase: 'detect-before-repair-gt',
  });

  const actions: StokBinRepairAction[] = [];
  let repaired = 0;
  let skippedNoBins = 0;
  let skippedOther = 0;
  const ignoredLt = before.mismatches.filter(
    (m) => m.kind === 'BIN_SUM_LT_STOK_LOKASI',
  ).length;

  for (const m of before.mismatches) {
    if (m.kind !== 'BIN_SUM_GT_STOK_LOKASI') continue;

    const over = Math.round((m.binQtySum - m.stokLokasiQty) * 1000) / 1000;
    if (!(over > EPS)) continue;

    const consumed = await consumeStokBinSoft(
      db,
      tid,
      m.stokId,
      m.warehouseKode,
      over,
    );

    if (consumed.allocated > 0) {
      repaired += 1;
      const firstBin = consumed.takes[0]?.binKode;
      actions.push({
        kind: 'BIN_SUM_GT_STOK_LOKASI',
        stokId: m.stokId,
        warehouseKode: m.warehouseKode,
        binKode: firstBin,
        residual: over,
        allocated: consumed.allocated,
        detail: `Soft-consumed overage ${consumed.allocated}/${over} @${m.warehouseKode}`
          + (consumed.shortfall > 0 ? ` · shortfall ${consumed.shortfall}` : ''),
      });
      continue;
    }

    if (consumed.skippedNoBins) {
      skippedNoBins += 1;
      actions.push({
        kind: 'SKIP_NO_BINS',
        stokId: m.stokId,
        warehouseKode: m.warehouseKode,
        residual: over,
        allocated: 0,
        detail: `No bins with qty · overage ${over} left @${m.warehouseKode}`,
      });
      continue;
    }

    skippedOther += 1;
    actions.push({
      kind: 'SKIP_CONSUME_SHORTFALL',
      stokId: m.stokId,
      warehouseKode: m.warehouseKode,
      residual: over,
      allocated: 0,
      detail: `consumeStokBinSoft shortfall · overage ${over} @${m.warehouseKode}`,
    });
  }

  const after = await detectStokBinVsLokasi(db, tid);
  await db.collection(STOK_BIN_RECONCILE_REPORTS_COLLECTION).insertOne({
    ...after,
    phase: 'detect-after-repair-gt',
    repairActions: actions,
  });

  return {
    detectBeforeId: before.id,
    detectAfterId: after.id,
    tenantId: tid,
    repaired,
    skippedNoBins,
    skippedOther,
    ignoredLt,
    actions,
    afterSummary: after.summary,
    at,
  };
}

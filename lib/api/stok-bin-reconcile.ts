/**
 * W2-17 Detect — sum(stok_bin) vs stok_lokasi (warehouse grain).
 * Soft only; unslotted warehouse qty commonly appears as BIN_SUM_LT.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
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

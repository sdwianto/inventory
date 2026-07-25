/**
 * W2-15 Detect — HSL waste capture without FP_RESULT_WASTE ledger (legacy drift).
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  PRODUCTION_RESULTS_COLLECTION,
  type ProductionResultDoc,
} from '@/lib/food-production/production-result';

export const HSL_WASTE_RECONCILE_REPORTS_COLLECTION = 'hsl_waste_reconcile_reports';

export type HslWasteMismatch = {
  kind: 'HSL_WASTE_UNPOSTED';
  resultId: string;
  noDokumen?: string;
  wastePorsiTotal: number;
  detail: string;
};

export type HslWasteReconcileReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedResults: number;
    totalMismatch: number;
    wasteQtyTotal: number;
  };
  mismatches: HslWasteMismatch[];
};

export async function detectHslWasteUnposted(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<HslWasteReconcileReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const results = (await db
    .collection(PRODUCTION_RESULTS_COLLECTION)
    .find({
      tenantId: tid,
      status: 'COMPLETED',
      'summary.wastePorsiTotal': { $gt: 0 },
      wasteStockPostedAt: { $exists: false },
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as ProductionResultDoc[];

  const mismatches: HslWasteMismatch[] = [];
  let wasteQtyTotal = 0;

  for (const row of results) {
    if (mismatches.length >= limit) break;
    const hasFgWaste = (row.lines || []).some(
      (l) =>
        Boolean(String(l.finishedGoodProductId || '').trim())
        && Number(l.wastePorsi || 0) > 0,
    );
    if (!hasFgWaste) continue;
    const waste = Number(row.summary?.wastePorsiTotal || 0);
    wasteQtyTotal += waste;
    mismatches.push({
      kind: 'HSL_WASTE_UNPOSTED',
      resultId: row.id,
      noDokumen: row.noDokumen,
      wastePorsiTotal: waste,
      detail: `${row.noDokumen || row.id} · waste ${waste} captured but FP_RESULT_WASTE not posted`,
    });
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedResults: results.length,
      totalMismatch: mismatches.length,
      wasteQtyTotal,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runHslWasteDetect(
  db: Db,
  tenantId: string,
): Promise<HslWasteReconcileReport> {
  const report = await detectHslWasteUnposted(db, tenantId);
  await db.collection(HSL_WASTE_RECONCILE_REPORTS_COLLECTION).insertOne(report);
  return report;
}

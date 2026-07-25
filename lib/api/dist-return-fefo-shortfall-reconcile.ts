/**
 * W2-14 Detect — Distribution return FEFO restore shortfall (W2-3 deferred drift).
 * Shortfall does not fail COMPLETE; Detect reports it for Ops / KA.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  DISTRIBUTION_ORDERS_COLLECTION,
  type DistributionOrderDoc,
} from '@/lib/food-production/distribution';

export const DIST_RETURN_FEFO_SHORTFALL_REPORTS_COLLECTION = 'dist_return_fefo_shortfall_reports';

export type DistReturnFefoShortfallMismatch = {
  kind: 'DIST_RETURN_FEFO_SHORTFALL';
  distId: string;
  noDokumen?: string;
  stokId: string;
  warehouseKode?: string;
  needQty: number;
  restored: number;
  shortfall: number;
  detail: string;
};

export type DistReturnFefoShortfallReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedOrders: number;
    ordersWithShortfall: number;
    totalMismatch: number;
    shortfallQtyTotal: number;
  };
  mismatches: DistReturnFefoShortfallMismatch[];
};

function isRestoreShortfallLine(
  row: NonNullable<DistributionOrderDoc['fefoRestore']>[number],
): boolean {
  return Number(row.shortfall || 0) > 0.001;
}

export async function detectDistReturnFefoShortfalls(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<DistReturnFefoShortfallReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const orders = (await db
    .collection(DISTRIBUTION_ORDERS_COLLECTION)
    .find({
      tenantId: tid,
      status: 'COMPLETED',
      fefoRestore: { $exists: true, $ne: [] },
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as DistributionOrderDoc[];

  const mismatches: DistReturnFefoShortfallMismatch[] = [];
  const orderIds = new Set<string>();
  let shortfallQtyTotal = 0;

  for (const order of orders) {
    if (mismatches.length >= limit) break;
    const rows = Array.isArray(order.fefoRestore) ? order.fefoRestore : [];
    const wh = String(order.warehouseKode || '');
    for (const row of rows) {
      if (mismatches.length >= limit) break;
      if (!isRestoreShortfallLine(row)) continue;
      const shortfall = Number(row.shortfall || 0);
      shortfallQtyTotal += shortfall;
      orderIds.add(order.id);
      mismatches.push({
        kind: 'DIST_RETURN_FEFO_SHORTFALL',
        distId: order.id,
        noDokumen: order.noDokumen,
        stokId: String(row.stokId || ''),
        warehouseKode: wh || undefined,
        needQty: Number(row.needQty || 0),
        restored: Number(row.restored || 0),
        shortfall,
        detail:
          `${order.noDokumen || order.id} · need ${row.needQty} restored ${row.restored} shortfall ${shortfall}` +
          ` · ${row.stokId}${wh ? `@${wh}` : ''}`,
      });
    }
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedOrders: orders.length,
      ordersWithShortfall: orderIds.size,
      totalMismatch: mismatches.length,
      shortfallQtyTotal,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runDistReturnFefoShortfallDetect(
  db: Db,
  tenantId: string,
): Promise<DistReturnFefoShortfallReport> {
  const report = await detectDistReturnFefoShortfalls(db, tenantId);
  await db.collection(DIST_RETURN_FEFO_SHORTFALL_REPORTS_COLLECTION).insertOne(report);
  return report;
}

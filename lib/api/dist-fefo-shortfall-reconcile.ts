/**
 * W2-10 Detect — Distribution FEFO shortfall (W2-2 deferred drift).
 * Shortfall does not fail ship; Detect reports it for Ops / KA.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  DISTRIBUTION_ORDERS_COLLECTION,
  type DistributionOrderDoc,
} from '@/lib/food-production/distribution';

export const DIST_FEFO_SHORTFALL_REPORTS_COLLECTION = 'dist_fefo_shortfall_reports';

export type DistFefoShortfallMismatch = {
  kind: 'DIST_FEFO_SHORTFALL';
  distId: string;
  noDokumen?: string;
  stokId: string;
  warehouseKode?: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  detail: string;
};

export type DistFefoShortfallReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedOrders: number;
    ordersWithShortfall: number;
    totalMismatch: number;
    shortfallQtyTotal: number;
  };
  mismatches: DistFefoShortfallMismatch[];
};

function isShortfallLine(
  row: NonNullable<DistributionOrderDoc['fefoConsume']>[number],
): boolean {
  if (row.skippedNoBatches) return false;
  return Number(row.shortfall || 0) > 0.001;
}

export async function detectDistFefoShortfalls(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<DistFefoShortfallReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const orders = (await db
    .collection(DISTRIBUTION_ORDERS_COLLECTION)
    .find({
      tenantId: tid,
      status: { $in: ['PROCESSING', 'COMPLETED'] },
      fefoConsume: { $exists: true, $ne: [] },
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as DistributionOrderDoc[];

  const mismatches: DistFefoShortfallMismatch[] = [];
  const orderIds = new Set<string>();
  let shortfallQtyTotal = 0;

  for (const order of orders) {
    if (mismatches.length >= limit) break;
    const rows = Array.isArray(order.fefoConsume) ? order.fefoConsume : [];
    const wh = String(order.warehouseKode || '');
    for (const row of rows) {
      if (mismatches.length >= limit) break;
      if (!isShortfallLine(row)) continue;
      const shortfall = Number(row.shortfall || 0);
      shortfallQtyTotal += shortfall;
      orderIds.add(order.id);
      mismatches.push({
        kind: 'DIST_FEFO_SHORTFALL',
        distId: order.id,
        noDokumen: order.noDokumen,
        stokId: String(row.stokId || ''),
        warehouseKode: wh || undefined,
        needQty: Number(row.needQty || 0),
        allocated: Number(row.allocated || 0),
        shortfall,
        detail:
          `${order.noDokumen || order.id} · need ${row.needQty} allocated ${row.allocated} shortfall ${shortfall}` +
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

export async function runDistFefoShortfallDetect(
  db: Db,
  tenantId: string,
): Promise<DistFefoShortfallReport> {
  const report = await detectDistFefoShortfalls(db, tenantId);
  await db.collection(DIST_FEFO_SHORTFALL_REPORTS_COLLECTION).insertOne(report);
  return report;
}

/**
 * W2-11 Detect — Inventory Release FEFO shortfall (W2-1 deferred drift).
 * Shortfall does not fail Release; Detect reports it for Ops / KA.
 * Note: release fefoConsume persists allocated/shortfall (no needQty) — infer need = allocated + shortfall.
 */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

export const INVENTORY_RELEASES_COLLECTION = 'inventory_releases';
export const RELEASE_FEFO_SHORTFALL_REPORTS_COLLECTION = 'release_fefo_shortfall_reports';

export type ReleaseFefoConsumeLine = {
  stokId: string;
  allocated: number;
  shortfall: number;
  skippedNoBatches: boolean;
  allocations?: unknown[];
};

export type InventoryReleaseDoc = {
  id: string;
  tenantId: string;
  noRelease?: string;
  status: string;
  lokasiKode?: string;
  fefoConsume?: ReleaseFefoConsumeLine[];
  updatedAt?: Date;
};

export type ReleaseFefoShortfallMismatch = {
  kind: 'RELEASE_FEFO_SHORTFALL';
  releaseId: string;
  noRelease?: string;
  stokId: string;
  warehouseKode?: string;
  needQty: number;
  allocated: number;
  shortfall: number;
  detail: string;
};

export type ReleaseFefoShortfallReport = {
  id: string;
  tenantId: string;
  createdAt: Date;
  summary: {
    scannedReleases: number;
    releasesWithShortfall: number;
    totalMismatch: number;
    shortfallQtyTotal: number;
  };
  mismatches: ReleaseFefoShortfallMismatch[];
};

function isShortfallLine(row: ReleaseFefoConsumeLine): boolean {
  if (row.skippedNoBatches) return false;
  return Number(row.shortfall || 0) > 0.001;
}

export async function detectReleaseFefoShortfalls(
  db: Db,
  tenantId: string,
  opts?: { limit?: number },
): Promise<ReleaseFefoShortfallReport> {
  const tid = String(tenantId || 'default').trim() || 'default';
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const asOf = new Date();

  const releases = (await db
    .collection(INVENTORY_RELEASES_COLLECTION)
    .find({
      tenantId: tid,
      status: 'POSTED',
      fefoConsume: { $exists: true, $ne: [] },
    })
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray()) as unknown as InventoryReleaseDoc[];

  const mismatches: ReleaseFefoShortfallMismatch[] = [];
  const releaseIds = new Set<string>();
  let shortfallQtyTotal = 0;

  for (const release of releases) {
    if (mismatches.length >= limit) break;
    const rows = Array.isArray(release.fefoConsume) ? release.fefoConsume : [];
    const wh = String(release.lokasiKode || '');
    for (const row of rows) {
      if (mismatches.length >= limit) break;
      if (!isShortfallLine(row)) continue;
      const shortfall = Number(row.shortfall || 0);
      const allocated = Number(row.allocated || 0);
      const needQty = allocated + shortfall;
      shortfallQtyTotal += shortfall;
      releaseIds.add(release.id);
      mismatches.push({
        kind: 'RELEASE_FEFO_SHORTFALL',
        releaseId: release.id,
        noRelease: release.noRelease,
        stokId: String(row.stokId || ''),
        warehouseKode: wh || undefined,
        needQty,
        allocated,
        shortfall,
        detail:
          `${release.noRelease || release.id} · need ${needQty} allocated ${allocated} shortfall ${shortfall}` +
          ` · ${row.stokId}${wh ? `@${wh}` : ''}`,
      });
    }
  }

  return {
    id: uuidv4(),
    tenantId: tid,
    createdAt: asOf,
    summary: {
      scannedReleases: releases.length,
      releasesWithShortfall: releaseIds.size,
      totalMismatch: mismatches.length,
      shortfallQtyTotal,
    },
    mismatches: mismatches.slice(0, limit),
  };
}

export async function runReleaseFefoShortfallDetect(
  db: Db,
  tenantId: string,
): Promise<ReleaseFefoShortfallReport> {
  const report = await detectReleaseFefoShortfalls(db, tenantId);
  await db.collection(RELEASE_FEFO_SHORTFALL_REPORTS_COLLECTION).insertOne(report);
  return report;
}

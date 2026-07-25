/**
 * W2-19 / W2-20 — Soft OUT bin consume.
 * After warehouse OUT succeeds, decrement `stok_bin` (default bin first, then greedy).
 * Never throws; shortfall / missing bins do not fail the warehouse mutation.
 */

import type { ClientSession, Db } from 'mongodb';
import { adjustStokBin, STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import { isValidWarehouseKode, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { txOpts } from '@/lib/api/transaction';

export type ConsumeStokBinSoftResult = {
  allocated: number;
  shortfall: number;
  skippedNoBins: boolean;
  takes: Array<{ binKode: string; qty: number }>;
};

type SoftConsumeFn = (
  db: Db,
  tenantId: string,
  stokId: string,
  warehouseKode: string,
  qtyNeed: number,
  session?: ClientSession,
) => Promise<ConsumeStokBinSoftResult>;

function emptyResult(shortfall = 0, skippedNoBins = false): ConsumeStokBinSoftResult {
  return { allocated: 0, shortfall, skippedNoBins, takes: [] };
}

/**
 * Soft-decrement bin qty for an OUT. Prefer default bin, then binKode ascending.
 * `qtyNeed` is the positive amount to consume (callers typically pass `-delta`).
 */
export async function consumeStokBinSoft(
  db: Db,
  tenantId: string,
  stokId: string,
  warehouseKode: string,
  qtyNeed: number,
  session?: ClientSession,
): Promise<ConsumeStokBinSoftResult> {
  const need0 = Math.abs(Number(qtyNeed) || 0);
  if (!(need0 > 0) || !stokId) {
    return emptyResult(0, false);
  }

  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(warehouseKode);
  if (!isValidWarehouseKode(wh)) {
    return emptyResult(need0, true);
  }

  try {
    const rows = await db
      .collection(STOK_BIN_COLLECTION)
      .find(
        { tenantId: tid, stokId, warehouseKode: wh, qty: { $gt: 0 } },
        { projection: { binKode: 1, qty: 1 }, ...txOpts(session) },
      )
      .toArray();

    if (!rows.length) {
      return emptyResult(need0, true);
    }

    const defaultBin = await resolveDefaultBinKode(db, tid, wh);
    const sorted = [...rows].sort((a, b) => {
      const ka = String(a.binKode || '');
      const kb = String(b.binKode || '');
      if (defaultBin) {
        if (ka === defaultBin && kb !== defaultBin) return -1;
        if (kb === defaultBin && ka !== defaultBin) return 1;
      }
      return ka.localeCompare(kb);
    });

    let need = need0;
    let allocated = 0;
    const takes: Array<{ binKode: string; qty: number }> = [];

    for (const row of sorted) {
      if (need <= 0) break;
      const binKode = String(row.binKode || '');
      if (!binKode) continue;
      const available = parseFloat(String(row.qty)) || 0;
      if (available <= 0) continue;

      const take = Math.min(need, available);
      if (!(take > 0)) continue;

      const adj = await adjustStokBin(db, tid, stokId, wh, binKode, -take, session);
      if ('error' in adj && adj.error) {
        // Soft: skip this bin and continue greedy.
        continue;
      }

      allocated += take;
      need -= take;
      takes.push({ binKode, qty: take });
    }

    return {
      allocated,
      shortfall: Math.max(0, need0 - allocated),
      skippedNoBins: false,
      takes,
    };
  } catch {
    return emptyResult(need0, true);
  }
}

/**
 * Soft OUT wrapper for release / transfer / postStockMutation.
 * Swallows unexpected throws so warehouse posting never fails on bin shortfall.
 * Optional `consumeFn` is a test seam; production callers omit it.
 */
export async function softConsumeBinOnWarehouseOut(
  db: Db,
  tenantId: string,
  stokId: string,
  warehouseKode: string,
  qty: number,
  session?: ClientSession,
  consumeFn: SoftConsumeFn = consumeStokBinSoft,
): Promise<ConsumeStokBinSoftResult> {
  const need = Math.abs(Number(qty) || 0);
  try {
    return await consumeFn(db, tenantId, stokId, warehouseKode, need, session);
  } catch {
    return emptyResult(need, true);
  }
}

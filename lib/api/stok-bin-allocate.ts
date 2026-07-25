/**
 * W2-21 — Soft IN bin putaway.
 * After warehouse IN succeeds, allocate qty to the warehouse default bin.
 * Never throws; missing default bin / adjust errors do not fail the warehouse mutation.
 */

import type { ClientSession, Db } from 'mongodb';
import { adjustStokBin } from '@/lib/api/stok-bin';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import { isValidWarehouseKode, normalizeWarehouseKode } from '@/lib/api/warehouses';

export type AllocateStokBinSoftResult = {
  allocated: number;
  binKode?: string;
  skippedNoDefaultBin: boolean;
};

type SoftAllocateFn = (
  db: Db,
  tenantId: string,
  stokId: string,
  warehouseKode: string,
  qtyNeed: number,
  session?: ClientSession,
) => Promise<AllocateStokBinSoftResult>;

function emptyResult(skippedNoDefaultBin = false): AllocateStokBinSoftResult {
  return { allocated: 0, skippedNoDefaultBin };
}

/**
 * Soft-increment default bin qty for an IN.
 * `qtyNeed` is the positive amount to putaway.
 */
export async function allocateStokBinSoft(
  db: Db,
  tenantId: string,
  stokId: string,
  warehouseKode: string,
  qtyNeed: number,
  session?: ClientSession,
): Promise<AllocateStokBinSoftResult> {
  const need = Math.abs(Number(qtyNeed) || 0);
  if (!(need > 0) || !stokId) {
    return emptyResult(false);
  }

  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(warehouseKode);
  if (!isValidWarehouseKode(wh)) {
    return emptyResult(true);
  }

  const binKode = await resolveDefaultBinKode(db, tid, wh);
  if (!binKode) {
    return emptyResult(true);
  }

  const adj = await adjustStokBin(db, tid, stokId, wh, binKode, need, session);
  if ('error' in adj && adj.error) {
    return { allocated: 0, binKode, skippedNoDefaultBin: false };
  }

  return { allocated: need, binKode, skippedNoDefaultBin: false };
}

/**
 * Soft IN wrapper for transfer TO / postStockMutation.
 * Swallows unexpected throws so warehouse posting never fails on bin putaway.
 * Optional `allocateFn` is a test seam; production callers omit it.
 */
export async function softPutawayBinOnWarehouseIn(
  db: Db,
  tenantId: string,
  stokId: string,
  warehouseKode: string,
  qty: number,
  session?: ClientSession,
  allocateFn: SoftAllocateFn = allocateStokBinSoft,
): Promise<AllocateStokBinSoftResult> {
  const need = Math.abs(Number(qty) || 0);
  try {
    return await allocateFn(db, tenantId, stokId, warehouseKode, need, session);
  } catch {
    return emptyResult(true);
  }
}

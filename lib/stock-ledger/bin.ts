/**
 * W2-17 — Bin balance ledger (`stok_bin`).
 * Parallel grain to warehouse `stok_lokasi`; does not change FEFO keys.
 */

import type { ClientSession, Db, Document } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts } from '@/lib/api/transaction';
import { isValidWarehouseKode, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { isValidBinKode, normalizeBinKode } from '@/lib/api/warehouse-bins';
import { STOCK_QTY_DP, STOCK_QTY_EPS, roundStockQty } from '@/lib/stock-ledger/precision';

export const STOK_BIN_COLLECTION = 'stok_bin';

export interface StokBinDoc {
  id: string;
  tenantId: string;
  stokId: string;
  warehouseKode: string;
  binKode: string;
  qty: number;
  createdAt?: Date;
  updatedAt: Date;
}

export type StokBinAdjustResult = { qty: number } | { error: string };

function binKey(stokId: string, warehouseKode: string, binKode: string) {
  return `${stokId}:${warehouseKode}:${binKode}`;
}

export { binKey as stokBinKey };

export async function getQtyStokBin(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  warehouseKode: string | null | undefined,
  binKode: string | null | undefined,
  session?: ClientSession,
): Promise<number> {
  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(warehouseKode);
  const bin = normalizeBinKode(binKode);
  if (!isValidWarehouseKode(wh) || !isValidBinKode(bin)) return 0;
  const row = await db.collection(STOK_BIN_COLLECTION).findOne(
    { tenantId: tid, stokId, warehouseKode: wh, binKode: bin },
    txOpts(session),
  );
  return roundStockQty(row?.qty);
}

function binDeltaPipeline(
  delta: number,
  now: Date,
  ids: { id: string; tenantId: string; stokId: string; warehouseKode: string; binKode: string },
): Document[] {
  const current = { $convert: { input: { $ifNull: ['$qty', 0] }, to: 'double', onError: 0, onNull: 0 } };
  const sum = { $round: [{ $add: [current, delta] }, STOCK_QTY_DP] };
  return [{
    $set: {
      id: { $ifNull: ['$id', ids.id] },
      tenantId: ids.tenantId,
      stokId: ids.stokId,
      warehouseKode: ids.warehouseKode,
      binKode: ids.binKode,
      createdAt: { $ifNull: ['$createdAt', now] },
      qty: delta < 0 ? { $max: [0, sum] } : sum,
      updatedAt: now,
    },
  }];
}

/**
 * Atomic bin qty mutation (4 dp). Negative delta requires qty >= |delta| − toleransi.
 */
export async function adjustStokBin(
  db: Db,
  tenantId: string | null | undefined,
  stokId: string,
  warehouseKode: string | null | undefined,
  binKode: string | null | undefined,
  delta: number | string,
  session?: ClientSession,
): Promise<StokBinAdjustResult> {
  const tid = tenantId || 'default';
  const wh = normalizeWarehouseKode(warehouseKode);
  const bin = normalizeBinKode(binKode);
  if (!isValidWarehouseKode(wh)) {
    return { error: `Gudang bin tidak valid: ${warehouseKode}` };
  }
  if (!isValidBinKode(bin)) {
    return { error: `Kode bin tidak valid: ${binKode}` };
  }
  const d = roundStockQty(delta);
  if (d === 0) {
    return { qty: await getQtyStokBin(db, tid, stokId, wh, bin, session) };
  }
  const now = new Date();
  const key = { tenantId: tid, stokId, warehouseKode: wh, binKode: bin };
  const pipeline = binDeltaPipeline(d, now, { id: uuidv4(), ...key });

  if (d > 0) {
    const doc = await db.collection(STOK_BIN_COLLECTION).findOneAndUpdate(
      key,
      pipeline,
      { upsert: true, returnDocument: 'after', ...txOpts(session) },
    );
    return { qty: roundStockQty(doc?.qty) };
  }

  const need = -d;
  const doc = await db.collection(STOK_BIN_COLLECTION).findOneAndUpdate(
    { ...key, qty: { $gte: need - STOCK_QTY_EPS } },
    pipeline,
    { returnDocument: 'after', ...txOpts(session) },
  );
  if (!doc) {
    const current = await getQtyStokBin(db, tid, stokId, wh, bin, session);
    return { error: `Stok di bin ${bin}@${wh} tidak cukup (sisa: ${current})` };
  }
  return { qty: roundStockQty(doc.qty) };
}

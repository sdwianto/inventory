/**
 * W2-17 — Bin balance ledger (`stok_bin`).
 * Parallel grain to warehouse `stok_lokasi`; does not change FEFO keys.
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts } from '@/lib/api/transaction';
import { isValidWarehouseKode, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { isValidBinKode, normalizeBinKode } from '@/lib/api/warehouse-bins';

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
  return parseFloat(String(row?.qty)) || 0;
}

/**
 * Atomic bin qty mutation. Negative delta requires qty >= |delta|.
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
  const d = parseFloat(String(delta)) || 0;
  if (d === 0) {
    return { qty: await getQtyStokBin(db, tid, stokId, wh, bin, session) };
  }
  const now = new Date();

  if (d >= 0) {
    const doc = await db.collection(STOK_BIN_COLLECTION).findOneAndUpdate(
      { tenantId: tid, stokId, warehouseKode: wh, binKode: bin },
      {
        $inc: { qty: d },
        $set: { updatedAt: now },
        $setOnInsert: {
          id: uuidv4(),
          tenantId: tid,
          stokId,
          warehouseKode: wh,
          binKode: bin,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after', ...txOpts(session) },
    );
    return { qty: parseFloat(String(doc?.qty)) || 0 };
  }

  const need = -d;
  const doc = await db.collection(STOK_BIN_COLLECTION).findOneAndUpdate(
    { tenantId: tid, stokId, warehouseKode: wh, binKode: bin, qty: { $gte: need } },
    { $inc: { qty: d }, $set: { updatedAt: now } },
    { returnDocument: 'after', ...txOpts(session) },
  );
  if (!doc) {
    const current = await getQtyStokBin(db, tid, stokId, wh, bin, session);
    return { error: `Stok di bin ${bin}@${wh} tidak cukup (sisa: ${current})` };
  }
  return { qty: parseFloat(String(doc.qty)) || 0 };
}

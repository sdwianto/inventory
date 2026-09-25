// Primitive saldo stok per lokasi. Internal modul buku stok — kode di luar lib/stock-ledger
// memakai postStockMovements (mutasi) atau operasi master/perbaikan yang diekspor index.ts.

import type { ClientSession, Db, Document } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { writeProductMasterStock } from '@/lib/stock-ledger/master';
import { normalizeWarehouseKode, WAREHOUSE_CODES, isValidWarehouseKode } from '@/lib/api/warehouses';
import { txOpts } from '@/lib/api/transaction';
import { STOCK_QTY_DP, STOCK_QTY_EPS, roundStockQty } from '@/lib/stock-ledger/precision';

export const STOK_LOKASI = 'stok_lokasi';
export const STOK_KARTU = 'stok_kartu';

type LokasiRow = { qty?: number | string };

function qtyExpr() {
  return { $convert: { input: { $ifNull: ['$qty', 0] }, to: 'double', onError: 0, onNull: 0 } };
}

/** Pipeline update: qty = round(qty + delta, 4); keluar dijepit ≥ 0 (sisa dust setelah guard toleransi). */
export function lokasiDeltaPipeline(delta: number, now: Date, newId: string): Document[] {
  const sum = { $round: [{ $add: [qtyExpr(), delta] }, STOCK_QTY_DP] };
  return [{
    $set: {
      id: { $ifNull: ['$id', newId] },
      qty: delta < 0 ? { $max: [0, sum] } : sum,
      updatedAt: now,
    },
  }];
}

export type ApplyLokasiDeltaResult = { qty: number } | { error: string; current: number };

/**
 * Mutasi qty atomik. Keluar hanya diterapkan bila qty ≥ need − toleransi (guard di filter,
 * bukan cek memory), sehingga stok 0.0999… tetap bisa mengeluarkan 0.1 dan hasil tepat 0.
 */
export async function applyLokasiDelta(
  db: Db,
  tenantId: string,
  stokId: string,
  lokasiKode: string,
  delta: number,
  now: Date,
  session?: ClientSession,
): Promise<ApplyLokasiDeltaResult> {
  const d = roundStockQty(delta);
  const key = { tenantId, stokId, lokasiKode };
  if (d >= 0) {
    try {
      const doc = await db.collection(STOK_LOKASI).findOneAndUpdate(
        key,
        lokasiDeltaPipeline(d, now, uuidv4()),
        { upsert: true, returnDocument: 'after', ...txOpts(session) },
      );
      return { qty: roundStockQty((doc as LokasiRow | null)?.qty) };
    } catch (e) {
      if ((e as { code?: number })?.code !== 11000) throw e;
      const doc = await db.collection(STOK_LOKASI).findOneAndUpdate(
        key,
        lokasiDeltaPipeline(d, now, uuidv4()),
        { returnDocument: 'after', ...txOpts(session) },
      );
      if (!doc) return { error: `Stok di lokasi ${lokasiKode} bentrok saat dibuat`, current: 0 };
      return { qty: roundStockQty((doc as LokasiRow).qty) };
    }
  }
  const need = -d;
  const doc = await db.collection(STOK_LOKASI).findOneAndUpdate(
    { ...key, qty: { $gte: need - STOCK_QTY_EPS } },
    lokasiDeltaPipeline(d, now, uuidv4()),
    { returnDocument: 'after', ...txOpts(session) },
  );
  if (!doc) {
    const row = await db.collection(STOK_LOKASI).findOne(key, txOpts(session)) as LokasiRow | null;
    return { error: `Stok di lokasi ${lokasiKode} tidak cukup`, current: roundStockQty(row?.qty) };
  }
  return { qty: roundStockQty((doc as LokasiRow).qty) };
}

/** Set qty absolut (hanya untuk master produk / perbaikan data — bukan mutasi transaksi). */
export async function setLokasiQtyAbsolute(
  db: Db,
  tenantId: string,
  stokId: string,
  lokasiKode: string,
  qty: number | string,
  session?: ClientSession,
): Promise<number> {
  const next = roundStockQty(qty);
  await db.collection(STOK_LOKASI).updateOne(
    { tenantId, stokId, lokasiKode },
    { $set: { qty: next, updatedAt: new Date() }, $setOnInsert: { id: uuidv4() } },
    { upsert: true, ...txOpts(session) },
  );
  return next;
}

/** Hapus baris SKU di gudang selain gudang home (satu SKU = satu gudang). */
export async function purgeNonHomeLokasiRows(
  db: Db,
  tenantId: string,
  stokId: string,
  homeGudang: string,
  session?: ClientSession,
): Promise<void> {
  const keep = normalizeWarehouseKode(homeGudang);
  await db.collection(STOK_LOKASI).deleteMany({
    tenantId,
    stokId,
    lokasiKode: { $in: WAREHOUSE_CODES.filter((k) => k !== keep) },
  }, txOpts(session));
}

/** products.stok & stokDisplay = Σ stok_lokasi (dibulatkan), dihitung di dalam sesi yang sama. */
export async function recomputeProductStok(
  db: Db,
  tenantId: string,
  stokId: string,
  session?: ClientSession,
): Promise<number> {
  const out = await writeProductMasterStock(db, tenantId, stokId, session);
  return out.stok;
}

export type SetWarehouseStockResult = { qty: number } | { error: string };

/** Set stok SKU di gudang home secara absolut + purge gudang lain + hitung ulang master. */
export async function setHomeWarehouseQty(
  db: Db,
  tenantId: string,
  stokId: string,
  gudangKode: string,
  qty: number | string,
  session?: ClientSession,
): Promise<SetWarehouseStockResult> {
  const kode = normalizeWarehouseKode(gudangKode);
  if (!isValidWarehouseKode(kode)) return { error: 'Gudang produk tidak valid' };
  await purgeNonHomeLokasiRows(db, tenantId, stokId, kode, session);
  await setLokasiQtyAbsolute(db, tenantId, stokId, kode, qty, session);
  const total = await recomputeProductStok(db, tenantId, stokId, session);
  return { qty: total };
}

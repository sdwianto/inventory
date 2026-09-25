// Gabung saldo & riwayat stok satu produk ke item persediaan kanonik (alat gabung kode ganda).
// Hanya dipanggil dalam transaksi migrasi; satuan dasar kedua produk wajib sama (qty dipindah apa adanya).

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { applyLokasiDelta, recomputeProductStok, STOK_KARTU, STOK_LOKASI } from '@/lib/stock-ledger/balance';
import { adjustStokBin, STOK_BIN_COLLECTION } from '@/lib/stock-ledger/bin';
import { INGREDIENT_LOTS_COLLECTION } from '@/lib/food-production/ingredient-lot';
import { roundStockQty } from '@/lib/stock-ledger/precision';
import { STOCK_ALLOCATIONS_COLLECTION } from '@/lib/stock-ledger/plan-reservation';

export type MergeProductStockInput = {
  tenantId: string;
  fromId: string;
  toId: string;
  /** uomId produk lama → uomId produk kanonik dengan satuan yang sama (kartu historis). */
  uomIdMap?: Map<string, string>;
  now: Date;
};

export type MergeProductStockResult = {
  lokasiRows: number;
  binRows: number;
  kartu: number;
  lots: number;
  productionBatches: number;
  qtyMoved: number;
  stokAfter: number;
};

type LokasiRow = { lokasiKode: string; qty?: number | string; qtyReserved?: number | string };
type BinRow = { warehouseKode: string; binKode: string; qty?: number | string };

export async function mergeProductStock(
  db: Db,
  session: ClientSession | undefined,
  input: MergeProductStockInput,
): Promise<MergeProductStockResult> {
  const { tenantId, fromId, toId, now } = input;
  if (!fromId || !toId || fromId === toId) throw new Error('mergeProductStock: fromId/toId tidak valid');
  const opts = txOpts(session);

  const lokasiRows = await db.collection<LokasiRow>(STOK_LOKASI)
    .find({ tenantId, stokId: fromId }, opts)
    .project<LokasiRow>({ lokasiKode: 1, qty: 1, qtyReserved: 1 })
    .toArray();
  let qtyMoved = 0;
  // Kartu ikut pindah, jadi saldo negatif juga harus pindah agar saldo lokasi = jumlah kartu.
  const ordered = [...lokasiRows].sort((a, b) => roundStockQty(b.qty) - roundStockQty(a.qty));
  for (const row of ordered) {
    const qty = roundStockQty(row.qty);
    if (qty !== 0) {
      const res = await applyLokasiDelta(db, tenantId, toId, row.lokasiKode, qty, now, session);
      if ('error' in res) {
        throw new Error(`Saldo negatif ${qty} produk ${fromId} di ${row.lokasiKode} tidak bisa dipindah: ${res.error}`);
      }
      qtyMoved = roundStockQty(qtyMoved + qty);
    }
    const reserved = roundStockQty(row.qtyReserved);
    if (reserved > 0) {
      const res = await applyLokasiDelta(db, tenantId, toId, row.lokasiKode, 0, now, session);
      if ('error' in res) throw new Error(res.error);
      await db.collection(STOK_LOKASI).updateOne(
        { tenantId, stokId: toId, lokasiKode: row.lokasiKode },
        { $inc: { qtyReserved: reserved } },
        opts,
      );
    }
  }
  if (lokasiRows.length) await db.collection(STOK_LOKASI).deleteMany({ tenantId, stokId: fromId }, opts);

  const binRows = await db.collection<BinRow>(STOK_BIN_COLLECTION)
    .find({ tenantId, stokId: fromId }, opts)
    .project<BinRow>({ warehouseKode: 1, binKode: 1, qty: 1 })
    .toArray();
  for (const row of binRows) {
    const qty = roundStockQty(row.qty);
    if (qty <= 0) continue;
    const res = await adjustStokBin(db, tenantId, toId, row.warehouseKode, row.binKode, qty, session);
    if ('error' in res) throw new Error(res.error);
  }
  if (binRows.length) await db.collection(STOK_BIN_COLLECTION).deleteMany({ tenantId, stokId: fromId }, opts);

  // sourceId/lineRef kartu tidak diubah: kunci idempotensi posting tetap milik dokumen sumber.
  for (const [oldUom, newUom] of input.uomIdMap || []) {
    if (!oldUom || !newUom || oldUom === newUom) continue;
    await db.collection(STOK_KARTU).updateMany(
      { tenantId, stokId: fromId, uomId: oldUom },
      { $set: { uomId: newUom } },
      opts,
    );
  }
  const kartu = await db.collection(STOK_KARTU).updateMany(
    { tenantId, stokId: fromId },
    { $set: { stokId: toId, mergedFromStokId: fromId } },
    opts,
  );
  const lots = await db.collection(INGREDIENT_LOTS_COLLECTION).updateMany(
    { tenantId, productId: fromId },
    { $set: { productId: toId, mergedFromProductId: fromId, updatedAt: now } },
    opts,
  );
  // Cadangan rencana ikut lot-nya; tanpa ini guard stok tidak melihat cadangan di produk kanonik.
  await db.collection(STOCK_ALLOCATIONS_COLLECTION).updateMany(
    { tenantId, productId: fromId },
    { $set: { productId: toId, mergedFromProductId: fromId, updatedAt: now } },
    opts,
  );
  const batches = await db.collection('production_batches').updateMany(
    { tenantId, finishedGoodProductId: fromId },
    { $set: { finishedGoodProductId: toId, mergedFromProductId: fromId, updatedAt: now } },
    opts,
  );

  await recomputeProductStok(db, tenantId, fromId, session);
  const stokAfter = await recomputeProductStok(db, tenantId, toId, session);
  return {
    lokasiRows: lokasiRows.length,
    binRows: binRows.length,
    kartu: kartu.modifiedCount,
    lots: lots.modifiedCount,
    productionBatches: batches.modifiedCount,
    qtyMoved,
    stokAfter,
  };
}

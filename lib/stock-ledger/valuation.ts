// Nilai persediaan buku stok pada rata-rata bergerak: Σ qty positif per gudang × products.avgCost
// (fallback hargaBeli bila avgCost belum ada). Barang memo (hasil produksi) tidak bernilai persediaan.

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { STOK_LOKASI } from '@/lib/stock-ledger/balance';
import { isMemoCostItem } from '@/lib/stock-ledger/cost';
import { roundMoney, roundStockQty, roundUnitCost } from '@/lib/stock-ledger/precision';

export type InventoryValuationRow = {
  productId: string;
  kode?: string;
  nama?: string;
  qty: number;
  unitCost: number;
  costBasis: 'AVG' | 'HARGA_BELI' | 'NONE';
  value: number;
};

export type InventoryValuation = {
  value: number;
  rows: InventoryValuationRow[];
  /** Produk ber-qty positif tanpa harga sama sekali (nilai 0). */
  missingCost: number;
  memoSkipped: number;
};

type ProductCostRow = {
  id: string;
  kode?: string;
  nama?: string;
  itemRole?: string;
  avgCost?: number | string | null;
  hargaBeli?: number | string | null;
};

export async function valueInventoryAtAvg(db: Db, tenantId: string, session?: ClientSession): Promise<InventoryValuation> {
  const opts = txOpts(session);
  const qtyRows = await db.collection(STOK_LOKASI).aggregate<{ _id: string; qty: number }>([
    { $match: { tenantId, qty: { $gt: 0 } } },
    { $group: { _id: '$stokId', qty: { $sum: '$qty' } } },
  ], opts).toArray();
  const ids = qtyRows.map((r) => String(r._id));
  const products = ids.length
    ? await db.collection<ProductCostRow>('products')
      .find({ tenantId, id: { $in: ids } }, opts)
      .project<ProductCostRow>({ id: 1, kode: 1, nama: 1, itemRole: 1, avgCost: 1, hargaBeli: 1 })
      .toArray()
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));

  const rows: InventoryValuationRow[] = [];
  let value = 0;
  let missingCost = 0;
  let memoSkipped = 0;
  for (const r of qtyRows) {
    const productId = String(r._id);
    const p = byId.get(productId);
    if (p && isMemoCostItem({ itemRole: p.itemRole })) {
      memoSkipped += 1;
      continue;
    }
    const qty = roundStockQty(r.qty);
    if (qty <= 0) continue;
    const avg = roundUnitCost(p?.avgCost);
    const harga = roundUnitCost(p?.hargaBeli);
    const unitCost = avg > 0 ? avg : harga;
    const costBasis = avg > 0 ? 'AVG' : harga > 0 ? 'HARGA_BELI' : 'NONE';
    if (costBasis === 'NONE') missingCost += 1;
    const rowValue = roundMoney(qty * unitCost);
    value += rowValue;
    rows.push({ productId, kode: p?.kode, nama: p?.nama, qty, unitCost, costBasis, value: rowValue });
  }
  return { value: roundMoney(value), rows, missingCost, memoSkipped };
}
